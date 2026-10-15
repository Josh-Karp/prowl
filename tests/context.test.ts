import type { CallToolResult } from "@modelcontextprotocol/client";

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserContext } from "#agent/context/observations.js";
import {
  capabilities,
  textResult,
  page,
  compactTree,
  full,
  native,
  tool,
} from "#tests/fixtures/context.js";

function fixture(before = native, after = before, scoped = page(compactTree)) {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> =
    [];
  let evaluations = 0;
  const client = {
    callTool: async (call: (typeof calls)[number]) => {
      calls.push(call);
      if (call.name === "browser_evaluate")
        return textResult(
          `### Result\n${JSON.stringify(++evaluations === 1 ? before : after)}\n### Ran Playwright code\nread only`,
        );
      return scoped;
    },
  };
  const events: unknown[] = [];
  const archive: unknown[] = [];
  return {
    context: new BrowserContext(client, {
      capabilities,
      onEvent: (event) => events.push(event),
      onArchive: (value) => archive.push(value),
    }),
    calls,
    events,
    archive,
  };
}

test("large cluttered snapshots preserve scoped refs, native constraints, instructions and feedback", async () => {
  const f = fixture();
  const result = await f.context.reduce("browser_snapshot", {}, full);
  assert.ok(
    Buffer.byteLength(JSON.stringify(result)) <
      Buffer.byteLength(JSON.stringify(full)) * 0.75,
  );
  const content = JSON.stringify(result);
  assert.match(content, /minlength/);
  assert.match(content, /e2/);
  assert.match(content, /legal name/);
  assert.match(content, /DEMO-123/);
  assert.doesNotMatch(content, /Useful guide/);
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ["browser_evaluate", "browser_snapshot", "browser_evaluate"],
  );
  assert.equal(f.archive.length, 1);
});

test("clean snapshots and explicit snapshot requests pass through without helper calls", async () => {
  const f = fixture();
  for (const args of [
    { target: "#contact" },
    { depth: 3 },
    { boxes: false },
    { filename: "user.yml" },
  ])
    assert.equal(await f.context.reduce("browser_snapshot", args, full), full);
  const clean = page(compactTree);
  assert.equal(await f.context.reduce("browser_snapshot", {}, clean), clean);
  assert.equal(f.calls.length, 0);
});

test("errors and results containing images are untouched", async () => {
  const f = fixture();
  const error = { ...full, isError: true };
  const mixed = {
    content: [
      ...full.content,
      { type: "image", data: "opaque", mimeType: "image/png" },
    ],
  };
  assert.equal(await f.context.reduce("browser_click", {}, error), error);
  assert.equal(await f.context.reduce("browser_snapshot", {}, mixed), mixed);
  assert.equal(f.calls.length, 0);
});

test("unsupported MCP capabilities pass through without invoking helpers", async () => {
  const f = fixture();
  const context = new BrowserContext(
    {
      callTool: async () => {
        throw Error("unexpected");
      },
    },
    { capabilities: [tool("browser_snapshot")] },
  );
  assert.equal(await context.reduce("browser_snapshot", {}, full), full);
  assert.equal(f.calls.length, 0);
});

test("exact reference matching rejects ambiguous labels, mismatched roles and reused refs", async () => {
  for (const scoped of [
    compactTree + '\n  - textbox "Name" [ref=e5]',
    '- spinbutton "Name" [ref=e2]',
    '- textbox "Name extra" [ref=e2]',
  ]) {
    const f = fixture(native, native, page(scoped));
    const result = await f.context.reduce("browser_snapshot", {}, full);
    assert.doesNotMatch(JSON.stringify(result), /Native form metadata/);
    assert.ok(
      f.events.some(
        (event) =>
          (event as { reason: string }).reason ===
          "ambiguous native control refs",
      ),
    );
  }
  const shared = {
    ...native,
    fields: [native.fields[0], { ...native.fields[0], label: "Other" }],
  };
  const f = fixture(
    shared,
    shared,
    page('- textbox "Name" [ref=e1]\n- textbox "Other" [ref=e1]'),
  );
  assert.doesNotMatch(
    JSON.stringify(await f.context.reduce("browser_snapshot", {}, full)),
    /Native form metadata/,
  );
  const quoted = {
    ...native,
    fields: [{ ...native.fields[0], label: 'A "quoted" name' }],
  };
  const q = fixture(
    quoted,
    quoted,
    page("- textbox " + JSON.stringify(quoted.fields[0].label) + " [ref=e9]"),
  );
  const result = await q.context.reduce("browser_snapshot", {}, full);
  assert.match((result.content[0] as { text: string }).text, /"ref":"e9"/);
});

