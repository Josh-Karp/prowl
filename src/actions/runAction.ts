import type { RunActionOptions } from "#actions/options.js";

import { connectPlaywright } from "#mcp/playwright.js";
import { runBatch } from "#forms/runs.js";
import { configureLogger, logger } from "#logger.js";
import { resolveContextOptions } from "#agent/context/options.js";
import { resolveRunOptions } from "#actions/options.js";

export async function run(options: RunActionOptions) {
  configureLogger({ filePath: options.logFile, verbose: options.verbose });

  const { url, runs, maxIterations } = resolveRunOptions(options);
  const context = resolveContextOptions(options);

  logger.info(`Logs: ${logger.filePath}\nConnecting to Playwright...`, {
    console: true,
  });

  const { client } = await connectPlaywright();
  try {
    await runBatch(client, {
      url,
      runs,
      instructions: options.instructions,
      model: options.model,
      baseUrl: options.baseUrl,
      maxIterations,
      context,
    });
  } finally {
    await client.close();
  }
}
