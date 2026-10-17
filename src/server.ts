import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BLOCKED_MESSAGE, TOO_LARGE_MESSAGE, fetchPublicPage } from "./netguard.js";

export const VERSION = "1.0.2";
const DEFAULT_API_BASE = "https://alttextgeneratorai.com/api";
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

export type Config = {
  apiKey: string;
  apiBase: string;
  // generate_alt_text_from_file only reads image files inside these folders
  allowedDirs: string[];
  // Only the tests turn this on. The shipped program never does.
  allowPrivateUrls: boolean;
};

export function configFromEnv(): Config {
  const apiBase = (process.env.ALTTEXTGENERATORAI_API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, "");
  // The API key is sent to this address, so it must be secure (https), or a local test server
  if (apiBase !== DEFAULT_API_BASE) {
    let parsed: URL;
    try {
      parsed = new URL(apiBase);
    } catch {
      throw new Error("ALTTEXTGENERATORAI_API_BASE_URL is not a valid address.");
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
      throw new Error("ALTTEXTGENERATORAI_API_BASE_URL must use https (http is only allowed for localhost).");
    }
    console.error(`alttextgeneratorai-mcp: using a custom API address (${parsed.origin}). Your API key will be sent there.`);
  }
  const custom = process.env.ALTTEXTGENERATORAI_ALLOWED_DIR;
  const allowedDirs = custom
    ? custom.split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir))
    : [os.homedir(), os.tmpdir()];
  return {
    apiKey: (process.env.ALTTEXTGENERATORAI_API_KEY || "").trim(),
    apiBase,
    allowedDirs,
    allowPrivateUrls: false,
  };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// Short, safe description of a network error (no raw error text)
function reason(error: unknown): string {
  const inner = (error as { cause?: { code?: string; message?: string }; code?: string })?.cause;
  const code = inner?.code || (error as { code?: string })?.code || inner?.message?.match(/\b(E[A-Z]{4,})\b/)?.[1];
  const name = (error as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError" || code === "ETIMEDOUT") return "it took too long to respond";
  if (code === "ENOTFOUND") return "the address was not found";
  if (code === "ECONNREFUSED") return "the connection was refused";
  if (code === "ECONNRESET") return "the connection was closed";
  return "a network error occurred";
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

export function createAltTextServer(config: Config): McpServer {
  const { apiKey, apiBase, allowedDirs, allowPrivateUrls } = config;
  const server = new McpServer({ name: "alttextgeneratorai", version: VERSION });

  function needKey(): ToolResult | null {
    if (apiKey) return null;
    return fail(
      `No API key found. Set the ALTTEXTGENERATORAI_API_KEY environment variable in your MCP client settings. Get a free key at ${GET_KEY_URL}.`
    );
  }

  type Generated = { ok: true; altText: string } | { ok: false; message: string };

  async function requestAltText(image: { url: string } | { data: string; mime: string }, language: string): Promise<Generated> {
    let response: Response;
    try {
      response = await fetch(`${apiBase}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, language, image }),
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

  const languageField = z
    .string()
    .optional()
    .describe("Language of the alt text, in English, for example spanish, french, german or japanese. Defaults to english. 130+ languages are supported.");

  server.registerTool(
    "generate_alt_text",
    {
      title: "Generate alt text from an image URL",
      description:
        "Writes SEO-friendly, accessible alt text for one image that is available at a public http(s) URL. The image address is sent to the AltTextGeneratorAI service, which downloads the image. Uses 1 credit.",
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
        "Writes SEO-friendly, accessible alt text for an image file on this computer (JPEG, PNG, GIF or WebP, up to 3 MB). The file is sent to the AltTextGeneratorAI service. Only image files inside the user's home folder or the temp folder are read, unless the user chose other folders with ALTTEXTGENERATORAI_ALLOWED_DIR. Uses 1 credit.",
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
      let inside = false;
      for (const dir of allowedDirs) {
        let allowed = dir;
        try {
          allowed = await realpath(dir);
        } catch {
          continue; // the folder does not exist, so nothing is inside it
        }
        if (real === allowed || real.startsWith(allowed + path.sep)) {
          inside = true;
          break;
        }
      }
      if (!inside) {
        return fail(
          "That file is outside the folders this server may read (your home folder and the temp folder). The user can allow another folder with the ALTTEXTGENERATORAI_ALLOWED_DIR setting."
        );
      }
      if (size > MAX_FILE_BYTES) {
        return fail(`The file is ${(size / 1024 / 1024).toFixed(1)} MB. Use an image under 3 MB.`);
      }
      const bytes = await readFile(real);
      if (!looksLikeImage(bytes)) return fail("That file is not a JPEG, PNG, GIF or WebP image.");
      const result = await requestAltText({ data: bytes.toString("base64"), mime }, (language || "english").toLowerCase());
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
        const response = await fetch(`${apiBase}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey }),
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

  server.registerTool(
    "audit_page",
    {
      title: "Find images without alt text on a web page",
      description:
        "Reads a public web page and lists the images that have no alt attribute (missing) or an empty one (empty, which is correct for purely decorative images). Local and private network addresses are refused. This is free by default. Set generate to true to also write suggested alt text for the images found: the image addresses are sent to the AltTextGeneratorAI service, which downloads them, and it uses 1 credit per image.",
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
        const response = await fetchPublicPage(url, allowPrivateUrls, `alttextgeneratorai-mcp/${VERSION} (+https://alttextgeneratorai.com)`, MAX_PAGE_BYTES);
        if (response.status < 200 || response.status >= 300) return fail(`The page could not be loaded (status ${response.status}).`);
        const type = String(response.headers["content-type"] || "");
        if (type && !/html|xml/i.test(type)) return fail(`That address is not a web page (${type}).`);
        html = response.body.toString("utf8");
      } catch (error) {
        const message = (error as Error).message || "";
        if ([BLOCKED_MESSAGE, TOO_LARGE_MESSAGE].includes(message) || message.startsWith("The page redirected") || message.startsWith("The page address")) {
          return fail(message);
        }
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

  return server;
}