test("helper failures, unsupported forms, ambiguous refs and changed pages return fresh full snapshots", async () => {
  for (const before of [
    { fallback: "custom widget" },
    { fallback: "multiple forms" },
    { fallback: "frames" },
    native,
  ]) {
    const fallback = page("fresh full snapshot");
    const calls: string[] = [];
    let n = 0;
    const context = new BrowserContext(
      {
        callTool: async ({ name, arguments: args }) => {
          calls.push(name);
          if (name === "browser_evaluate") {
            if (++n === 2)
              return textResult(
                `### Result\n${JSON.stringify({ ...native, fingerprint: "changed" })}`,
              );
            return textResult(`### Result\n${JSON.stringify(before)}`);
          }
          return args?.target ? page(compactTree) : fallback;
        },
      },
      { capabilities },
    );
    assert.deepEqual(
      await context.reduce("browser_snapshot", {}, full),
      fallback,
    );
    assert.equal(calls.at(-1), "browser_snapshot");
  }
  const fallback = page("fresh after failure");
  const context = new BrowserContext(
    {
      callTool: async ({ name }) => {
        if (name === "browser_evaluate") throw Error("unsupported");
        return fallback;
      },
    },
    { capabilities },
  );
  assert.deepEqual(
    await context.reduce("browser_snapshot", {}, full),
    fallback,
  );
});

test("insufficient savings returns a fresh full observation and diagnostics never reduce", async () => {
  const f = fixture(native, native, full);
  assert.deepEqual(await f.context.reduce("browser_snapshot", {}, full), full);
  assert.deepEqual(await f.context.fullSnapshot(), full);
  assert.equal(f.calls.at(-1)?.arguments?.target, undefined);
});

test("reduction preserves action receipts, console messages, annotations and other result fields", async () => {
  const f = fixture();
  const original = {
    ...full,
    content: [
      {
        ...full.content[0],
        text:
          "### Ran Playwright code\nawait page.click();\n" +
          full.content[0].text +
          "\n### New console messages\n- POST rejected by server; inspect response",
        annotations: { audience: ["assistant" as const] },
      },
      {
        type: "text" as const,
        text: "Action-specific receipt: request failed",
      },
    ],
    receipt: { requestId: "exact-request" },
  };
  const result = await f.context.reduce(
    "browser_click",
    { target: "e3" },
    original,
  );
  assert.match(JSON.stringify(result), /await page.click/);
  assert.match(JSON.stringify(result), /POST rejected by server/);
  assert.match(JSON.stringify(result), /Action-specific receipt/);
  assert.deepEqual(
    (result.content as Array<{ annotations?: unknown }>)[0].annotations,
    { audience: ["assistant"] },
  );
  assert.deepEqual(result.receipt, { requestId: "exact-request" });
  assert.doesNotMatch(JSON.stringify(result), /Useful guide information/);
});

