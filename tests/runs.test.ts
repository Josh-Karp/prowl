import type { TestContext } from "node:test";
import type { OllamaMessage } from "#models/ollama.js";

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runBatch } from "#forms/runs.js";
import { configureLogger, logger } from "#logger.js";

const toolCall = (name = "browser_snapshot") => ({
  content: "",
  tool_calls: [{ function: { name, arguments: {} } }],
});

const confirmed = (reference: string) => ({
  content: JSON.stringify({
    status: "confirmed",
    summary: `Registered customer ${reference}`,
    evidence: `Registered successfully. Reference ID: ${reference}`,
    reference,
  }),
});

function fixture(t: TestContext, replies: Partial<OllamaMessage>[]) {
  const directory = mkdtempSync(join(tmpdir(), "prowl-runs-"));
  configureLogger({ filePath: join(directory, "agent.log") });
  const path = logger.filePath;
  t.after(() => {
    configureLogger();
    rmSync(directory, { recursive: true, force: true });
  });
  let output = "";
  for (const stream of [process.stdout, process.stderr]) {
    t.mock.method(stream, "write", (chunk: unknown) => {
      output += String(chunk);
      return true;
    });
  }
  const requests: Array<{ messages: OllamaMessage[] }> = [];
  const executed: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body as string));
    const reply = replies[requests.length - 1];
    assert.ok(reply, "Unexpected extra model request");
    return new Response(
      JSON.stringify({
        message: { role: "assistant", ...reply },
        // Force history compaction inside each run to exercise reset isolation.
        prompt_eval_count: 15000,
      }),
    );
  });
  const client = {
    listTools: async () => ({
      tools: [{ name: "browser_snapshot", inputSchema: { type: "object" } }],
    }),
    callTool: async ({ name }: { name: string }) => {
      executed.push(name);
      return {
        content: [
          {
            type: "text" as const,
            text: `### Snapshot\n- status: observation-${executed.length}`,
          },
        ],
      };
    },
  };
  return {
    path,
    requests,
    executed,
    client,
    output: () => output,
    records: () =>
      readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    run: (runs = 3, maxIterations = 30, mode: "auto" | "full" = "auto") =>
      runBatch(client, {
        url: "http://fixture/?runId=exact&step=1",
        runs,
        maxIterations,
        instructions: "Choose Business for this customer.",
        context: { mode, historyBytes: 1000, numCtx: 16384 },
      }),
  };
}

for (const mode of ["auto", "full"] as const) {
  test(`three confirmed runs use fresh conversations and never start a fourth (${mode})`, async (t) => {
    const a = fixture(t, [
      toolCall(),
      confirmed("ONE"),
      toolCall(),
      confirmed("TWO"),
      toolCall(),
      confirmed("THREE"),
    ]);
    const summary = await a.run(3, 6, mode);
    assert.equal(summary.iterationsUsed, 6);
    assert.equal(summary.requestedRuns, 3);
    assert.deepEqual(
      summary.results.map((result) => [
        result.runIndex,
        result.status,
        result.reference,
      ]),
      [
        [1, "confirmed", "ONE"],
        [2, "confirmed", "TWO"],
        [3, "confirmed", "THREE"],
      ],
    );
    assert.equal(a.requests.length, 6);
    assert.deepEqual(a.executed, [
      "browser_snapshot",
      "browser_snapshot",
      "browser_snapshot",
    ]);
    for (const [requestIndex, runIndex] of [
      [0, 1],
      [2, 2],
      [4, 3],
    ]) {
      const messages = a.requests[requestIndex].messages;
      assert.equal(
        messages.length,
        2,
        "A run must begin without prior observations or reports",
      );
      assert.match(messages[1].content, new RegExp(`Run ${runIndex} of 3`));
      assert.match(
        messages[1].content,
        /http:\/\/fixture\/\?runId=exact&step=1/,
      );
      assert.match(messages[1].content, /Choose Business/);
      assert.doesNotMatch(
        JSON.stringify(messages),
        /observation-|Registered customer|Reference ID: (ONE|TWO|THREE)/,
      );
    }
    assert.equal(
      a.records().filter((record) => record.message === "Form run started")
        .length,
      3,
    );
    assert.equal(
      existsSync(join(dirname(a.path), "history.jsonl")),
      mode === "auto",
    );
  });
}

for (const status of ["blocked", "uncertain"]) {
  test(`a ${status} second run stops without a replacement`, async (t) => {
    const a = fixture(t, [
      confirmed("ONE"),
      {
        content: JSON.stringify({
          status,
          summary: "Company is missing; outcome unconfirmed.",
        }),
      },
    ]);
    await assert.rejects(a.run(), new RegExp(`Run 2/3 ${status}`));
    assert.equal(a.requests.length, 2);
    const summary = a
      .records()
      .find((record) => record.message === "Form runs summary").data;
    assert.deepEqual(
      summary.results.map((result: { status: string }) => result.status),
      ["confirmed", status],
    );
    assert.equal(summary.iterationsUsed, 2);
  });
}

