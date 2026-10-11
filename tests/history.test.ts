import assert from "node:assert/strict";
import test from "node:test";
import { ConversationHistory } from "../src/agent/history.js";
import type { OllamaMessage } from "../src/models/ollama.js";
const prefix: OllamaMessage[] = [
  { role: "system", content: "Follow task" },
  {
    role: "user",
    content: "Go http://fixture/?runId=EXACT&step=1 then submit once",
  },
];
function turn(id: number, observation = false, error = false): OllamaMessage[] {
  const calls = ["browser_click", "browser_snapshot"].map((name) => ({
    function: { name, arguments: { target: `e${id}` } },
  }));
  return [
    {
      role: "assistant",
      content: `Turn ${id}`,
      thinking: "private thoughts".repeat(30),
      tool_calls: calls,
    },
    ...calls.map((c) => ({
      role: "tool" as const,
      tool_name: c.function.name,
      content: JSON.stringify({
        isError: error,
        content: [
          {
            type: "text",
            text:
              (observation ? "### Snapshot\n" : "") +
              `receipt-${id} ` +
              "detail ".repeat(150),
          },
        ],
      }),
    })),
  ];
}

test("compaction protects exact instructions and complete tool groups, archives raw thinking and receipts", () => {
  const events: unknown[] = [];
  const archived: unknown[] = [];
  const h = new ConversationHistory(
    prefix,
    10000,
    16384,
    (e) => events.push(e),
    (v) => archived.push(v),
  );
  for (let i = 1; i <= 20; i++) h.appendTurn(turn(i, i === 18));
  const messages = h.prepare();
  assert.deepEqual(messages.slice(0, 2), prefix);
  assert.ok(JSON.stringify(messages).includes("receipt-18"));
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) < 10000);
  assert.ok(!JSON.stringify(messages).includes("private thoughts"));
  assert.equal(archived.length, 20);
  for (let i = 2; i < messages.length; i++) {
    const message = messages[i];
    if (message.tool_calls?.length) {
      assert.deepEqual(
        messages
          .slice(i + 1, i + 1 + message.tool_calls.length)
          .map((x) => x.tool_name),
        message.tool_calls.map((x) => x.function.name),
      );
    }
  }
  const old = h.retrieve({ turnId: 1 });
  assert.match(JSON.stringify(old), /private thoughts/);
  assert.match(JSON.stringify(old), /receipt-1/);
  assert.match(JSON.stringify(old), /historical.*refs/i);
  assert.ok(events.length > 0);
});

test("checkpoints remain identical between compactions and do not require a model request", () => {
  const h = new ConversationHistory(prefix, 8000, 1000);
  for (let i = 1; i <= 5; i++) h.appendTurn(turn(i));
  const first = h.prepare(850);
  const checkpoint = first.slice(2, 4);
  assert.equal(
    checkpoint[0].tool_calls?.[0].function.name,
    "prowl_browser_history",
  );
  assert.equal(checkpoint[1].tool_name, "prowl_browser_history");
  h.appendTurn([{ role: "assistant", content: "Finished" }]);
  assert.deepEqual(h.prepare().slice(2, 4), checkpoint);
});

test("literal old confirmation evidence survives compaction and no requested action becomes inferred success", () => {
  const h = new ConversationHistory(prefix, 6000, 16384);
  const first = turn(1);
  first[1].content = JSON.stringify({
    content: [
      {
        type: "text",
        text: '### Snapshot\n- heading "Submitted" [ref=e5]\n- status: Confirmation ID: DEMO-Exact-123',
      },
    ],
  });
  h.appendTurn(first);
  for (let i = 2; i <= 15; i++) h.appendTurn(turn(i, i === 15));
  const messages = h.prepare();
  assert.match(JSON.stringify(messages), /DEMO-Exact-123/);
  const checkpoint = JSON.parse(messages[3].content);
  assert.match(checkpoint.notice, /requested actions.*observed/i);
  assert.equal(checkpoint.success, undefined);
});

test("latest observation and tool errors survive an oversized-state budget exception", () => {
  const events: Array<{ kind: string }> = [];
  const h = new ConversationHistory(prefix, 300, 16384, (e) => events.push(e));
  h.appendTurn(turn(1, true));
  h.appendTurn(turn(2, false, true));
  h.appendTurn(turn(3));
  const messages = h.prepare();
  for (const id of [1, 2, 3])
    assert.match(JSON.stringify(messages), new RegExp(`receipt-${id}`));
  assert.ok(events.some((e) => e.kind === "budget-exception"));
});

test("rejects partial or mispaired turns, keeps no-calls final messages, and rejects unknown archive IDs", () => {
  const h = new ConversationHistory(prefix, 8000, 16384);
  assert.throws(() => h.appendTurn(turn(1).slice(0, 2)), /complete|pair/);
  const wrong = turn(2);
  wrong[1].tool_name = "wrong";
  assert.throws(() => h.appendTurn(wrong), /complete|pair/);
  h.appendTurn([{ role: "assistant", content: "Report" }]);
  assert.equal(h.prepare().at(-1)?.content, "Report");
  assert.throws(() => h.retrieve({ turnId: 99 }), /Unknown/);
});

test("large archived arguments do not grow the checkpoint or prevent removing other eligible turns", () => {
  const events: Array<{
    kind: string;
    beforeBytes: number;
    afterBytes: number;
  }> = [];
  const h = new ConversationHistory(prefix, 4000, 16384, (event) =>
    events.push(event),
  );
  h.appendTurn([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          function: {
            name: "browser_type",
            arguments: { target: "e1", text: "x".repeat(6000) },
          },
        },
      ],
    },
    {
      role: "tool",
      tool_name: "browser_type",
      content: '{"content":[{"type":"text","text":"Entered exact value"}]}',
    },
  ]);
  for (let id = 2; id <= 5; id++)
    h.appendTurn([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "browser_click",
              arguments: { target: `e${id}` },
            },
          },
        ],
      },
      {
        role: "tool",
        tool_name: "browser_click",
        content: '{"content":[{"type":"text","text":"Click receipt"}]}',
      },
    ]);
  const messages = h.prepare();
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) <= 2000);
  assert.ok(events.every((event) => event.kind !== "budget-exception"));
  assert.ok(!JSON.stringify(messages).includes("x".repeat(6000)));
  assert.match(
    JSON.stringify(h.retrieve({ turnId: 1 })),
    new RegExp("x".repeat(6000)),
  );
});
