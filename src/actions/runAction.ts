import type { RunActionOptions } from "#actions/options.js";

import { connectPlaywright } from "#mcp/playwright.js";
import { runForms } from "#forms/runs.js";
import { configureLogger, logger } from "#logger.js";
import { resolveContextOptions } from "#agent/context/options.js";
import { resolveRunActionOptions } from "#actions/options.js";

export async function runAction(options: RunActionOptions) {
  configureLogger({ filePath: options.logFile, verbose: options.verbose });
  const { url, runs, maxIterations } = resolveRunActionOptions(options);
  const context = resolveContextOptions(options);

  logger.info(`Logs: ${logger.filePath}\nConnecting to Playwright...`, {
    console: true,
  });

  const { client } = await connectPlaywright();
  try {
    await runForms(client, {
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
