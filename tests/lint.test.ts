import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();

test("lint enforces type imports, value imports, then type declarations", async () => {
  const cases = [
    [
      'import type { Tool } from "pkg";\n\nimport { value } from "pkg";\nexport interface Options { tool: Tool }\nexport const result = value;',
      [],
    ],
    [
      'import { value } from "pkg";\nimport type { Tool } from "pkg";',
      ["order"],
    ],
    [
      'import type { Tool } from "pkg";\nimport { value } from "pkg";',
      ["blankLine"],
    ],
    [
      'import type { Tool } from "pkg";\n// A comment is not a blank line.\nexport type Options = Tool;',
      ["blankLine"],
    ],
    ["const value = 1;\nexport type Options = typeof value;", ["order"]],
    ["function run() {}\ninterface Options { enabled: boolean }", ["order"]],
    [
      "export type Options = typeof schema;\nexport const schema = { enabled: true };",
      [],
    ],
    [
      '#!/usr/bin/env node\nimport type * as Types from "pkg";\n\nimport "dotenv/config";\ninterface Options { value: Types.Value }',
      [],
    ],
    ['import type { Tool } from "pkg";\n\nexport type Options = Tool;', []],
  ] as const;

  for (const [code, expected] of cases) {
    const [result] = await eslint.lintText(code, {
      filePath: "src/example.ts",
    });
    assert.deepEqual(
      result.messages
        .filter((message) => message.ruleId === "local/type-order")
        .map((message) => message.messageId),
      expected,
      code,
    );
  }
});

test("lint fixes implicit type imports into separate import type declarations", async () => {
  const eslint = new ESLint({ fix: true });
  const [result] = await eslint.lintText(
    'import { Tool, value } from "pkg";\nimport { Other } from "other";\nexport type Options = Tool & Other;\nexport const result = value;',
    { filePath: "src/example.ts" },
  );
  assert.match(result.output!, /import type \{\s*Tool\s*\} from "pkg";/);
  assert.match(result.output!, /import type \{ Other \} from "other";/);
  assert.doesNotMatch(result.output!, /\{ type Tool/);
});

test("lint rejects inline type imports", async () => {
  const [result] = await eslint.lintText(
    'import { type Tool, value } from "pkg";\nexport type Options = Tool;\nexport const result = value;',
    { filePath: "src/example.ts" },
  );
  assert.ok(
    result.messages.some(
      (message) => message.ruleId === "no-restricted-syntax",
    ),
  );
});
