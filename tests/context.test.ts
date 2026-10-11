import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserContext,
  attachFieldRefs,
  type NativeForm,
} from "../src/agent/context.js";

const tool = (name: string, properties = {}) => ({
  name,
  inputSchema: { type: "object", properties },
});
const capabilities = [
  tool("browser_evaluate"),
  tool("browser_snapshot", { target: { type: "string" } }),
];
const textResult = (text: string) => ({ content: [{ type: "text", text }] });
const page = (tree: string) =>
  textResult(
    `### Page\n- Page URL: http://fixture/?runId=exact\n### Snapshot\n\`\`\`yaml\n${tree}\n\`\`\``,
  );
const compactTree =
  '- generic [ref=e1]:\n  - textbox "Name" [ref=e2]\n  - button "Send message" [ref=e3]';
const full = page(
  compactTree +
    "\n- complementary [ref=e4]:\n" +
    "  - paragraph: Useful guide information about contact details.\n".repeat(
      300,
    ),
);
const native: NativeForm = {
  url: "http://fixture/?runId=exact",
  target: "#contact",
  fingerprint: "stable",
  fields: [
    {
      id: "name",
      role: "textbox",
      htmlType: "text",
      label: "Name",
      required: true,
      disabled: false,
      readonly: false,
      value: "",
      constraints: { minlength: "2" },
    },
  ],
  outside: ["Contact us", "Use your legal name."],
  feedback: ["Request DEMO-123 received"],
};
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
    context: new BrowserContext(
      client,
      capabilities,
      (event) => events.push(event),
      (value) => archive.push(value),
    ),
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
    [tool("browser_snapshot")],
  );
  assert.equal(await context.reduce("browser_snapshot", {}, full), full);
  assert.equal(f.calls.length, 0);
});

test("ambiguous labels, mismatched roles, and unparsed names never receive invented refs", () => {
  const duplicate = compactTree + '\n  - textbox "Name" [ref=e5]';
  assert.equal(attachFieldRefs(native.fields, duplicate), null);
  assert.equal(
    attachFieldRefs([{ ...native.fields[0], role: "spinbutton" }], compactTree),
    null,
  );
  assert.deepEqual(
    attachFieldRefs(
      [{ ...native.fields[0], label: 'A "quoted" name' }],
      '- textbox "A \\"quoted\\" name" [ref=e9]',
    )?.[0].ref,
    "e9",
  );
  const fields = [
    {
      ...native.fields[0],
      label: "Consent",
      role: "checkbox",
      htmlType: "checkbox",
    },
    { ...native.fields[0], label: "Choice", role: "radio", htmlType: "radio" },
    {
      ...native.fields[0],
      label: "Age",
      role: "spinbutton",
      htmlType: "number",
      constraints: { min: "18", max: "100" },
    },
    {
      ...native.fields[0],
      label: "Birth",
      htmlType: "date",
      constraints: { max: "2020-01-01" },
    },
    {
      ...native.fields[0],
      label: "Plan",
      role: "combobox",
      htmlType: "select-one",
      options: [{ label: "Business", value: "biz", disabled: false }],
    },
  ];
  assert.equal(
    attachFieldRefs(
      fields,
      fields
        .map(
          (x, i) => `- ${x.role} ${JSON.stringify(x.label)} [ref=e${i + 10}]`,
        )
        .join("\n"),
    )?.length,
    5,
  );
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
      capabilities,
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
    capabilities,
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
        annotations: { audience: ["assistant"] },
      },
      { type: "text", text: "Action-specific receipt: request failed" },
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
