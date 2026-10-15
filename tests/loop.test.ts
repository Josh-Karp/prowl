import type { TestContext } from "node:test";
import type { OllamaMessage } from "#models/ollama.js";
import type { ResolvedContextOptions } from "#agent/context/options.js";

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runAgent } from "#agent/loop.js";
import {
  capabilities,
  native,
  page,
  full,
  compactTree,
  textResult,
} from "#tests/fixtures/context.js";
import { configureLogger, logger } from "#logger.js";

function logFile(t: TestContext, verbose = false) {
  const directory = mkdtempSync(join(tmpdir(), "prowl-loop-"));
  const path = join(directory, "agent.log");
  configureLogger({ filePath: path, verbose });
  t.after(() => {
    configureLogger();
    rmSync(directory, { recursive: true, force: true });
  });
  return logger.filePath;
}

test("preserves tool conversation and logs full payloads while showing concise progress", async (t) => {
  const path = logFile(t);
  let output = "";
  t.mock.method(process.stdout, "write", (chunk: unknown) => {
    output += String(chunk);
    return true;
  });
  const originalFetch = globalThis.fetch;
  const originalLimit = process.env.MAX_ITERATIONS;
  process.env.MAX_ITERATIONS = "2";
  const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
  const toolCalls = [
    {
      function: {
        name: "browser_navigate",
        arguments: { url: "http://localhost:5173" },
      },
    },
  ];
  const browserResult = {
    content: [
      {
        type: "text",
        text: "Page snapshot: First name, Last name, Email, Register customer",
      },
    ],
  };

  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options!.body as string));
    return new Response(
      JSON.stringify({
        model: "fixture-model",
        done: true,
        done_reason: requests.length === 1 ? "tool_call" : "stop",
        prompt_eval_count: requests.length === 1 ? 120 : 240,
        eval_count: requests.length === 1 ? 25 : 10,
        unknown_field: "must not enter conversation",
        message:
          requests.length === 1
            ? {
                role: "assistant",
                content: "",
                thinking: "Inspect the form first.",
                tool_calls: toolCalls,
              }
            : { role: "assistant", content: "Ready to fill the form." },
      }),
    );
  };
  const client = {
    listTools: async () => ({
      tools: [{ name: "browser_navigate", inputSchema: { type: "object" } }],
    }),
    callTool: async () => browserResult,
  };

  try {
    await runAgent(
      client,
      "Register John Smith",
      undefined,
      undefined,
      undefined,
      { mode: "full", historyBytes: 32768, numCtx: 16384 },
    );
    assert.equal(existsSync(join(dirname(path), "history.jsonl")), false);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages[2], {
      role: "assistant",
      content: "",
      thinking: "Inspect the form first.",
      tool_calls: toolCalls,
    });
    assert.deepEqual(requests[1].messages[3], {
      role: "tool",
      tool_name: "browser_navigate",
      content: JSON.stringify(browserResult),
    });
    assert.match(output, /Iteration 1\/2/);
    assert.match(output, /browser_navigate/);
    assert.match(output, /Final response/);
    assert.doesNotMatch(
      output,
      /Inspect the form first|Page snapshot|tool_calls|Register John Smith|Ollama completion metadata|prompt_eval_count|eval_count|done_reason/,
    );
    const logs = readFileSync(path, "utf8");
    assert.match(logs, /Inspect the form first/);
    assert.match(logs, /Page snapshot/);
    assert.match(logs, /Register John Smith/);
    const metadata = logs
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((record) => record.message === "Ollama completion metadata");
    assert.deepEqual(
      metadata.map((record) => record.data),
      [
        {
          model: "fixture-model",
          done: true,
          done_reason: "tool_call",
          prompt_eval_count: 120,
          eval_count: 25,
        },
        {
          model: "fixture-model",
          done: true,
          done_reason: "stop",
          prompt_eval_count: 240,
          eval_count: 10,
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLimit === undefined) delete process.env.MAX_ITERATIONS;
    else process.env.MAX_ITERATIONS = originalLimit;
  }
});

test("an explicit iteration limit overrides MAX_ITERATIONS", async (t) => {
  logFile(t);
  const originalFetch = globalThis.fetch;
  const originalLimit = process.env.MAX_ITERATIONS;
  process.env.MAX_ITERATIONS = "0";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        message: { role: "assistant", content: "Completed." },
      }),
    );
  const client = {
    listTools: async () => ({ tools: [] }),
  };

  try {
    await runAgent(client, "Inspect the form", undefined, undefined, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLimit === undefined) delete process.env.MAX_ITERATIONS;
    else process.env.MAX_ITERATIONS = originalLimit;
  }
});

