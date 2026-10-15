import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelOptions } from "#models/options.js";
import { resolveContextOptions } from "#agent/context/options.js";

test("model defaults and empty environment fallbacks match standalone requests", () => {
  for (const env of [{}, { OLLAMA_MODEL: "", OLLAMA_BASE_URL: "" }]) {
    assert.deepEqual(resolveModelOptions({}, env), {
      model: "gemma4:12b",
      baseUrl: "http://localhost:11434",
      numCtx: 16384,
      timeoutMs: 120000,
    });
  }
});

test("model environment settings and explicit overrides retain their precedence", () => {
  const env = {
    OLLAMA_MODEL: "environment-model",
    OLLAMA_BASE_URL: "http://environment:11434/",
    OLLAMA_NUM_CTX: "4096",
    OLLAMA_TIMEOUT_MS: "5000",
  };
  assert.deepEqual(resolveModelOptions({}, env), {
    model: "environment-model",
    baseUrl: "http://environment:11434/",
    numCtx: 4096,
    timeoutMs: 5000,
  });
  assert.deepEqual(
    resolveModelOptions(
      {
        model: "explicit",
        baseUrl: "http://explicit",
        numCtx: 8192,
        timeoutMs: 2000,
      },
      env,
    ),
    {
      model: "explicit",
      baseUrl: "http://explicit",
      numCtx: 8192,
      timeoutMs: 2000,
    },
  );
  assert.equal(resolveModelOptions({ model: "", baseUrl: "" }, env).model, "");
  assert.equal(
    resolveModelOptions({ model: "", baseUrl: "" }, env).baseUrl,
    "",
  );
});

test("model settings reject invalid windows and deadlines while accepting their bounds", () => {
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
    assert.throws(
      () => resolveModelOptions({}, { OLLAMA_NUM_CTX: value }),
      /OLLAMA_NUM_CTX must be a positive integer/,
    );
    assert.throws(
      () => resolveModelOptions({}, { OLLAMA_TIMEOUT_MS: value }),
      /OLLAMA_TIMEOUT_MS must be a positive integer no greater than 2147483647/,
    );
  }
  assert.throws(
    () => resolveModelOptions({}, { OLLAMA_TIMEOUT_MS: "2147483648" }),
    /OLLAMA_TIMEOUT_MS/,
  );
  for (const value of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => resolveModelOptions({ numCtx: value }, {}),
      /OLLAMA_NUM_CTX/,
    );
    assert.throws(
      () => resolveModelOptions({ timeoutMs: value }, {}),
      /OLLAMA_TIMEOUT_MS/,
    );
  }
  assert.equal(
    resolveModelOptions({ numCtx: Number.MAX_SAFE_INTEGER }, {}).numCtx,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    resolveModelOptions({ timeoutMs: 2147483647 }, {}).timeoutMs,
    2147483647,
  );
  assert.equal(resolveModelOptions({ numCtx: 1, timeoutMs: 1 }, {}).numCtx, 1);
});

test("context-only resolution validates its window without resolving unrelated model timeouts", () => {
  assert.deepEqual(
    resolveContextOptions(
      {},
      { OLLAMA_NUM_CTX: "4096", OLLAMA_TIMEOUT_MS: "invalid" },
    ),
    {
      mode: "auto",
      historyBytes: 8192,
      numCtx: 4096,
    },
  );
});
