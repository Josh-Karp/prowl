import assert from "node:assert/strict";
import test from "node:test";
import { resolveContextOptions } from "../src/agent/context-options.js";
import { runAction } from "../src/actions/runAction.js";

test("automatic defaults scale with num_ctx and CLI takes precedence over environment", () => {
  const env = {
    PROWL_CONTEXT_MODE: "full",
    PROWL_HISTORY_BYTES: "9000",
    OLLAMA_NUM_CTX: "4096",
  };
  assert.deepEqual(resolveContextOptions({}, {}), {
    mode: "auto",
    historyBytes: 32768,
    numCtx: 16384,
  });
  assert.deepEqual(resolveContextOptions({}, { OLLAMA_NUM_CTX: "4096" }), {
    mode: "auto",
    historyBytes: 8192,
    numCtx: 4096,
  });
  assert.deepEqual(
    resolveContextOptions({ contextMode: "auto", historyBytes: "7000" }, env),
    { mode: "auto", historyBytes: 7000, numCtx: 4096 },
  );
  assert.deepEqual(resolveContextOptions({}, env), {
    mode: "full",
    historyBytes: 9000,
    numCtx: 4096,
  });
});

test("invalid context settings reject before opening Playwright", async () => {
  await assert.rejects(runAction({ contextMode: "broken" }), /context-mode/);
  await assert.rejects(runAction({ historyBytes: "0" }), /history-bytes/);
  for (const value of ["", "-1", "no", "1.5"])
    assert.throws(
      () => resolveContextOptions({ historyBytes: value }, {}),
      /history-bytes/,
    );
  assert.throws(
    () => resolveContextOptions({}, { OLLAMA_NUM_CTX: "0" }),
    /OLLAMA_NUM_CTX/,
  );
});