test("verbose mode includes model details in both console and file", async (t) => {
  const path = logFile(t, true);
  const originalFetch = globalThis.fetch;
  let output = "";
  t.mock.method(process.stdout, "write", (chunk: unknown) => {
    output += String(chunk);
    return true;
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        done: true,
        done_reason: "stop",
        eval_count: 15,
        message: {
          role: "assistant",
          content: "Completed.",
          thinking: "Verbose model reasoning",
        },
      }),
    );
  try {
    await runAgent(
      { listTools: async () => ({ tools: [] }) },
      "Detailed task",
      undefined,
      undefined,
      1,
    );
    assert.match(output, /Verbose model reasoning/);
    assert.match(output, /Detailed task/);
    assert.match(output, /Ollama completion metadata/);
    assert.match(output, /eval_count: 15/);
    const records = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.find((record) => record.message === "Ollama completion metadata")
        .data,
      { done: true, done_reason: "stop", eval_count: 15 },
    );
    assert.match(readFileSync(path, "utf8"), /Verbose model reasoning/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const recoveryMessage =
  "Your response contained no tool calls or final report. Continue the task using the available tools, or provide a final report describing the observed outcome or blocker. Do not repeat a submission whose outcome is uncertain.";

function scriptedAgent(
  t: TestContext,
  responses: Array<{
    content?: string;
    thinking?: string;
    tool_calls?: OllamaMessage["tool_calls"];
  }>,
  verbose = false,
) {
  const path = logFile(t, verbose);
  const requests: Array<{ messages: OllamaMessage[] }> = [];
  const executedTools: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }> = [];
  const toolResult = {
    content: [{ type: "text", text: "Observed browser state" }],
  };
  let output = "";
  for (const stream of [process.stdout, process.stderr]) {
    t.mock.method(stream, "write", (chunk: unknown) => {
      output += String(chunk);
      return true;
    });
  }
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body as string));
    const response = responses[requests.length - 1];
    assert.ok(response, "Agent requested an unexpected model response");
    return new Response(
      JSON.stringify({ message: { role: "assistant", ...response } }),
    );
  });
  const client = {
    listTools: async () => ({
      tools: [{ name: "browser_snapshot", inputSchema: { type: "object" } }],
    }),
    callTool: async (call: (typeof executedTools)[number]) => {
      executedTools.push(call);
      return toolResult;
    },
  };
  return {
    requests,
    executedTools,
    path,
    output: () => output,
    client,
    run: (maxIterations: number) =>
      runAgent(client, "Inspect the form", undefined, undefined, maxIterations),
  };
}

test("returns the final model report to the form-run orchestrator", async (t) => {
  const agent = scriptedAgent(t, [{ content: "Exact final report" }]);
  assert.equal(await agent.run(1), "Exact final report");
});

test("a shared session cannot reset the iteration allowance between fresh conversations", async (t) => {
  const agent = scriptedAgent(t, [
    { content: "First report" },
    {},
    { content: "Must never be requested" },
  ]);
  const session = { iterationsUsed: 0 };
  const context = { mode: "full" as const, historyBytes: 32768, numCtx: 16384 };
  await runAgent(
    agent.client,
    "First task",
    undefined,
    undefined,
    2,
    context,
    session,
  );
  await assert.rejects(
    runAgent(
      agent.client,
      "Second task",
      undefined,
      undefined,
      2,
      context,
      session,
    ),
    /Agent exceeded maximum iterations/,
  );
  assert.equal(session.iterationsUsed, 2);
  assert.equal(agent.requests.length, 2);
  assert.equal(agent.requests[1].messages.length, 2);
  assert.equal(agent.requests[1].messages[1].content, "Second task");
});

for (const [name, response] of [
  ["empty content", { content: "" }],
  ["thinking only", { content: "", thinking: "I will select the city." }],
  ["whitespace content", { content: " \n\t " }],
  ["missing content", {}],
  ["empty tool-call array", { content: "", tool_calls: [] }],
] satisfies Array<[string, Parameters<typeof scriptedAgent>[1][number]]>) {
  test(`recovers from ${name} to a final report`, async (t) => {
    const agent = scriptedAgent(t, [
      response,
      { content: "" },
      { content: "  Blocked: required information is unavailable.\n" },
    ]);
    await agent.run(3);
    assert.equal(agent.requests.length, 3);
    assert.deepEqual(agent.requests[1].messages.at(-1), {
      role: "user",
      content: recoveryMessage,
    });
    assert.deepEqual(agent.requests[2].messages.at(-1), {
      role: "user",
      content: recoveryMessage,
    });
    assert.match(agent.output(), /recovery attempt 1\/2/);
    assert.match(agent.output(), /recovery attempt 2\/2/);
    assert.match(
      agent.output(),
      /Final response:\n {2}Blocked: required information is unavailable\.\n/,
    );
    assert.doesNotMatch(agent.output(), /I will select the city/);
    assert.equal(agent.executedTools.length, 0);
  });
}

