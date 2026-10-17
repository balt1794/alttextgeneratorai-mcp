#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, realpath, stat } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import net from "node:net";
import path from "node:path";

const VERSION = "1.0.1";
const DEFAULT_API_BASE = "https://alttextgeneratorai.com/api";
const API_BASE = (process.env.ALTTEXTGENERATORAI_API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, "");
const API_KEY = (process.env.ALTTEXTGENERATORAI_API_KEY || "").trim();
const GET_KEY_URL = "https://alttextgeneratorai.com/dashboard";
// For tests only: lets audit_page read pages on private addresses
const ALLOW_PRIVATE_URLS = process.env.ALTTEXTGENERATORAI_ALLOW_PRIVATE_URLS === "1";
// Optional: only allow files inside this folder in generate_alt_text_from_file
const ALLOWED_DIR = process.env.ALTTEXTGENERATORAI_ALLOWED_DIR ? path.resolve(process.env.ALTTEXTGENERATORAI_ALLOWED_DIR) : "";

// The API key is sent to this address, so it must be secure (https), or a local test server
function checkApiBase() {
  if (API_BASE === DEFAULT_API_BASE) return;
  let parsed: URL;
  try {
    parsed = new URL(API_BASE);
  } catch {
    throw new Error("ALTTEXTGENERATORAI_API_BASE_URL is not a valid address.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new Error("ALTTEXTGENERATORAI_API_BASE_URL must use https (http is only allowed for localhost).");
  }
  console.error(`alttextgeneratorai-mcp: using a custom API address (${parsed.origin}). Your API key will be sent there.`);
}
checkApiBase();

const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

// Short, safe description of a network error (no raw error text)
function reason(error: unknown): string {
  const inner = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = inner?.code || inner?.message?.match(/\b(E[A-Z]{4,})\b/)?.[1];
  const name = (error as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError" || code === "ETIMEDOUT") return "it took too long to respond";
  if (code === "ENOTFOUND") return "the address was not found";
  if (code === "ECONNREFUSED") return "the connection was refused";
  if (code === "ECONNRESET") return "the connection was closed";
  return "a network error occurred";
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function needKey(): ToolResult | null {
  if (API_KEY) return null;
  return fail(
    `No API key found. Set the ALTTEXTGENERATORAI_API_KEY environment variable in your MCP client settings. Get a free key at ${GET_KEY_URL}.`
  );
}

type Generated = { ok: true; altText: string } | { ok: false; message: string };

async function requestAltText(image: { url: string } | { data: string; mime: string }, language: string): Promise<Generated> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: API_KEY, language, image }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    return { ok: false, message: `Could not reach AltTextGeneratorAI (${reason(error)}). Check the internet connection.` };
  }

  if (response.status === 401) {
    return { ok: false, message: `Invalid API key or no credits left. Check your key and credits at ${GET_KEY_URL}.` };
  }
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    /* the message below covers it */
  }
  if (!response.ok) {
    const why = typeof body?.error === "string" ? body.error.slice(0, 120) : `status ${response.status}`;
    return { ok: false, message: `Alt text could not be generated: ${why}.` };
  }
  if (!body?.alt_text) return { ok: false, message: "The service returned no alt text." };
  return { ok: true, altText: String(body.alt_text) };
}

// Checks the first bytes, so only real images are read, whatever the file is called
function looksLikeImage(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes.toString("latin1", 1, 4) === "PNG";
  const gif = bytes.toString("latin1", 0, 4) === "GIF8";
  const webp = bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP";
  return jpeg || png || gif || webp;
}

const server = new McpServer({ name: "alttextgeneratorai", version: VERSION });

const languageField = z
  .string()
  .optional()
  .describe("Language of the alt text, in English, for example spanish, french, german or japanese. Defaults to english. 130+ languages are supported.");

server.registerTool(
  "generate_alt_text",
  {
    title: "Generate alt text from an image URL",
    description:
      "Writes SEO-friendly, accessible alt text for one image that is available at a public http(s) URL. Uses 1 credit from the AltTextGeneratorAI account.",
    inputSchema: {
      image_url: z.string().url().describe("Public address of the image (http or https)."),
      language: languageField,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ image_url, language }): Promise<ToolResult> => {
    const missing = needKey();
    if (missing) return missing;
    const result = await requestAltText({ url: image_url }, (language || "english").toLowerCase());
    return result.ok ? ok(result.altText) : fail(result.message);
  }
);

