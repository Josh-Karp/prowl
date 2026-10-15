import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("development aliases resolve source and test fixtures without a build", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=development",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      String.raw`
        import assert from 'node:assert/strict';
        import { nativeFormSchema } from '#agent/context/nativeForm.js';
        import { native } from '#tests/fixtures/context.js';
        import { createRequire } from 'node:module';
        assert.equal(nativeFormSchema.safeParse(native).success, true);
        assert.match(import.meta.resolve('#logger.js'), /\/src\/logger\.ts$/);
        assert.equal(createRequire(import.meta.url)('#package.json').name, 'prowl');
      `,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