for (const verbose of [false, true]) {
  test(`preserves browser history during recovery (verbose: ${verbose})`, async (t) => {
    const toolCall = { function: { name: "browser_snapshot", arguments: {} } };
    const agent = scriptedAgent(
      t,
      [
        { content: "", tool_calls: [toolCall] },
        { content: "", thinking: "I will select the city." },
        { content: "Completed." },
      ],
      verbose,
    );
    await agent.run(3);
    assert.equal(agent.requests.length, 3);
    assert.deepEqual(
      agent.requests[2].messages.slice(0, 4),
      agent.requests[1].messages,
    );
    assert.deepEqual(agent.requests[2].messages[4], {
      role: "assistant",
      content: "",
    });
    assert.deepEqual(agent.requests[2].messages[5], {
      role: "user",
      content: recoveryMessage,
    });
    assert.deepEqual(agent.executedTools, [
      { name: "browser_snapshot", arguments: {} },
    ]);
    const logs = readFileSync(agent.path, "utf8");
    assert.match(logs, /I will select the city/);
    assert.match(logs, /Observed browser state/);
    assert.match(logs, /recovery attempt 1\/2/);
    assert.match(agent.output(), /recovery attempt 1\/2/);
    if (verbose) assert.match(agent.output(), /I will select the city/);
    else assert.doesNotMatch(agent.output(), /I will select the city/);
  });
}

for (const maxIterations of [3, 8]) {
  test(`fails after two empty-response recovery attempts (limit: ${maxIterations})`, async (t) => {
    const agent = scriptedAgent(t, [{}, {}, {}]);
    await assert.rejects(
      agent.run(maxIterations),
      /^Error: Model returned an empty response without tool calls after 2 recovery attempts\.$/,
    );
    assert.equal(agent.requests.length, 3);
    assert.doesNotMatch(agent.output(), /Final response|Agent finished/);
    assert.doesNotMatch(readFileSync(agent.path, "utf8"), /Agent finished/);
  });
}

test("tool calls reset consecutive empty-response recovery attempts", async (t) => {
  const agent = scriptedAgent(t, [
    {},
    {},
    {
      content: "",
      tool_calls: [{ function: { name: "browser_snapshot", arguments: {} } }],
    },
    {},
    {},
    { content: "Completed." },
  ]);
  await agent.run(6);
  assert.equal(agent.requests.length, 6);
  assert.equal(agent.executedTools.length, 1);
  assert.equal(agent.output().match(/recovery attempt 1\/2/g)?.length, 2);
  assert.equal(agent.output().match(/recovery attempt 2\/2/g)?.length, 2);
});

for (const maxIterations of [1, 2]) {
  test(`empty-response recovery respects an iteration limit of ${maxIterations}`, async (t) => {
    const agent = scriptedAgent(t, [{}, {}]);
    await assert.rejects(
      agent.run(maxIterations),
      /Agent exceeded maximum iterations\./,
    );
    assert.equal(agent.requests.length, maxIterations);
    assert.equal(
      agent.output().match(/recovery attempt/g)?.length ?? 0,
      maxIterations - 1,
    );
    assert.doesNotMatch(agent.output(), /recovery attempt 2\/2|Final response/);
  });
}

function contextAgent(
  t: TestContext,
  replies: Array<{
    message: Partial<OllamaMessage>;
    prompt_eval_count?: number;
  }>,
) {
  const path = logFile(t);
  t.mock.method(process.stdout, "write", () => true);
  const requests: Array<{
    messages: OllamaMessage[];
    tools: Array<{ function: { name: string } }>;
  }> = [];
  const executed: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body as string));
    const reply = replies[requests.length - 1];
    assert.ok(reply, "Unexpected model request");
    return new Response(
      JSON.stringify({
        ...reply,
        message: { role: "assistant", ...reply.message },
      }),
    );
  });
  const client = {
    listTools: async () => ({ tools: capabilities }),
    callTool: async ({
      name,
      arguments: args,
    }: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => {
      executed.push(name);
      if (name === "browser_evaluate")
        return textResult(`### Result\n${JSON.stringify(native)}`);
      if (name === "browser_snapshot" && args?.target) return page(compactTree);
      return full;
    },
  };
  return {
    path,
    requests,
    executed,
    client,
    run: (
      context: ResolvedContextOptions = {
        mode: "auto",
        historyBytes: 100000,
        numCtx: 16384,
      },
    ) =>
      runAgent(
        client,
        "Inspect and submit once",
        undefined,
        undefined,
        replies.length,
        context,
      ),
  };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  function: { name, arguments: args },
});

