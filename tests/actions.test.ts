import assert from "node:assert/strict";
import test from "node:test";
import { runAction } from "#actions/runAction.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configureLogger } from "#logger.js";

test("invalid form options are rejected before connecting Playwright", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "prowl-actions-"));
  const logFile = join(directory, "agent.log");
  t.after(() => {
    configureLogger();
    rmSync(directory, { recursive: true, force: true });
  });
  await assert.rejects(
    runAction({ url: "file:///tmp/form.html", logFile }),
    /HTTP or HTTPS/,
  );
  await assert.rejects(
    runAction({ runs: "0", logFile }),
    /runs must be a positive integer/,
  );
  await assert.rejects(
    runAction({ maxIterations: "invalid", logFile }),
    /maxIterations must be a positive integer/,
  );
});

test("invalid context settings are rejected before connecting Playwright", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "prowl-context-options-"));
  t.after(() => {
    configureLogger();
    rmSync(directory, { recursive: true, force: true });
  });
  const logFile = join(directory, "agent.log");
  await assert.rejects(
    runAction({ contextMode: "invalid", logFile }),
    /context-mode/,
  );
  await assert.rejects(
    runAction({ historyBytes: "0", logFile }),
    /history-bytes/,
  );
});
