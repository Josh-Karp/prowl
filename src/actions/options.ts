import type { ContextOptions } from "#agent/context/options.js";

export interface RunOptions extends ContextOptions {
  url?: string;
  runs?: string | number;
  model?: string;
  baseUrl?: string;
  maxIterations?: string | number;
  instructions?: string;
  verbose?: boolean;
  logFile?: string;
}

export interface ResolvedRunOptions {
  url: string;
  runs: number;
  maxIterations: number;
}

export function resolveRunOptions(
  options: RunOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRunOptions {
  const url = options.url ?? "http://localhost:5173";
  if (!["http:", "https:"].includes(new URL(url).protocol)) {
    throw new Error("Form URL must use HTTP or HTTPS.");
  }
  const runs = Number(options.runs ?? 1);
  const maxIterations = Number(
    options.maxIterations ?? env.MAX_ITERATIONS ?? 30,
  );
  for (const [name, value] of Object.entries({ runs, maxIterations })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
  return { url, runs, maxIterations };
}
