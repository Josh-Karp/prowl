import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createRequire } from "node:module";
import { logger, reportError } from "../logger.js";

const { version } = createRequire(import.meta.url)("../../package.json");

export async function connectMCPServer(command: string, args: string[]) {
  const client = new Client({
    name: "prowl-mcp-client",
    version,
  });

  const transport = new StdioClientTransport({
    command,
    args,
    stderr: "pipe",
  });

  transport.stderr?.on("data", (chunk: Buffer) => {
    try {
      logger.debug("MCP server stderr", { data: chunk.toString() });
    } catch (error) {
      reportError(error);
      process.exitCode = 1;
      void client.close().catch(reportError);
    }
  });

  try {
    await client.connect(transport);
  } catch (error) {
    await client.close();
    throw error;
  }

  return { client };
}
