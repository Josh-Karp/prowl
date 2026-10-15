import type { Tool } from "@modelcontextprotocol/client";

import { logger } from "#logger.js";

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_name?: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
}

export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaCompletionMetadata {
  model?: string;
  created_at?: string;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

export interface OllamaMetrics {
  kind: "inference";
  numCtx: number;
  messagesBytes: number;
  toolsBytes: number;
  requestBytes: number;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  total_duration?: number;
  load_duration?: number;
}

interface OllamaResponse extends OllamaCompletionMetadata {
  message: {
    role: "assistant";
    content: string;
    thinking?: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, unknown>;
      };
    }>;
  };
}

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

export async function chat(
  messages: OllamaMessage[],
  tools?: OllamaTool[],
  model: string = process.env.OLLAMA_MODEL || "gemma4:12b",
  baseUrl: string = process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  onMetrics?: (metrics: OllamaMetrics) => void,
): Promise<OllamaResponse["message"]> {
  const numCtx = Number(process.env.OLLAMA_NUM_CTX ?? 16384);
  if (!Number.isSafeInteger(numCtx) || numCtx <= 0) {
    throw new Error("OLLAMA_NUM_CTX must be a positive integer.");
  }
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2147483647
  ) {
    throw new Error(
      "OLLAMA_TIMEOUT_MS must be a positive integer no greater than 2147483647.",
    );
  }

  const body = JSON.stringify({
    model,
    messages,
    tools,
    stream: false,
    options: { num_ctx: numCtx },
  });

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/chat`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status}`, {
      cause: await response.text(),
    });
  }

  const data = (await response.json()) as OllamaResponse;

  logger.debug("Ollama completion metadata", {
    data: {
      model: data.model,
      created_at: data.created_at,
      done: data.done,
      done_reason: data.done_reason,
      prompt_eval_count: data.prompt_eval_count,
      prompt_eval_cached_count: data.prompt_eval_cached_count,
      eval_count: data.eval_count,
      total_duration: data.total_duration,
      load_duration: data.load_duration,
      prompt_eval_duration: data.prompt_eval_duration,
      eval_duration: data.eval_duration,
    },
  });

  const metrics: OllamaMetrics = {
    kind: "inference",
    numCtx,
    messagesBytes: Buffer.byteLength(JSON.stringify(messages)),
    toolsBytes: Buffer.byteLength(JSON.stringify(tools ?? [])),
    requestBytes: Buffer.byteLength(body),
  };

  for (const key of [
    "prompt_eval_count",
    "prompt_eval_cached_count",
    "prompt_eval_duration",
    "eval_count",
    "eval_duration",
    "total_duration",
    "load_duration",
  ] as const) {
    const value = data[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      metrics[key] = value;
  }

  logger.debug("Context event", { data: { schemaVersion: 1, ...metrics } });
  onMetrics?.(metrics);
  return data.message;
}