server.registerTool(
  "generate_alt_text_from_file",
  {
    title: "Generate alt text from a local image file",
    description:
      "Writes SEO-friendly, accessible alt text for an image file on this computer (JPEG, PNG, GIF or WebP, up to 3 MB). Uses 1 credit from the AltTextGeneratorAI account.",
    inputSchema: {
      file_path: z.string().describe("Path of the image file on this computer."),
      language: languageField,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ file_path, language }): Promise<ToolResult> => {
    const missing = needKey();
    if (missing) return missing;
    const mime = MIME_BY_EXTENSION[path.extname(file_path).toLowerCase()];
    if (!mime) return fail("Only JPEG, PNG, GIF and WebP files are supported.");
    let real: string;
    let size: number;
    try {
      real = await realpath(file_path);
      size = (await stat(real)).size;
    } catch {
      return fail("The file was not found.");
    }
    if (ALLOWED_DIR) {
      let allowed = ALLOWED_DIR;
      try {
        allowed = await realpath(ALLOWED_DIR);
      } catch {
        /* the folder does not exist, so nothing is inside it */
      }
      if (real !== allowed && !real.startsWith(allowed + path.sep)) {
        return fail("That file is outside the folder this server is allowed to read.");
      }
    }
    if (size > MAX_FILE_BYTES) {
      return fail(`The file is ${(size / 1024 / 1024).toFixed(1)} MB. Use an image under 3 MB.`);
    }
    const bytes = await readFile(real);
    if (!looksLikeImage(bytes)) return fail("That file is not a JPEG, PNG, GIF or WebP image.");
    const data = bytes.toString("base64");
    const result = await requestAltText({ data, mime }, (language || "english").toLowerCase());
    return result.ok ? ok(result.altText) : fail(result.message);
  }
);

