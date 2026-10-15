import assert from "node:assert/strict";
import test from "node:test";
import { run } from "#actions/runAction.js";
import { join } from "node:path";
import { configureLogger } from "#logger.js";
import { temporaryDirectory } from "#tests/helpers.js";

test("invalid form options are rejected before connecting Playwright", async (t) => {
  const directory = temporaryDirectory(t, "prowl-actions-");
  const logFile = join(directory, "agent.log");
  t.after(() => configureLogger());
  await assert.rejects(
    run({ url: "file:///tmp/form.html", logFile }),
    /HTTP or HTTPS/,
  );
  await assert.rejects(
    run({ runs: "0", logFile }),
    /runs must be a positive integer/,
  );
  await assert.rejects(
    run({ maxIterations: "invalid", logFile }),
    /maxIterations must be a positive integer/,
  );
});

test("invalid context settings are rejected before connecting Playwright", async (t) => {
  const directory = temporaryDirectory(t, "prowl-context-options-");
  t.after(() => configureLogger());
  const logFile = join(directory, "agent.log");
  await assert.rejects(
    run({ contextMode: "invalid", logFile }),
    /context-mode/,
  );
  await assert.rejects(run({ historyBytes: "0", logFile }), /history-bytes/);
});