test("automatic mode reduces observations, strips thinking, and retrieves exact archived originals", async (t) => {
  const a = contextAgent(t, [
    {
      message: {
        thinking: "exact diagnostic thinking",
        tool_calls: [call("browser_navigate")],
      },
    },
    { message: { tool_calls: [call("prowl_browser_history", { turnId: 1 })] } },
    { message: { tool_calls: [call("prowl_full_snapshot")] } },
    { message: { content: "Completed" } },
  ]);
  await a.run();
  assert.doesNotMatch(
    JSON.stringify(a.requests[1].messages),
    /Useful guide|exact diagnostic thinking/,
  );
  assert.match(JSON.stringify(a.requests[1].messages), /Native form metadata/);
  const retrieved = a.requests[2].messages.at(-1)!;
  assert.match(retrieved.content, /Useful guide|exact diagnostic thinking/);
  assert.match(a.requests[3].messages.at(-1)!.content, /Useful guide/);
  assert.equal(
    a.executed.filter((name) => name === "browser_evaluate").length,
    2,
  );
  assert.equal(
    a.executed.some((name) => name.startsWith("prowl_")),
    false,
  );
  const archive = readFileSync(join(dirname(a.path), "history.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(archive.length, 4);
  assert.match(JSON.stringify(archive[0]), /Useful guide/);
  assert.match(JSON.stringify(archive[0]), /exact diagnostic thinking/);
  assert.ok(existsSync(join(dirname(a.path), "snapshot-0001.json")));
});

test("invalid and unknown local retrieval requests become tool errors without MCP execution", async (t) => {
  const a = contextAgent(t, [
    {
      message: {
        tool_calls: [
          call("prowl_browser_history", { turnId: "1" }),
          call("prowl_browser_history", { turnId: 99 }),
          call("prowl_browser_history", { checkpoint: 99 }),
          call("prowl_browser_history", { turnId: 1, checkpoint: 1 }),
          call("prowl_browser_history", { extra: true }),
          call("prowl_full_snapshot", { extra: true }),
        ],
      },
    },
    { message: { content: "Blocked" } },
  ]);
  await a.run();
  assert.equal(a.executed.length, 0);
  assert.ok(
    a.requests[1].messages
      .filter((message) => message.role === "tool")
      .every((message) => JSON.parse(message.content).isError === true),
  );
});

test("full mode retains original observations and thinking with no local tools or archive", async (t) => {
  const a = contextAgent(t, [
    {
      message: {
        thinking: "full thinking",
        tool_calls: [call("browser_snapshot")],
      },
    },
    { message: { content: "Completed" } },
  ]);
  await a.run({ mode: "full", historyBytes: 1, numCtx: 16384 });
  assert.match(JSON.stringify(a.requests[1].messages), /full thinking/);
  assert.match(JSON.stringify(a.requests[1].messages), /Useful guide/);
  assert.ok(
    a.requests[0].tools.every(
      (tool) => !tool.function.name.startsWith("prowl_"),
    ),
  );
  assert.deepEqual(a.executed, ["browser_snapshot"]);
  assert.equal(existsSync(join(dirname(a.path), "history.jsonl")), false);
  assert.equal(existsSync(join(dirname(a.path), "snapshot-0001.json")), false);
});

test("local full snapshot execution failures propagate", async (t) => {
  const a = contextAgent(t, [
    { message: { tool_calls: [call("prowl_full_snapshot")] } },
  ]);
  const failure = Error("Browser disconnected");
  t.mock.method(a.client, "callTool", async () => {
    throw failure;
  });
  await assert.rejects(a.run(), (error) => error === failure);
});

test("provider pressure is consumed once and resolved options override environment settings", async (t) => {
  const priorMode = process.env.PROWL_CONTEXT_MODE;
  process.env.PROWL_CONTEXT_MODE = "invalid";
  t.after(() => {
    if (priorMode === undefined) delete process.env.PROWL_CONTEXT_MODE;
    else process.env.PROWL_CONTEXT_MODE = priorMode;
  });
  const a = contextAgent(t, [
    ...Array.from({ length: 3 }, () => ({
      message: { tool_calls: [call("browser_click")] },
    })),
    {
      prompt_eval_count: 800,
      message: { tool_calls: [call("browser_click")] },
    },
    { message: { tool_calls: [call("browser_click")] } },
    { message: { content: "Completed" } },
  ]);
  await a.run({ mode: "auto", historyBytes: 1000000, numCtx: 1000 });
  const checkpoint = a.requests[4].messages[3];
  assert.equal(checkpoint.tool_name, "prowl_browser_history");
  assert.deepEqual(a.requests[5].messages[3], checkpoint);
});
