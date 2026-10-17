#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const VERSION = "1.0.0";
const API_BASE = (process.env.ALTTEXTGENERATORAI_API_BASE_URL || "https://alttextgeneratorai.com/api").replace(/\/$/, "");
const API_KEY = (process.env.ALTTEXTGENERATORAI_API_KEY || "").trim();
const GET_KEY_URL = "https://alttextgeneratorai.com/dashboard";

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
    return { ok: false, message: `Could not reach AltTextGeneratorAI. Check the internet connection. (${(error as Error).message})` };
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
    const reason = body?.error ? `${body.error}` : `status ${response.status}`;
    return { ok: false, message: `Alt text could not be generated: ${reason}.` };
  }
  if (!body?.alt_text) return { ok: false, message: "The service returned no alt text." };
  return { ok: true, altText: String(body.alt_text) };
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
    let size: number;
    try {
      size = (await stat(file_path)).size;
    } catch {
      return fail(`The file was not found: ${file_path}`);
    }
    if (size > MAX_FILE_BYTES) {
      return fail(`The file is ${(size / 1024 / 1024).toFixed(1)} MB. Use an image under 3 MB.`);
    }
    const data = (await readFile(file_path)).toString("base64");
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
      return fail(`Could not reach AltTextGeneratorAI. Check the internet connection. (${(error as Error).message})`);
    }
  }
);

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
      const response = await fetch(url, {
        headers: { "User-Agent": `alttextgeneratorai-mcp/${VERSION} (+https://alttextgeneratorai.com)`, Accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return fail(`The page could not be loaded (status ${response.status}).`);
      const type = response.headers.get("content-type") || "";
      if (type && !/html|xml/i.test(type)) return fail(`That address is not a web page (${type}).`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_PAGE_BYTES) return fail("The page is too large to scan (over 3 MB).");
      html = buffer.toString("utf8");
    } catch (error) {
      return fail(`The page could not be loaded. (${(error as Error).message})`);
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
