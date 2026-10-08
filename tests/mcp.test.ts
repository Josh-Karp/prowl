import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connectMCPServer } from "../src/mcp/client.js";
import { configureLogger, logger } from "../src/logger.js";

for (const verbose of [false, true]) {
  test(`MCP subprocess diagnostics reach the file (verbose: ${verbose})`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "prowl-mcp-"));
    const filePath = join(directory, "agent.log");
    configureLogger({ filePath, verbose });
    t.after(() => {
      configureLogger();
      rmSync(directory, { recursive: true, force: true });
    });
    let stdout = "",
      stderr = "";
    const write = process.stdout.write.bind(process.stdout);
    t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
      // The isolated Node test runner sends binary events over stdout.
      if (typeof chunk !== "string") return write(chunk);
      stdout += chunk;
      return true;
    });
    t.mock.method(process.stderr, "write", (chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
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
    assert.equal(stderr, "");
    if (verbose) assert.match(stdout, /MCP startup diagnostic/);
    else assert.equal(stdout, "");
  });
}
