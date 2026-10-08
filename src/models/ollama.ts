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

interface OllamaResponse {
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

export async function chat(
  messages: OllamaMessage[],
  tools?: OllamaTool[],
  model: string = process.env.OLLAMA_MODEL || "gemma4:12b",
  baseUrl: string = process.env.OLLAMA_BASE_URL || "http://localhost:11434",
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

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/chat`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: false,
      options: { num_ctx: numCtx },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status}`, {
      cause: await response.text(),
    });
  }

  const data = (await response.json()) as OllamaResponse;
  return data.message;
}
