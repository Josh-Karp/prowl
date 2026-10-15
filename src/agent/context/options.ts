import { resolveNumCtx } from "#models/options.js";

export interface ContextOptions {
  contextMode?: string;
  historyBytes?: string | number;
}

export interface ResolvedContextOptions {
  mode: "auto" | "full";
  historyBytes: number;
  numCtx: number;
}

export function resolveContextOptions(
  options: ContextOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedContextOptions {
  const mode = options.contextMode ?? env.PROWL_CONTEXT_MODE ?? "auto";
  if (mode !== "auto" && mode !== "full")
    throw new Error("context-mode must be auto or full.");

  const numCtx = resolveNumCtx(env.OLLAMA_NUM_CTX);

  const historyBytes = Number(
    options.historyBytes ?? env.PROWL_HISTORY_BYTES ?? numCtx * 2,
  );
  if (!Number.isSafeInteger(historyBytes) || historyBytes <= 0)
    throw new Error("history-bytes must be a positive integer.");

  return { mode, historyBytes, numCtx };
}
