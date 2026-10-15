import type { NativeForm } from "#agent/context/nativeForm.js";

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { nativeFormScript } from "#agent/context/nativeForm.js";

// These stand-ins supply only the DOM methods/selectors used by this script.
// They do not model browser layout, accessible-name computation, or DOM conformance.
function element(overrides: Record<string, unknown> = {}) {
  const attributes = (overrides.attributes ?? {}) as Record<string, string>;
  const ancestors = (overrides.ancestors ?? {}) as Record<string, unknown>;
  return {
    id: "name",
    name: "",
    tagName: "INPUT",
    type: "text",
    textContent: "",
    labels: [{ textContent: "Name" }],
    value: "",
    required: false,
    disabled: false,
    readOnly: false,
    checked: false,
    multiple: false,
    validationMessage: "",
    options: [],
    checkVisibility: () => true,
    getAttribute: (key: string) => attributes[key] ?? null,
    hasAttribute: (key: string) => Object.hasOwn(attributes, key),
    closest: (selector: string) => ancestors[selector] ?? null,
    matches(selector: string) {
      if (selector === ":disabled") return this.disabled;
      if (
        selector === "input,select,textarea" ||
        selector === "input,select,textarea,button"
      ) {
        return selector.toUpperCase().split(",").includes(this.tagName);
      }
      throw Error(`Unexpected matches selector: ${selector}`);
    },
    ...overrides,
  };
}

function observe(
  fields = [element()],
  settings: {
    ids?: Record<string, unknown>;
    widgets?: ReturnType<typeof element>[];
    outsideControls?: ReturnType<typeof element>[];
    textNodes?: Array<{ parentElement: unknown; textContent: string }>;
    feedback?: ReturnType<typeof element>[];
    frame?: boolean;
    forms?: number;
    targets?: number;
    bodyText?: string;
  } = {},
): NativeForm | { fallback: string } {
  const form = {
    id: "contact",
    elements: fields,
    checkVisibility: () => true,
    closest: () => null,
    contains: (node: unknown) =>
      fields.includes(node as (typeof fields)[number]),
  };
  const textNodes = settings.textNodes ?? [];
  let index = -1;
  const walker = {
    currentNode: textNodes[0],
    nextNode() {
      this.currentNode = textNodes[++index];
      return index < textNodes.length;
    },
  };
  const document = {
    forms: Array.from({ length: settings.forms ?? 1 }, () => form),
    body: { innerText: settings.bodyText ?? "Contact form" },
    querySelector(selector: string) {
      assert.equal(selector, "iframe,frame");
      return settings.frame ? {} : null;
    },
    querySelectorAll(selector: string) {
      if (selector.startsWith("[contenteditable]"))
        return settings.widgets ?? [];
      if (selector === "input,select,textarea,button,a[href]")
        return [...fields, ...(settings.outsideControls ?? [])];
      if (selector === "#contact")
        return Array.from({ length: settings.targets ?? 1 }, () => form);
      if (selector === '[role="status"],[role="alert"],output')
        return settings.feedback ?? [];
      throw Error(`Unexpected query selector: ${selector}`);
    },
    getElementById: (id: string) => settings.ids?.[id] ?? null,
    createTreeWalker: () => walker,
  };
  const value = vm.runInNewContext(`(${nativeFormScript})()`, {
    document,
    CSS: { escape: (id: string) => id },
    NodeFilter: { SHOW_TEXT: 4 },
    location: { href: "http://fixture/" },
  });
  return JSON.parse(JSON.stringify(value));
}

function form(value: ReturnType<typeof observe>): NativeForm {
  assert.ok("fields" in value, JSON.stringify(value));
  return value;
}

