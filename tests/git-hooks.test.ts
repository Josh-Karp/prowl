import type { TestContext } from "node:test";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "#tests/helpers.js";

function repository(t: TestContext) {
  const directory = temporaryDirectory(t, "prowl-hooks-");
  mkdirSync(join(directory, ".husky"));
  mkdirSync(join(directory, "scripts"));
  for (const path of [
    "package.json",
    ".gitignore",
    ".prettierignore",
    "eslint.config.mjs",
    "commitlint.config.js",
    ".husky/pre-commit",
    ".husky/commit-msg",
    "scripts/clean-commit-message.mjs",
    "scripts/prepare.mjs",
  ]) {
    copyFileSync(resolve(path), join(directory, path));
  }
  symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "dir");
  const env = {
    ...process.env,
    HUSKY: "1",
    CI: undefined,
    NODE_ENV: undefined,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Hook Test",
    GIT_AUTHOR_EMAIL: "hook@example.com",
    GIT_COMMITTER_NAME: "Hook Test",
    GIT_COMMITTER_EMAIL: "hook@example.com",
  };
  function run(command: string, args: string[]) {
    return spawnSync(command, args, {
      cwd: directory,
      encoding: "utf8",
      env,
      timeout: 20_000,
    });
  }
  function git(...args: string[]) {
    const result = run("git", args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  }
  git("init", "--quiet");
  const install = run(process.execPath, ["scripts/prepare.mjs"]);
  assert.equal(install.status, 0, install.stderr);
  return { directory, run, git };
}

test("actual initial commit formats spaced filenames, fixes lint and removes only AI attribution", (t) => {
  const { directory, git } = repository(t);
  writeFileSync(
    join(directory, "spaced name.js"),
    "export function valid(value){return !!value ? true : false}\n",
  );
  git("add", "spaced name.js");
  git(
    "commit",
    "-m",
    "feat(form)!: improve form\n\nCo-authored-by: Claude <noreply@anthropic.com>\nCo-authored-by: Human <human@example.com>",
  );
  const source = git("show", "HEAD:spaced name.js");
  assert.match(source, /return value \? true : false;/);
  assert.equal(source, readFileSync(join(directory, "spaced name.js"), "utf8"));
  const message = git("log", "-1", "--format=%B");
  assert.match(message, /^feat\(form\)!: improve form/);
  assert.doesNotMatch(message, /Claude/);
  assert.match(message, /Co-authored-by: Human/);
});

test("actual commit keeps unstaged hunks out of the commit", (t) => {
  const { directory, git } = repository(t);
  const path = join(directory, "partial.js");
  writeFileSync(path, "export const value = 1;\n");
  git("add", "partial.js");
  git("commit", "-m", "test: add initial fixture");
  writeFileSync(path, "export const value=2\n");
  git("add", "partial.js");
  writeFileSync(path, "export const value=2\n\nexport const draft = 3;\n");
  git("commit", "-m", "fix: update value");
  assert.equal(git("show", "HEAD:partial.js"), "export const value = 2;\n");
  assert.match(readFileSync(path, "utf8"), /draft = 3/);
  assert.match(git("diff", "--", "partial.js"), /draft = 3/);
});

test("actual commit rejects unresolved lint errors", (t) => {
  const { directory, run, git } = repository(t);
  writeFileSync(join(directory, "invalid.js"), "const unused = 1;\n");
  git("add", "invalid.js");
  const result = run("git", ["commit", "-m", "test: reject lint errors"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /no-unused-vars/);
  assert.notEqual(run("git", ["rev-parse", "--verify", "HEAD"]).status, 0);
});

test("actual commit rejects malformed messages and default ignored merge subjects", (t) => {
  const { directory, run, git } = repository(t);
  writeFileSync(join(directory, "fixture.txt"), "fixture\n");
  git("add", "fixture.txt");
  for (const message of [
    "Update fixture",
    "unknown: update fixture",
    "Merge branch 'feature'",
  ]) {
    const result = run("git", ["commit", "-m", message]);
    assert.notEqual(result.status, 0, message);
    assert.match(result.stdout + result.stderr, /type-(?:empty|enum)/);
    assert.notEqual(run("git", ["rev-parse", "--verify", "HEAD"]).status, 0);
  }
});