server.registerTool(
  "check_credits",
  {
    title: "Check remaining credits",
    description: "Shows how many credits are left on the AltTextGeneratorAI account. Each generated alt text uses 1 credit.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (): Promise<ToolResult> => {
    const missing = needKey();
    if (missing) return missing;
    try {
      const response = await fetch(`${API_BASE}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: API_KEY }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 404) return fail(`That API key was not found. Check it at ${GET_KEY_URL}.`);
      if (!response.ok) return fail(`The credits could not be checked (status ${response.status}).`);
      const body: any = await response.json();
      const credits = Number(body.freeRewritesLeft);
      if (Number.isNaN(credits)) return fail("The credits could not be read from the response.");
      return ok(`${credits} credit${credits === 1 ? "" : "s"} left. Buy more at ${GET_KEY_URL}.`);
    } catch (error) {
      return fail(`Could not reach AltTextGeneratorAI (${reason(error)}). Check the internet connection.`);
    }
  }
);

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("fc") || v.startsWith("fd")) return true;
    if (v.startsWith("::ffff:")) {
      const tail = v.slice(7);
      return net.isIPv4(tail) ? isPrivateAddress(tail) : true;
    }
    return false;
  }
  return true;
}

// audit_page only reads public web pages: no localhost, home networks or cloud metadata addresses
async function assertPublicUrl(rawUrl: string): Promise<void> {
  const parsed = new URL(rawUrl);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("The page address must start with http:// or https://");
  if (ALLOW_PRIVATE_URLS) return;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const blocked = new Error("For safety, only public web pages can be scanned, not local or private network addresses.");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw blocked;
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) throw blocked;
}

async function fetchPublicPage(startUrl: string): Promise<Response> {
  let current = startUrl;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(current);
    const response = await fetch(current, {
      headers: { "User-Agent": `alttextgeneratorai-mcp/${VERSION} (+https://alttextgeneratorai.com)`, Accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error("The page redirected too many times.");
}

type FoundImage = { src: string; status: "missing" | "empty" };

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? "";
}

function hasAttribute(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(\\s*=|\\s|>|/)`, "i").test(tag);
}

function findImages(html: string, pageUrl: string): { found: FoundImage[]; total: number; withAlt: number } {
  const tags = html.match(/<img\b[^>]*>/gi) ?? [];
  const found: FoundImage[] = [];
  const seen = new Set<string>();
  let total = 0;
  let withAlt = 0;
  for (const tag of tags) {
    let src = attribute(tag, "src") || attribute(tag, "data-src") || attribute(tag, "data-lazy-src");
    if (!src) {
      const srcset = attribute(tag, "srcset");
      if (srcset) src = srcset.split(",")[0].trim().split(/\s+/)[0];
    }
    if (!src || src.startsWith("data:")) continue;
    let absolute: string;
    try {
      absolute = new URL(src, pageUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(absolute)) continue;
    // Skip tracking pixels
    const width = attribute(tag, "width");
    const height = attribute(tag, "height");
    if ((width && Number(width) <= 2) || (height && Number(height) <= 2)) continue;

    total++;
    if (!hasAttribute(tag, "alt")) {
      if (!seen.has(absolute)) found.push({ src: absolute, status: "missing" });
      seen.add(absolute);
    } else if ((attribute(tag, "alt") ?? "").trim() === "") {
      if (!seen.has(absolute)) found.push({ src: absolute, status: "empty" });
      seen.add(absolute);
    } else {
      withAlt++;
    }
  }
  return { found, total, withAlt };
}

server.registerTool(
  "audit_page",
  {
    title: "Find images without alt text on a web page",
    description:
      "Reads a public web page and lists the images that have no alt attribute (missing) or an empty one (empty, which is correct for purely decorative images). This is free by default. Set generate to true to also write suggested alt text for the images found, which uses 1 credit per image.",
    inputSchema: {
      url: z.string().url().describe("Address of the web page (http or https)."),
      generate: z.boolean().optional().describe("Also write suggested alt text for the images found. Uses 1 credit per image. Default false."),
      max_images: z.number().int().min(1).max(25).optional().describe("With generate, the most images to write alt text for. Default 5, maximum 25."),
      language: languageField,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ url, generate, max_images, language }): Promise<ToolResult> => {
    if (!/^https?:\/\//i.test(url)) return fail("The page address must start with http:// or https://");

    let html: string;
    try {
      const response = await fetchPublicPage(url);
      if (!response.ok) return fail(`The page could not be loaded (status ${response.status}).`);
      const type = response.headers.get("content-type") || "";
      if (type && !/html|xml/i.test(type)) return fail(`That address is not a web page (${type}).`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_PAGE_BYTES) return fail("The page is too large to scan (over 3 MB).");
      html = buffer.toString("utf8");
    } catch (error) {
      const message = (error as Error).message || "";
      if (message.startsWith("For safety") || message.startsWith("The page redirected") || message.startsWith("The page address")) return fail(message);
      return fail(`The page could not be loaded (${reason(error)}).`);
    }

    const { found, total, withAlt } = findImages(html, url);
    const summary: Record<string, unknown> = {
      page: url,
      images_checked: total,
      with_alt_text: withAlt,
      missing_alt_attribute: found.filter((image) => image.status === "missing").length,
      empty_alt_attribute: found.filter((image) => image.status === "empty").length,
      note: "Images with an empty alt are correct when they are purely decorative. Pages that load images with JavaScript may show fewer images.",
    };

    if (!generate) {
      return ok(JSON.stringify({ ...summary, images: found }, null, 2));
    }

    const missing = needKey();
    if (missing) return missing;
    const limit = max_images ?? 5;
    const targets = found.slice(0, limit);
    const lang = (language || "english").toLowerCase();
    const results: { src: string; status: string; suggested_alt?: string; error?: string }[] = [];
    const queue = [...targets];
    const worker = async () => {
      while (queue.length) {
        const image = queue.shift() as FoundImage;
        const generated = await requestAltText({ url: image.src }, lang);
        results.push(
          generated.ok
            ? { src: image.src, status: image.status, suggested_alt: generated.altText }
            : { src: image.src, status: image.status, error: generated.message }
        );
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const order = new Map(targets.map((image, index) => [image.src, index]));
    results.sort((a, b) => (order.get(a.src) ?? 0) - (order.get(b.src) ?? 0));
    const credits_used = results.filter((entry) => entry.suggested_alt).length;
    return ok(
      JSON.stringify(
        {
          ...summary,
          credits_used,
          not_generated_because_of_limit: Math.max(0, found.length - targets.length),
          images: results,
        },
        null,
        2
      )
    );
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`alttextgeneratorai-mcp ${VERSION} is running${API_KEY ? "" : " (no API key set)"}`);
}

main().catch((error) => {
  console.error("alttextgeneratorai-mcp failed to start:", error);
  process.exit(1);
});
