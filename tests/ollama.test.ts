import assert from "node:assert/strict";
import test from "node:test";
import { chat } from "../src/models/ollama.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});

test("requests enough context for browser tasks and supports OLLAMA_NUM_CTX", async () => {
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

test("a stalled model request is aborted by the configured deadline", async () => {
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
    process.env.OLLAMA_TIMEOUT_MS = "0";
    await assert.rejects(chat([]), /OLLAMA_TIMEOUT_MS/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTimeout === undefined) delete process.env.OLLAMA_TIMEOUT_MS;
    else process.env.OLLAMA_TIMEOUT_MS = originalTimeout;
  }
});