test("raw extraction preserves label precedence, descriptions, group, outside instructions and feedback", () => {
  const fieldset = {
    querySelector: () => ({ textContent: "Personal details" }),
  };
  const named = element({
    attributes: {
      "aria-labelledby": "first second",
      "aria-label": "Ignored aria label",
      "aria-describedby": "help missing",
    },
    ancestors: { fieldset },
    required: true,
    validationMessage: "Required",
  });
  const aria = element({
    id: "aria",
    attributes: { "aria-label": "Aria name" },
  });
  const nativeLabel = element({
    id: "native",
    labels: [{ textContent: " Native\n label " }],
  });
  const visibleText = element({ tagName: "P" });
  const skippedText = element({
    tagName: "P",
    ancestors: { "aside article,nav,footer,script,style,noscript": {} },
  });
  const result = form(
    observe([named, aria, nativeLabel], {
      ids: {
        first: { textContent: "Legal" },
        second: { textContent: " name " },
        help: { textContent: "Use passport" },
      },
      textNodes: [
        { parentElement: visibleText, textContent: " Read\n this " },
        { parentElement: named, textContent: "inside form" },
        { parentElement: skippedText, textContent: "navigation" },
      ],
      feedback: [element({ textContent: " Saved\n successfully " })],
    }),
  );
  assert.equal(result.target, "#contact");
  assert.deepEqual(
    result.fields.map((field) => field.label),
    ["Legal name", "Aria name", "Native label"],
  );
  assert.equal(result.fields[0].group, "Personal details");
  assert.equal(result.fields[0].help, "Use passport ");
  assert.equal(result.fields[0].validationMessage, "Required");
  assert.equal(result.fields[0].required, true);
  assert.deepEqual(result.outside, ["Read this"]);
  assert.deepEqual(result.feedback, ["Saved successfully"]);
  assert.match(result.fingerprint, /^\d+:[a-f0-9]+$/);
  assert.equal(form(observe()).fingerprint, form(observe()).fingerprint);
  assert.notEqual(
    form(observe()).fingerprint,
    form(observe([element()], { bodyText: "Changed" })).fingerprint,
  );
});

test("raw extraction keeps date constraints as strings and checkbox/select disabled state", () => {
  const date = element({
    type: "date",
    value: "2020-01-01",
    readOnly: true,
    attributes: { min: "1990-01-01", max: "2024-12-31", step: "1" },
  });
  const checkbox = element({
    id: "consent",
    type: "checkbox",
    checked: true,
    disabled: true,
  });
  const select = element({
    id: "plan",
    tagName: "SELECT",
    type: "select-one",
    value: "biz",
    options: [
      { label: "Business", value: "biz", disabled: false, closest: () => null },
      {
        label: "Blocked",
        value: "blocked",
        disabled: true,
        closest: () => null,
      },
      {
        label: "Group blocked",
        value: "group",
        disabled: false,
        closest: () => ({}),
      },
    ],
  });
  const result = form(observe([date, checkbox, select]));
  assert.deepEqual(result.fields[0].constraints, {
    min: "1990-01-01",
    max: "2024-12-31",
    step: "1",
  });
  assert.equal(result.fields[0].readonly, true);
  assert.equal(result.fields[1].role, "checkbox");
  assert.equal(result.fields[1].value, true);
  assert.equal(result.fields[1].disabled, true);
  assert.equal(result.fields[2].role, "combobox");
  assert.deepEqual(result.fields[2].options, [
    { label: "Business", value: "biz", disabled: false },
    { label: "Blocked", value: "blocked", disabled: true },
    { label: "Group blocked", value: "group", disabled: true },
  ]);
});

test("raw extraction skips hidden/action controls and retains native role mapping", () => {
  const fields = [
    element({ type: "hidden" }),
    element({ type: "submit" }),
    element({ checkVisibility: () => false }),
    element({ type: "file" }),
    element({ type: "number" }),
    element({ type: "range" }),
    element({ type: "radio" }),
    element({ tagName: "TEXTAREA", type: "textarea" }),
  ];
  assert.deepEqual(
    form(observe(fields)).fields.map((field) => field.role),
    ["button", "spinbutton", "slider", "radio", "textbox"],
  );
});

test("raw extraction conservatively falls back for unsupported forms and controls", () => {
  const cases: Array<
    [ReturnType<typeof element>[], Parameters<typeof observe>[1], string]
  > = [
    [[element()], { frame: true }, "frames"],
    [[element()], { forms: 2 }, "expected one visible native form"],
    [[element()], { targets: 2 }, "ambiguous form target"],
    [[element()], { widgets: [element({ tagName: "DIV" })] }, "custom widget"],
    [
      [element()],
      { outsideControls: [element()] },
      "interactive control outside form",
    ],
    [[element({ multiple: true })], {}, "unsupported native control"],
    [
      [element({ attributes: { role: "textbox" } })],
      {},
      "unsupported native control",
    ],
    [
      [element({ attributes: { "aria-labelledby": "missing" } })],
      {},
      "missing accessible label",
    ],
    [[element({ labels: [] })], {}, "unlabelled control"],
    [[], {}, "no native fields"],
  ];
  for (const [fields, settings, reason] of cases) {
    assert.deepEqual(observe(fields, settings), { fallback: reason });
  }
});
