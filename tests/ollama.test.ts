import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { chat } from "../src/models/ollama.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogger, logger, reportError } from "../src/logger.js";

test("HTTP failure details stay in the file while the console reports only the status", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "prowl-http-error-"));
  const filePath = join(directory, "agent.log");
  configureLogger({ filePath });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    configureLogger();
    rmSync(directory, { recursive: true, force: true });
  });
  let stderr = "";
  t.mock.method(process.stderr, "write", (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  const body = "Detailed backend diagnostic\n" + "payload".repeat(100);
  globalThis.fetch = async () => new Response(body, { status: 500 });
  await chat([]).catch(reportError);
  assert.equal(stderr, "[error] Ollama request failed: 500\n");
  const record = JSON.parse(readFileSync(logger.filePath, "utf8").trim());
  assert.equal(record.data.cause, body);
  assert.notEqual(record.message, "Ollama completion metadata");
});

test("requests enough context for browser tasks and supports OLLAMA_NUM_CTX", async (t) => {
  isolatedLog(t);
  const originalFetch = globalThis.fetch;
  const originalContext = process.env.OLLAMA_NUM_CTX;
  let request: { options?: { num_ctx?: number } };
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options!.body as string);
    return new Response(
      JSON.stringify({ message: { role: "assistant", content: "Done" } }),
    );
  };
  try {
    delete process.env.OLLAMA_NUM_CTX;
    await chat([]);
    assert.equal(request!.options?.num_ctx, 16384);
    process.env.OLLAMA_NUM_CTX = "32768";
    await chat([]);
    assert.equal(request!.options?.num_ctx, 32768);
    for (const value of ["0", "-1", "1.5", "invalid", ""]) {
      process.env.OLLAMA_NUM_CTX = value;
      await assert.rejects(
        chat([]),
        /OLLAMA_NUM_CTX must be a positive integer/,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalContext === undefined) delete process.env.OLLAMA_NUM_CTX;
    else process.env.OLLAMA_NUM_CTX = originalContext;
  }
});

test("a stalled model request is aborted by the configured deadline", async (t) => {
  const path = isolatedLog(t);
  const originalFetch = globalThis.fetch;
  const originalTimeout = process.env.OLLAMA_TIMEOUT_MS;
  process.env.OLLAMA_TIMEOUT_MS = "10";
  globalThis.fetch = async (_url, options) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          resolve(
            new Response(
              JSON.stringify({
                message: { role: "assistant", content: "late" },
              }),
            ),
          ),
        100,
      );
      const abort = () => {
        clearTimeout(timer);
        reject(options?.signal?.reason);
      };
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
    });
  try {
    await assert.rejects(chat([]), /timed out|timeout/i);
    assert.equal(existsSync(path), false);
    process.env.OLLAMA_TIMEOUT_MS = "0";
    await assert.rejects(chat([]), /OLLAMA_TIMEOUT_MS/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTimeout === undefined) delete process.env.OLLAMA_TIMEOUT_MS;
    else process.env.OLLAMA_TIMEOUT_MS = originalTimeout;
  }
});

function isolatedLog(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "prowl-ollama-metadata-"));
  configureLogger({ filePath: join(directory, "agent.log") });
  t.after(() => {
    configureLogger();
    rmSync(directory, { recursive: true, force: true });
  });
  return logger.filePath;
}

const metadataCases = [
  {
    name: "logs Ollama completion metadata while returning only the message",
    message: { role: "assistant", content: "Done" },
    metadata: {
      model: "fixture-model",
      created_at: "2026-10-12T20:13:03.655Z",
      done: true,
      done_reason: "stop",
      prompt_eval_count: 120,
      prompt_eval_cached_count: 80,
      eval_count: 25,
      total_duration: 900000000,
      load_duration: 100000000,
      prompt_eval_duration: 300000000,
      eval_duration: 500000000,
    },
  },
  {
    name: "preserves false zero and unknown completion reasons",
    message: { role: "assistant", content: "" },
    metadata: {
      done: false,
      done_reason: "future-reason",
      prompt_eval_count: 0,
      prompt_eval_cached_count: 0,
      eval_count: 0,
      total_duration: 0,
      load_duration: 0,
      prompt_eval_duration: 0,
      eval_duration: 0,
    },
  },
  {
    name: "accepts responses without completion metadata",
    message: { role: "assistant", content: "Done" },
    metadata: {},
  },
  {
    name: "logs completion metadata for thinking-only responses",
    message: { role: "assistant", content: "", thinking: "Need to continue" },
    metadata: { done: true, done_reason: "stop" },
  },
];

for (const { name, message, metadata } of metadataCases) {
  test(name, async (t) => {
    const path = isolatedLog(t);
    let output = "";
    for (const stream of [process.stdout, process.stderr]) {
      t.mock.method(stream, "write", (chunk: unknown) => {
        if (typeof chunk === "string") output += chunk;
        return true;
      });
    }
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            ...metadata,
            message,
            unknown_field: "must not leak",
            logprobs: [{ token: "Done", logprob: -0.1 }],
          }),
        ),
    );

    assert.deepEqual(await chat([]), message);
    assert.equal(output, "");
    assert.ok(
      existsSync(path),
      "successful responses must write completion metadata",
    );
    const records = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].level, "debug");
    assert.equal(records[0].message, "Ollama completion metadata");
    assert.deepEqual(records[0].data, metadata);
  });
}
