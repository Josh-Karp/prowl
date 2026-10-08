import { connectMCPServer } from "./client.js";

export async function connectPlaywright() {
  return connectMCPServer("npx", ["@playwright/mcp@latest"]);
}
