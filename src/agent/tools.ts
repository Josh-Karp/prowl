import type { Tool } from "@modelcontextprotocol/client";
import type { OllamaTool } from "../models/ollama.js";

export function mcpToolsToOllamaTools(tools: Tool[]): OllamaTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: (tool.inputSchema as Record<string, unknown>) ?? {
        type: "object",
      },
    },
  }));
}
