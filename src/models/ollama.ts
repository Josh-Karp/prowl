import type { Tool } from "@modelcontextprotocol/client";
import type { ResolvedModelOptions } from "#models/options.js";

import { logger } from "#logger.js";
import { resolveModelOptions } from "#models/options.js";

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

export interface OllamaMetrics extends Pick<
  OllamaCompletionMetadata,
  | "prompt_eval_count"
  | "prompt_eval_cached_count"
  | "prompt_eval_duration"
  | "eval_count"
  | "eval_duration"
  | "total_duration"
  | "load_duration"
> {
  kind: "inference";
  numCtx: number;
  messagesBytes: number;
  toolsBytes: number;
  requestBytes: number;
}

interface OllamaResponse extends OllamaCompletionMetadata {
  message: OllamaMessage & { role: "assistant" };
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
  model?: string,
  baseUrl?: string,
  onMetrics?: (metrics: OllamaMetrics) => void,
  configuration?: ResolvedModelOptions,
): Promise<OllamaResponse["message"]> {
  const settings = configuration ?? resolveModelOptions({ model, baseUrl });
  const { numCtx, timeoutMs } = settings;

  const body = JSON.stringify({
    model: settings.model,
    messages,
    tools,
    stream: false,
    options: { num_ctx: numCtx },
  });

  const response = await fetch(
    `${settings.baseUrl.replace(/\/+$/, "")}/api/chat`,
    {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Content-Type": "application/json",
      },
      body,
    },
  );

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
