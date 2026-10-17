// Test-only entry point. It starts the same server as the shipped program, but allows pages on
// private addresses, because the tests serve their pages from this computer.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, createAltTextServer } from "../dist/server.js";

const config = { ...configFromEnv(), allowPrivateUrls: true };
await createAltTextServer(config).connect(new StdioServerTransport());