test("fresh fallback preserves original action receipts and refresh diagnostics without stale snapshots", async () => {
  const original = {
    ...full,
    receipt: { requestId: "keep-request" },
    content: [
      {
        ...full.content[0],
        annotations: { audience: ["assistant" as const] },
        text:
          "### Ran Playwright code\nawait page.click();\n" +
          full.content[0].text +
          "\n### New console messages\nPOST rejected",
      },
      { type: "text" as const, text: "Action-specific diagnostic" },
    ],
  };
  const fresh = page('- textbox "Fresh field" [ref=e99]');
  fresh.content.push({
    type: "text" as const,
    text: "Refresh-specific diagnostic",
  });
  const context = new BrowserContext(
    {
      callTool: async ({ name }) =>
        name === "browser_evaluate"
          ? textResult('### Result\n{"fallback":"custom widget"}')
          : fresh,
    },
    { capabilities },
  );
  const result = await context.reduce(
    "browser_click",
    { target: "e3" },
    original,
  );
  const serialized = JSON.stringify(result);
  for (const value of [
    "POST rejected",
    "await page.click",
    "Action-specific diagnostic",
    "Refresh-specific diagnostic",
    "e99",
  ])
    assert.ok(serialized.includes(value));
  assert.doesNotMatch(serialized, /Useful guide information/);
  assert.doesNotMatch(serialized, /textbox \\"Name/);
  assert.deepEqual(result.receipt, original.receipt);
  assert.ok(
    (result.content as Array<{ annotations?: unknown }>).some(
      (item) => !!item.annotations,
    ),
  );
});

test("snapshots below 8 KiB pass through and the boundary permits helper calls", async () => {
  const original = page(compactTree);
  original.content[0].text += "x".repeat(
    8191 - Buffer.byteLength(JSON.stringify(original)),
  );
  assert.equal(Buffer.byteLength(JSON.stringify(original)), 8191);
  const below = fixture();
  assert.equal(
    await below.context.reduce("browser_snapshot", {}, original),
    original,
  );
  assert.equal(below.calls.length, 0);

  original.content[0].text += "x";
  assert.equal(Buffer.byteLength(JSON.stringify(original)), 8192);
  const boundary = fixture();
  await boundary.context.reduce("browser_snapshot", {}, original);
  assert.equal(boundary.calls[0]?.name, "browser_evaluate");
});

test("ambiguous scoped refs on a stable page require a fresh full snapshot", async () => {
  const fresh = page('- textbox "Fresh field" [ref=e99]');
  const scoped = page(compactTree + '\n  - textbox "Name" [ref=e5]');
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> =
    [];
  const archived: unknown[] = [];
  const context = new BrowserContext(
    {
      callTool: async (call) => {
        calls.push(call);
        if (call.name === "browser_evaluate")
          return textResult(`### Result\n${JSON.stringify(native)}`);
        return call.arguments?.target ? scoped : fresh;
      },
    },
    {
      capabilities,
      onEvent: undefined,
      onArchive: (value) => archived.push(value),
    },
  );
  assert.deepEqual(await context.reduce("browser_snapshot", {}, full), fresh);
  assert.deepEqual(calls.at(-1), { name: "browser_snapshot", arguments: {} });
  assert.deepEqual(archived, [full, fresh]);
});

test("malformed native metadata returns fresh refs rather than stale original evidence", async () => {
  const fresh = page('- textbox "Fresh field" [ref=e99]');
  for (const metadata of [
    "not JSON",
    JSON.stringify({ ...native, fields: [null] }),
    JSON.stringify({ ...native, outside: undefined }),
    JSON.stringify({ ...native, feedback: [false] }),
    ...[
      { id: 1 },
      { htmlType: null },
      { required: "true" },
      { disabled: 0 },
      { readonly: null },
      { value: 7 },
      { constraints: { min: 2 } },
      { options: [{ label: "Plan", value: "plan", disabled: "false" }] },
      { group: false },
    ].map((field) =>
      JSON.stringify({
        ...native,
        fields: [{ ...native.fields[0], ...field }],
      }),
    ),
  ]) {
    const context = new BrowserContext(
      {
        callTool: async ({ name, arguments: args }) => {
          if (name === "browser_evaluate")
            return textResult(`### Result\n${metadata}`);
          return args?.target ? page(compactTree) : fresh;
        },
      },
      { capabilities },
    );
    const result = await context.reduce("browser_snapshot", {}, full);
    assert.deepEqual(result, fresh, metadata);
    assert.match(JSON.stringify(result), /e99/);
    assert.doesNotMatch(JSON.stringify(result), /Useful guide|ref=e2/);
  }
});

test("own zero and undefined snapshot customizations pass through, inherited ones do not", async () => {
  const f = fixture();
  for (const args of [{ depth: 0 }, { target: undefined }, { boxes: false }]) {
    assert.equal(await f.context.reduce("browser_snapshot", args, full), full);
  }
  assert.equal(f.calls.length, 0);
  const result = await f.context.reduce(
    "browser_snapshot",
    Object.create({ boxes: false }),
    full,
  );
  assert.doesNotMatch(JSON.stringify(result), /Useful guide/);
});

test("savings must reach the exact byte and percentage boundaries", async () => {
  for (const [originalBytes, savings, reduced] of [
    [8192, 2047, false],
    [8192, 2048, true],
    [12000, 2999, false],
    [12000, 3000, true],
  ] as const) {
    const original = page(compactTree);
    original.content[0].text = original.content[0].text.replace(
      compactTree,
      compactTree +
        "x".repeat(originalBytes - Buffer.byteLength(JSON.stringify(original))),
    );
    const metadata = {
      url: native.url,
      outside: native.outside,
      feedback: native.feedback,
      fields: [{ ...native.fields[0], ref: "e2" }],
    };
    const expected = page(compactTree);
    expected.content[0].text +=
      "\n### Native form metadata\n" + JSON.stringify(metadata);
    const padding =
      originalBytes - savings - Buffer.byteLength(JSON.stringify(expected));
    const scoped = page(compactTree + "x".repeat(padding));
    const fresh = page('- textbox "Fresh field" [ref=e99]');
    const events: Array<{
      reduced: boolean;
      reason: string;
      returnedBytes: number;
    }> = [];
    const context = new BrowserContext(
      {
        callTool: async ({ name, arguments: args }) => {
          if (name === "browser_evaluate")
            return textResult(`### Result\n${JSON.stringify(native)}`);
          return args?.target ? scoped : fresh;
        },
      },
      { capabilities, onEvent: (event) => events.push(event) },
    );
    const result = await context.reduce("browser_snapshot", {}, original);
    assert.equal(Buffer.byteLength(JSON.stringify(original)), originalBytes);
    assert.equal(
      events[0].reduced,
      reduced,
      `${originalBytes} bytes, ${savings} savings`,
    );
    assert.equal(
      events[0].reason,
      reduced ? "scoped native form" : "insufficient savings",
    );
    if (reduced)
      assert.equal(
        Buffer.byteLength(JSON.stringify(result)),
        originalBytes - savings,
      );
    else assert.deepEqual(result, fresh);
  }
});

test("failed refresh propagates rather than returning stale refs or recording success", async () => {
  const events: unknown[] = [];
  const archived: unknown[] = [];
  const failure = Error("refresh unavailable");
  const context = new BrowserContext(
    {
      callTool: async ({ name }) => {
        if (name === "browser_evaluate") throw Error("helper unavailable");
        throw failure;
      },
    },
    {
      capabilities,
      onEvent: (event) => events.push(event),
      onArchive: (value) => archived.push(value),
    },
  );
  await assert.rejects(
    context.reduce("browser_click", {}, full),
    (error) => error === failure,
  );
  assert.deepEqual(archived, [full]);
  assert.deepEqual(events, []);
});

test("a failed full refresh propagates its error without reusing stale refs", async () => {
  const failure = new Error("Browser disconnected during refresh");
  const context = new BrowserContext(
    {
      callTool: async ({ name }) => {
        if (name === "browser_evaluate")
          return textResult('### Result\n{"fallback":"custom widget"}');
        throw failure;
      },
    },
    { capabilities },
  );
  await assert.rejects(
    context.reduce("browser_click", { target: "e3" }, full),
    (error) => error === failure,
  );
});

test("malformed, mixed, missing and ambiguous snapshot content passes through", async () => {
  const f = fixture();
  for (const content of [
    undefined,
    [],
    Array(1),
    [null],
    ["text"],
    [{ type: "text", text: 1 }],
    [...full.content, ...full.content],
    [...full.content, { type: "image", data: "opaque", mimeType: "image/png" }],
  ]) {
    const value = {
      content,
    } as unknown as CallToolResult;
    assert.equal(await f.context.reduce("browser_snapshot", {}, value), value);
  }
  assert.equal(f.calls.length, 0);
});
