import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/client";
import type { OllamaMessage } from "../src/models/ollama.js";
import { runAgent } from "../src/agent/loop.js";
import { configureLogger, logger } from "../src/logger.js";

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
  } as unknown as Client;

  try {
    await runAgent(client, "Register John Smith");
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
  } as unknown as Client;

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
      { listTools: async () => ({ tools: [] }) } as unknown as Client,
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
  } as unknown as Client;
  return {
    requests,
    executedTools,
    path,
    output: () => output,
    run: (maxIterations: number) =>
      runAgent(client, "Inspect the form", undefined, undefined, maxIterations),
  };
}

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
      thinking: "I will select the city.",
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
