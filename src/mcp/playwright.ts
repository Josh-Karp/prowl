import { connectMCPServer } from "#mcp/client.js";

export async function connectPlaywright() {
  return connectMCPServer("npx", ["@playwright/mcp@latest"]);
}
