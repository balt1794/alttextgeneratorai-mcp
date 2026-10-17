// End-to-end test: starts the built server over stdio, connects as an MCP client and
// calls every tool against a small fake copy of the AltTextGeneratorAI API.
import assert from "node:assert/strict";
import http from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "dist", "index.js");

const PAGE = `<!doctype html><html><body>
<img src="/a.jpg" alt="A dog on a beach">
<img src="/b.jpg">
<img src="/c.jpg" alt="">
<img data-src="/lazy.webp" class="lazy">
<img src="/pixel.gif" width="1" height="1">
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
<img src='https://cdn.example.com/d.png' alt='   '>
<img src="/b.jpg">
</body></html>`;

const requests = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/page.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(PAGE);
    }
    if (req.method === "GET" && req.url === "/notes.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("hello");
    }
    if (req.method === "POST") {
      const data = JSON.parse(body || "{}");
      requests.push({ url: req.url, data });
      if (req.url === "/api/verify") {
        if (data.apiKey !== "test-key") {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ message: "User not found" }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ freeRewritesLeft: 7 }));
      }
      if (req.url === "/api/mcp") {
        if (data.apiKey !== "test-key") {
          res.writeHead(401);
          return res.end("Verify API key for credits left");
        }
        if (data.image?.url?.includes("bad")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Image not accessible" }));
        }
        const what = data.image?.url ? data.image.url : `uploaded file (${data.image?.mime})`;
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ alt_text: `Mock alt [${data.language}] for ${what}` }));
      }
    }
    res.writeHead(404);
    res.end();
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function connect(apiKey, extra = {}) {
  const env = { ...process.env, ALTTEXTGENERATORAI_API_BASE_URL: `${base}/api`, ALTTEXTGENERATORAI_ALLOW_PRIVATE_URLS: "1", ...extra };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  if (apiKey) env.ALTTEXTGENERATORAI_API_KEY = apiKey;
  else delete env.ALTTEXTGENERATORAI_API_KEY;
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "ignore" });
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const text = (result) => result.content.map((part) => part.text).join("\n");
let passed = 0;
function check(name, fn) {
  return Promise.resolve(fn()).then(
    () => {
      passed++;
      console.log("  ok   " + name);
    },
    (error) => {
      console.error("  FAIL " + name + "\n       " + (error?.message || error));
      process.exitCode = 1;
    }
  );
}

const client = await connect("test-key");

await check("lists the 4 tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["audit_page", "check_credits", "generate_alt_text", "generate_alt_text_from_file"]);
  for (const tool of tools) assert.ok(tool.description && tool.description.length > 20, tool.name + " needs a description");
});

await check("generate_alt_text returns the text", async () => {
  const r = await client.callTool({ name: "generate_alt_text", arguments: { image_url: "https://example.com/cat.jpg", language: "Spanish" } });
  assert.ok(!r.isError);
  assert.equal(text(r), "Mock alt [spanish] for https://example.com/cat.jpg");
});

await check("generate_alt_text defaults to english", async () => {
  const r = await client.callTool({ name: "generate_alt_text", arguments: { image_url: "https://example.com/cat.jpg" } });
  assert.equal(text(r), "Mock alt [english] for https://example.com/cat.jpg");
});

