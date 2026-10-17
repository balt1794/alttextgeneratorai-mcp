#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION, configFromEnv, createAltTextServer } from "./server.js";

async function main() {
  const config = configFromEnv();
  const server = createAltTextServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`alttextgeneratorai-mcp ${VERSION} is running${config.apiKey ? "" : " (no API key set)"}`);
}

main().catch((error) => {
  console.error("alttextgeneratorai-mcp failed to start:", (error as Error).message);
  process.exit(1);
});
