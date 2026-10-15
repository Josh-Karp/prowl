import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { connectMCPServer } from "#mcp/client.js";
import { configureLogger, logger } from "#logger.js";
import { temporaryDirectory, captureOutput } from "#tests/helpers.js";

for (const verbose of [false, true]) {
  test(`MCP subprocess diagnostics reach the file (verbose: ${verbose})`, async (t) => {
    const directory = temporaryDirectory(t, "prowl-mcp-");
    const filePath = join(directory, "agent.log");
    configureLogger({ filePath, verbose });
    t.after(() => configureLogger());
    const output = captureOutput(t);
    await assert.rejects(
      connectMCPServer(process.execPath, [
        "-e",
        'process.stderr.write("MCP startup diagnostic\\n"); setTimeout(() => process.exit(1), 20);',
      ]),
    );
    assert.match(
      readFileSync(logger.filePath, "utf8"),
      /MCP startup diagnostic/,
    );
    assert.equal(output.stderr, "");
    if (verbose) assert.match(output.stdout, /MCP startup diagnostic/);
    else assert.equal(output.stdout, "");
  });
}
