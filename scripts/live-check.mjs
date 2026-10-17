// Tries the published package the way an AI assistant would, with your real API key.
// Usage (the key stays in your own terminal):
//   ALTTEXTGENERATORAI_API_KEY=your_key node scripts/live-check.mjs
// Uses 1 credit.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.env.ALTTEXTGENERATORAI_API_KEY) {
  console.error("Set ALTTEXTGENERATORAI_API_KEY first, for example:\n  ALTTEXTGENERATORAI_API_KEY=your_key node scripts/live-check.mjs");
  process.exit(1);
}

const transport = new StdioClientTransport({ command: "npx", args: ["-y", "alttextgeneratorai-mcp@latest"], env: process.env, stderr: "ignore" });
const client = new Client({ name: "live-check", version: "1.0.0" });
await client.connect(transport);
console.log(`Connected to alttextgeneratorai-mcp ${client.getServerVersion().version}\n`);

async function run(label, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((part) => part.text).join("\n");
  console.log(`${result.isError ? "FAILED" : "OK    "}  ${label}\n        ${text.split("\n").slice(0, 6).join("\n        ")}\n`);
  return !result.isError;
}

const results = [];
results.push(await run("check_credits", "check_credits", {}));
results.push(await run("audit_page (free)", "audit_page", { url: "https://example.com/" }));
results.push(await run("generate_alt_text (uses 1 credit)", "generate_alt_text", { image_url: "https://alttextgeneratorai.com/icon-512.png" }));
results.push(await run("check_credits again (should be 1 lower)", "check_credits", {}));
await client.close();
console.log(results.every(Boolean) ? "All good." : "Something failed, see above.");
process.exit(results.every(Boolean) ? 0 : 1);
