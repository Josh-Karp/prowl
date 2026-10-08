import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

for (const scenario of [
  { name: "HUSKY=0", env: { HUSKY: "0" }, git: true, husky: true },
  { name: "CI", env: { CI: "true" }, git: true, husky: true },
  {
    name: "production",
    env: { NODE_ENV: "production" },
    git: true,
    husky: true,
  },
  { name: "no Git checkout", env: {}, git: false, husky: true },
  { name: "no local Husky", env: {}, git: true, husky: false },
]) {
  test(`prepare skips hook setup with ${scenario.name}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "prowl-prepare-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, "scripts"));
    copyFileSync(
      resolve("scripts/prepare.mjs"),
      join(directory, "scripts/prepare.mjs"),
    );
    if (scenario.git) {
      const init = spawnSync("git", ["init", "--quiet", directory]);
      assert.equal(init.status, 0);
    }
    if (scenario.husky) {
      symlinkSync(
        resolve("node_modules"),
        join(directory, "node_modules"),
        "dir",
      );
    }
    const result = spawnSync(process.execPath, ["scripts/prepare.mjs"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        HUSKY: undefined,
        CI: undefined,
        NODE_ENV: undefined,
        ...scenario.env,
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout + result.stderr, "");
    assert.equal(existsSync(join(directory, ".husky")), false);
    if (scenario.git) {
      const config = spawnSync("git", ["config", "--local", "core.hooksPath"], {
        cwd: directory,
      });
      assert.equal(config.status, 1);
    }
  });
}