for (const content of [
  "Everything is done.",
  '{"status":"confirmed","summary":"Done"}',
  '{"status":"confirmed","summary":"Done","evidence":"   "}',
  '{"status":"unknown","summary":"Done","evidence":"Success"}',
]) {
  test(`an invalid final report stops as uncertain: ${content}`, async (t) => {
    const a = fixture(t, [{ content }]);
    await assert.rejects(a.run(), /Run 1\/3 uncertain/);
    assert.equal(a.requests.length, 1);
    assert.equal(
      a.records().find((record) => record.message === "Form runs summary").data
        .results[0].status,
      "uncertain",
    );
  });
}

test("all runs share the iteration budget, including empty-response recovery", async (t) => {
  const a = fixture(t, [{}, confirmed("ONE"), {}, confirmed("MUST-NOT-RUN")]);
  await assert.rejects(a.run(3, 3), /Agent exceeded maximum iterations/);
  assert.equal(a.requests.length, 3);
  assert.equal(a.requests[1].messages.at(-1)?.role, "user");
  assert.equal(a.requests[2].messages.length, 2);
  const summary = a
    .records()
    .find((record) => record.message === "Form runs summary").data;
  assert.equal(summary.iterationsUsed, 3);
  assert.deepEqual(
    summary.results.map((result: { status: string }) => result.status),
    ["confirmed", "uncertain"],
  );
});

test("a spent budget cannot start the next run", async (t) => {
  const a = fixture(t, [confirmed("ONE")]);
  await assert.rejects(a.run(3, 1), /Agent exceeded maximum iterations/);
  assert.equal(a.requests.length, 1);
  assert.equal(
    a.records().filter((record) => record.message === "Form run started")
      .length,
    1,
  );
});

test("automatic runs share an artifact writer while history turn IDs are run-scoped", async (t) => {
  const a = fixture(t, [
    toolCall("prowl_full_snapshot"),
    confirmed("ONE"),
    toolCall("prowl_full_snapshot"),
    confirmed("TWO"),
  ]);
  await a.run(2, 4);
  const folder = dirname(a.path);
  assert.deepEqual(
    readdirSync(folder).filter((file) => file.startsWith("snapshot-")),
    ["snapshot-0001.json", "snapshot-0002.json"],
  );
  assert.match(
    readFileSync(join(folder, "snapshot-0001.json"), "utf8"),
    /observation-1/,
  );
  assert.match(
    readFileSync(join(folder, "snapshot-0002.json"), "utf8"),
    /observation-2/,
  );
  const history = readFileSync(join(folder, "history.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    history.map((turn) => [turn.runIndex, turn.id]),
    [
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
    ],
  );
});

test("compacted checkpoints from one run never enter the next conversation", async (t) => {
  const a = fixture(t, [
    toolCall(),
    toolCall(),
    toolCall(),
    confirmed("ONE"),
    confirmed("TWO"),
  ]);
  await a.run(2, 5);
  assert.ok(
    a
      .records()
      .some(
        (record) =>
          record.message === "Context event" && record.data.kind === "history",
      ),
  );
  assert.equal(a.requests[4].messages.length, 2);
  assert.doesNotMatch(
    JSON.stringify(a.requests[4].messages),
    /observation-|Reference ID: ONE/,
  );
});

test("MCP failure retains prior results and never starts another run", async (t) => {
  const a = fixture(t, [confirmed("ONE"), toolCall()]);
  t.mock.method(a.client, "callTool", async () => {
    throw Error("Browser disconnected");
  });
  await assert.rejects(a.run(), /Browser disconnected/);
  const summary = a
    .records()
    .find((record) => record.message === "Form runs summary").data;
  assert.deepEqual(
    summary.results.map((result: { status: string }) => result.status),
    ["confirmed", "uncertain"],
  );
  assert.equal(summary.results[1].summary, "Browser disconnected");
  assert.equal(a.requests.length, 2);
});

test("normal run output shows confirmation evidence and reference IDs without raw JSON", async (t) => {
  const a = fixture(t, [
    {
      content: JSON.stringify({
        status: "confirmed",
        summary: "Registered the customer.",
        evidence: "Customer registered successfully.",
        reference: "DEMO-EXACT-123",
      }),
    },
  ]);
  await a.run(1, 1);
  assert.match(a.output(), /Customer registered successfully\./);
  assert.match(a.output(), /DEMO-EXACT-123/);
  assert.doesNotMatch(a.output(), /"status"\s*:/);
});
