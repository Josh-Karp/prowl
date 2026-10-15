import assert from "node:assert/strict";
import test from "node:test";
import { resolveContextOptions } from "#agent/context/options.js";

test("context defaults use automatic mode and a 32768-byte history budget", () => {
  assert.deepEqual(resolveContextOptions({}, {}), {
    mode: "auto",
    historyBytes: 32768,
    numCtx: 16384,
  });
});

test("the default history budget scales with the configured model context", () => {
  assert.deepEqual(resolveContextOptions({}, { OLLAMA_NUM_CTX: "4096" }), {
    mode: "auto",
    historyBytes: 8192,
    numCtx: 4096,
  });
});

test("environment variables supply context mode and history budget", () => {
  assert.deepEqual(
    resolveContextOptions(
      {},
      {
        PROWL_CONTEXT_MODE: "full",
        PROWL_HISTORY_BYTES: "9000",
        OLLAMA_NUM_CTX: "4096",
      },
    ),
    { mode: "full", historyBytes: 9000, numCtx: 4096 },
  );
});

test("explicit context options take precedence over environment values", () => {
  assert.deepEqual(
    resolveContextOptions(
      { contextMode: "auto", historyBytes: "7000" },
      {
        PROWL_CONTEXT_MODE: "full",
        PROWL_HISTORY_BYTES: "9000",
        OLLAMA_NUM_CTX: "4096",
      },
    ),
    { mode: "auto", historyBytes: 7000, numCtx: 4096 },
  );
  assert.deepEqual(
    resolveContextOptions(
      { contextMode: "full", historyBytes: 7000 },
      {
        PROWL_CONTEXT_MODE: "invalid",
        PROWL_HISTORY_BYTES: "0",
      },
    ),
    { mode: "full", historyBytes: 7000, numCtx: 16384 },
  );
});

test("history budgets accept positive safe integer strings and numbers", () => {
  for (const historyBytes of [1, "1", 9000, "9000", Number.MAX_SAFE_INTEGER]) {
    assert.equal(
      resolveContextOptions({ historyBytes }, {}).historyBytes,
      Number(historyBytes),
    );
  }
});

test("context modes reject unsupported values from options or environment", () => {
  for (const contextMode of ["", "broken", "AUTO", "auto "]) {
    assert.throws(
      () => resolveContextOptions({ contextMode }, {}),
      /context-mode must be auto or full/,
    );
    assert.throws(
      () => resolveContextOptions({}, { PROWL_CONTEXT_MODE: contextMode }),
      /context-mode must be auto or full/,
    );
  }
});

test("model context must be a positive safe integer even in full mode", () => {
  for (const numCtx of [
    "",
    " ",
    "0",
    "-1",
    "1.5",
    "invalid",
    "NaN",
    "Infinity",
    "9007199254740992",
  ]) {
    for (const contextMode of ["auto", "full"]) {
      assert.throws(
        () =>
          resolveContextOptions(
            { contextMode, historyBytes: 1000 },
            { OLLAMA_NUM_CTX: numCtx },
          ),
        /OLLAMA_NUM_CTX must be a positive integer/,
      );
    }
  }
});

test("history budgets reject nonpositive fractional and unsafe values in either mode", () => {
  for (const value of [
    "",
    " ",
    "0",
    "-1",
    "1.5",
    "invalid",
    "NaN",
    "Infinity",
    "9007199254740992",
  ]) {
    for (const contextMode of ["auto", "full"]) {
      assert.throws(
        () => resolveContextOptions({ contextMode, historyBytes: value }, {}),
        /history-bytes must be a positive integer/,
      );
      assert.throws(
        () =>
          resolveContextOptions(
            { contextMode },
            { PROWL_HISTORY_BYTES: value },
          ),
        /history-bytes must be a positive integer/,
      );
    }
  }
  for (const historyBytes of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => resolveContextOptions({ historyBytes }, {}),
      /history-bytes must be a positive integer/,
    );
  }
});

test("an unsafe default budget is rejected while an explicit safe budget remains valid", () => {
  const env = { OLLAMA_NUM_CTX: "9007199254740991" };
  assert.throws(
    () => resolveContextOptions({}, env),
    /history-bytes must be a positive integer/,
  );
  assert.deepEqual(resolveContextOptions({ historyBytes: 1000 }, env), {
    mode: "auto",
    historyBytes: 1000,
    numCtx: Number.MAX_SAFE_INTEGER,
  });
});
