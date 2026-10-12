import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/client";
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
    await runAgent(
      client,
      "Register John Smith",
      undefined,
      undefined,
      undefined,
      { contextMode: "full" },
    );
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
      /Inspect the form first|Page snapshot|tool_calls|Register John Smith/,
    );
    const logs = readFileSync(path, "utf8");
    assert.match(logs, /Inspect the form first/);
    assert.match(logs, /Page snapshot/);
    assert.match(logs, /Register John Smith/);
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
    assert.match(readFileSync(path, "utf8"), /Verbose model reasoning/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("automatic mode routes local tools, strips completed thinking and archives exact results", async (t) => {
  const path = logFile(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: Array<{
    messages: Array<Record<string, unknown>>;
    tools: Array<{ function: { name: string } }>;
  }> = [];
  const names = [
    "browser_snapshot",
    "prowl_full_snapshot",
    "prowl_browser_history",
  ];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options!.body as string));
    const name = names[requests.length - 1];
    return new Response(
      JSON.stringify({
        message: name
          ? {
              role: "assistant",
              content: "",
              thinking: "private diagnostic reasoning",
              tool_calls: [
                {
                  function: {
                    name,
                    arguments:
                      name === "prowl_browser_history" ? { turnId: 1 } : {},
                  },
                },
              ],
            }
          : { role: "assistant", content: "Finished" },
        prompt_eval_count: 500,
      }),
    );
  };
  const calls: string[] = [];
  const client = {
    listTools: async () => ({
      tools: [{ name: "browser_snapshot", inputSchema: { type: "object" } }],
    }),
    callTool: async ({ name }: { name: string }) => {
      calls.push(name);
      return {
        content: [
          { type: "text", text: "### Snapshot\n- status: DEMO-Exact-321" },
        ],
      };
    },
  } as unknown as Client;
  await runAgent(
    client,
    "Keep http://fixture/?runId=EXACT",
    undefined,
    undefined,
    4,
    { contextMode: "auto" },
  );
  assert.deepEqual(calls, ["browser_snapshot", "browser_snapshot"]);
  assert.ok(
    requests[0].tools.some(
      (tool) => tool.function.name === "prowl_full_snapshot",
    ),
  );
  assert.equal(requests[1].messages[2].thinking, undefined);
  assert.match(
    String(requests[3].messages.at(-1)?.content),
    /private diagnostic reasoning/,
  );
  assert.match(readFileSync(path, "utf8"), /context-config/);
  assert.match(
    readFileSync(join(path, "..", "history.jsonl"), "utf8"),
    /DEMO-Exact-321/,
  );
});

test("long automatic conversations compact and retrieve exact archived confirmation evidence", async (t) => {
  const path = logFile(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options!.body as string));
    const step = requests.length;
    const name =
      step <= 10
        ? "browser_snapshot"
        : step === 11
          ? "prowl_browser_history"
          : null;
    return new Response(
      JSON.stringify({
        message: name
          ? {
              role: "assistant",
              content: "",
              thinking: "original reasoning",
              tool_calls: [
                {
                  function: {
                    name,
                    arguments:
                      name === "prowl_browser_history" ? { turnId: 1 } : {},
                  },
                },
              ],
            }
          : { role: "assistant", content: "Confirmation DEMO-Case-Exact-123" },
        prompt_eval_count: 800,
      }),
    );
  };
  let observations = 0;
  const client = {
    listTools: async () => ({
      tools: [{ name: "browser_snapshot", inputSchema: { type: "object" } }],
    }),
    callTool: async () => ({
      content: [
        {
          type: "text",
          text:
            `### Snapshot\n- status: ${++observations === 1 ? "Confirmation DEMO-Case-Exact-123" : "Current page " + observations}\n` +
            "- paragraph: browser details\n".repeat(70),
        },
      ],
    }),
  } as unknown as Client;
  const task =
    "Preserve http://fixture/?runId=EXACT&step=1 and the original confirmation. Do not submit again.";
  await runAgent(client, task, undefined, undefined, 12, {
    contextMode: "auto",
    historyBytes: 8000,
  });
  assert.equal(observations, 10);
  assert.ok(
    requests.some((request) =>
      request.messages.some(
        (message) => message.tool_name === "prowl_browser_history",
      ),
    ),
  );
  assert.ok(requests.every((request) => request.messages[1].content === task));
  const retrieval = String(requests.at(-1)?.messages.at(-1)?.content);
  assert.match(retrieval, /DEMO-Case-Exact-123/);
  assert.match(retrieval, /original reasoning/);
  assert.match(retrieval, /Historical refs/);
  const logs = readFileSync(path, "utf8");
  assert.match(logs, /"kind":"history"/);
  assert.match(
    readFileSync(join(path, "..", "history.jsonl"), "utf8"),
    /browser details/,
  );
});
