#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { runAction } from "./actions/runAction.js";
import { reportError } from "./logger.js";

const program = new Command();

program
  .name("prowl")
  .description("Local AI browser testing agent")
  .option(
    "--model <name>",
    "Ollama model (defaults to OLLAMA_MODEL or gemma4:12b)",
  )
  .option(
    "--base-url <url>",
    "Ollama base URL (defaults to OLLAMA_BASE_URL or http://localhost:11434)",
  )
  .option(
    "--max-iterations <count>",
    "Agent iteration limit (defaults to MAX_ITERATIONS or 30)",
  )
  .option("--verbose", "Print detailed logs to the console")
  .option(
    "--log-file <path>",
    "Log base filename; each run uses a unique folder (defaults to LOG_FILE or logs/prowl.log)",
  );

program
  .command("run")
  .description("Fill and submit a form using the browser tools")
  .argument(
    "[url]",
    "Full form URL, including any query parameters",
    "http://localhost:5173",
  )
  .option("--runs <count>", "Number of varied submissions", "1")
  .option("--instructions <text>", "Additional form instructions")
  .action((url: string, _options, command: Command) =>
    runAction({ ...command.optsWithGlobals(), url }),
  );

await program.parseAsync().catch((error) => {
  reportError(error);
  process.exitCode = 1;
});
