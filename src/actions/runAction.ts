import {
  resolveContextOptions,
  type ContextOptions,
} from "../agent/context-options.js";
import { connectPlaywright } from "../mcp/playwright.js";
import { runAgent } from "../agent/loop.js";
import { formTask } from "../agent/prompts.js";
import { configureLogger, logger } from "../logger.js";

interface RunActionOptions extends ContextOptions {
  url?: string;
  runs?: string | number;
  model?: string;
  baseUrl?: string;
  maxIterations?: string | number;
  instructions?: string;
  verbose?: boolean;
  logFile?: string;
}

function _validateOptions(options: RunActionOptions) {
  const url = options.url ?? "http://localhost:5173";
  if (!["http:", "https:"].includes(new URL(url).protocol)) {
    throw new Error("Form URL must use HTTP or HTTPS.");
  }
  const runs = Number(options.runs ?? 1);
  const maxIterations = Number(
    options.maxIterations ?? process.env.MAX_ITERATIONS ?? 30,
  );
  for (const [name, value] of Object.entries({ runs, maxIterations })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
  const context = resolveContextOptions(options);
  return { url, runs, maxIterations, context };
}

export async function runAction(options: RunActionOptions) {
  configureLogger({ filePath: options.logFile, verbose: options.verbose });
  const { url, runs, maxIterations, context } = _validateOptions(options);
  const task = formTask(url, runs, options.instructions);

  logger.info(`Logs: ${logger.filePath}\nConnecting to Playwright...`, {
    console: true,
  });
  const { client } = await connectPlaywright();
  try {
    await runAgent(
      client,
      task,
      options.model,
      options.baseUrl,
      maxIterations,
      { contextMode: context.mode, historyBytes: context.historyBytes },
    );
  } finally {
    await client.close();
  }
}
