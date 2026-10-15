export interface ResolvedModelOptions {
  model: string;
  baseUrl: string;
  numCtx: number;
  timeoutMs: number;
}

export type ModelOptions = Partial<ResolvedModelOptions>;

export function resolveNumCtx(value: string | number | undefined): number {
  const numCtx = Number(value ?? 16384);
  if (!Number.isSafeInteger(numCtx) || numCtx <= 0)
    throw new Error("OLLAMA_NUM_CTX must be a positive integer.");
  return numCtx;
}

export function resolveModelOptions(
  options: ModelOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedModelOptions {
  const numCtx = resolveNumCtx(options.numCtx ?? env.OLLAMA_NUM_CTX);
  const timeoutMs = Number(
    options.timeoutMs ?? env.OLLAMA_TIMEOUT_MS ?? 120000,
  );
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2147483647
  ) {
    throw new Error(
      "OLLAMA_TIMEOUT_MS must be a positive integer no greater than 2147483647.",
    );
  }
  return {
    model: options.model ?? (env.OLLAMA_MODEL || "gemma4:12b"),
    baseUrl:
      options.baseUrl ?? (env.OLLAMA_BASE_URL || "http://localhost:11434"),
    numCtx,
    timeoutMs,
  };
}