await check("generate_alt_text reports a service error", async () => {
  const r = await client.callTool({ name: "generate_alt_text", arguments: { image_url: "https://example.com/bad.jpg" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /Image not accessible/);
});

const dir = mkdtempSync(path.join(tmpdir(), "altmcp-"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
writeFileSync(path.join(dir, "pic.png"), png);
writeFileSync(path.join(dir, "notes.txt"), "x");
writeFileSync(path.join(dir, "big.jpg"), Buffer.alloc(3 * 1024 * 1024 + 10));

await check("generate_alt_text_from_file sends the file", async () => {
  const r = await client.callTool({ name: "generate_alt_text_from_file", arguments: { file_path: path.join(dir, "pic.png") } });
  assert.ok(!r.isError, text(r));
  assert.equal(text(r), "Mock alt [english] for uploaded file (image/png)");
  const sent = requests.filter((q) => q.url === "/api/mcp").pop();
  assert.equal(sent.data.image.data, png.toString("base64"));
});

await check("from_file rejects other file types", async () => {
  const r = await client.callTool({ name: "generate_alt_text_from_file", arguments: { file_path: path.join(dir, "notes.txt") } });
  assert.equal(r.isError, true);
  assert.match(text(r), /JPEG, PNG, GIF and WebP/);
});

await check("from_file rejects files over 3 MB", async () => {
  const r = await client.callTool({ name: "generate_alt_text_from_file", arguments: { file_path: path.join(dir, "big.jpg") } });
  assert.equal(r.isError, true);
  assert.match(text(r), /under 3 MB/);
});

await check("from_file reports a missing file", async () => {
  const r = await client.callTool({ name: "generate_alt_text_from_file", arguments: { file_path: path.join(dir, "nope.png") } });
  assert.equal(r.isError, true);
  assert.match(text(r), /not found/);
});

await check("check_credits shows the balance", async () => {
  const r = await client.callTool({ name: "check_credits", arguments: {} });
  assert.ok(!r.isError);
  assert.match(text(r), /^7 credits left/);
});

await check("audit_page finds the images without alt text (free)", async () => {
  const before = requests.filter((q) => q.url === "/api/mcp").length;
  const r = await client.callTool({ name: "audit_page", arguments: { url: `${base}/page.html` } });
  assert.ok(!r.isError, text(r));
  const out = JSON.parse(text(r));
  assert.equal(out.images_checked, 6); // a, b, c, lazy, d and the repeated b (pixel and data: image skipped)
  assert.equal(out.with_alt_text, 1);
  assert.equal(out.missing_alt_attribute, 2); // b.jpg (once) and the lazy image
  assert.equal(out.empty_alt_attribute, 2); // c.jpg and the whitespace alt
  const srcs = out.images.map((image) => image.src);
  assert.ok(srcs.includes(`${base}/b.jpg`));
  assert.ok(srcs.includes(`${base}/lazy.webp`));
  assert.ok(srcs.includes("https://cdn.example.com/d.png"));
  assert.ok(!srcs.includes(`${base}/a.jpg`) && !srcs.includes(`${base}/pixel.gif`));
  assert.equal(requests.filter((q) => q.url === "/api/mcp").length, before, "no credits should be used");
});

await check("audit_page with generate writes suggestions and respects max_images", async () => {
  const r = await client.callTool({ name: "audit_page", arguments: { url: `${base}/page.html`, generate: true, max_images: 2, language: "French" } });
  assert.ok(!r.isError, text(r));
  const out = JSON.parse(text(r));
  assert.equal(out.credits_used, 2);
  assert.equal(out.not_generated_because_of_limit, 2);
  assert.equal(out.images.length, 2);
  assert.match(out.images[0].suggested_alt, /^Mock alt \[french\]/);
});

await check("audit_page rejects a page that is not HTML", async () => {
  const r = await client.callTool({ name: "audit_page", arguments: { url: `${base}/notes.txt` } });
  assert.equal(r.isError, true);
  assert.match(text(r), /not a web page/);
});

await check("audit_page reports an unreachable page", async () => {
  const closed = await new Promise((resolve) => {
    const probe = http.createServer().listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
  const r = await client.callTool({ name: "audit_page", arguments: { url: `http://127.0.0.1:${closed}/none.html` } });
  assert.equal(r.isError, true);
  assert.match(text(r), /could not be loaded \(the connection was refused\)/);
  assert.ok(!/ECONN|at |Error:/.test(text(r)), "no raw error text");
});

await client.close();

// ---- safety checks ----
const strict = await connect("test-key", { ALTTEXTGENERATORAI_ALLOW_PRIVATE_URLS: undefined });
await check("audit_page refuses local and private addresses", async () => {
  for (const url of [`${base}/page.html`, "http://localhost:3000/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://10.0.0.5/", "http://192.168.1.1/", "http://[::ffff:127.0.0.1]/", "http://printer.local/"]) {
    const r = await strict.callTool({ name: "audit_page", arguments: { url } });
    assert.equal(r.isError, true, url + " should be refused");
    assert.match(text(r), /only public web pages can be scanned/, url);
  }
});
await strict.close();

writeFileSync(path.join(dir, "fake.png"), "this is not an image, it is a text file pretending to be one");
const sub = path.join(dir, "allowed");
import("node:fs").then(() => {});
const { mkdirSync, copyFileSync } = await import("node:fs");
mkdirSync(sub);
copyFileSync(path.join(dir, "pic.png"), path.join(sub, "inside.png"));
const fenced = await connect("test-key", { ALTTEXTGENERATORAI_ALLOWED_DIR: sub });
await check("a text file renamed .png is not read", async () => {
  const r = await fenced.callTool({ name: "generate_alt_text_from_file", arguments: { file_path: path.join(dir, "fake.png") } });
  assert.equal(r.isError, true);
});
await check("with an allowed folder, only files inside it are read", async () => {
  const outside = await fenced.callTool({ name: "generate_alt_text_from_file", arguments: { file_path: path.join(dir, "pic.png") } });
  assert.equal(outside.isError, true);
  assert.match(text(outside), /outside the folder/);
  const inside = await fenced.callTool({ name: "generate_alt_text_from_file", arguments: { file_path: path.join(sub, "inside.png") } });
  assert.ok(!inside.isError, text(inside));
  const sneaky = await fenced.callTool({ name: "generate_alt_text_from_file", arguments: { file_path: path.join(sub, "..", "pic.png") } });
  assert.equal(sneaky.isError, true);
});
await fenced.close();

await check("a custom API address must be https (or localhost)", async () => {
  await assert.rejects(() => connect("test-key", { ALTTEXTGENERATORAI_API_BASE_URL: "http://example.com/api" }));
  await assert.rejects(() => connect("test-key", { ALTTEXTGENERATORAI_API_BASE_URL: "not a url" }));
});

const wrong = await connect("wrong-key");
await check("a wrong API key gives a clear message", async () => {
  const r = await wrong.callTool({ name: "generate_alt_text", arguments: { image_url: "https://example.com/x.jpg" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /Invalid API key or no credits left/);
  const c = await wrong.callTool({ name: "check_credits", arguments: {} });
  assert.equal(c.isError, true);
  assert.match(text(c), /not found/);
});
await wrong.close();

const keyless = await connect("");
await check("without a key the tools explain how to get one, and audit still works", async () => {
  const g = await keyless.callTool({ name: "generate_alt_text", arguments: { image_url: "https://example.com/x.jpg" } });
  assert.equal(g.isError, true);
  assert.match(text(g), /ALTTEXTGENERATORAI_API_KEY/);
  const a = await keyless.callTool({ name: "audit_page", arguments: { url: `${base}/page.html` } });
  assert.ok(!a.isError);
  const withGenerate = await keyless.callTool({ name: "audit_page", arguments: { url: `${base}/page.html`, generate: true } });
  assert.equal(withGenerate.isError, true);
});
await keyless.close();

server.close();
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures above)" : ""}`);
