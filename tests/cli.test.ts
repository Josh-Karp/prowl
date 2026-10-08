import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test, { type TestContext } from "node:test";

function temporaryDirectory(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "prowl-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(entry: string, args: string[], logFile: string) {
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, LOG_FILE: logFile, MAX_ITERATIONS: "0" },
  });
}

function logs(basePath: string) {
  const { name, ext } = parse(basePath);
  return readdirSync(dirname(basePath))
    .filter(
      (file) => file.startsWith(`${name}-`) && file.endsWith(ext || ".log"),
    )
    .map((file) => join(dirname(basePath), file));
}

function singleLog(basePath: string) {
  const paths = logs(basePath);
  assert.equal(paths.length, 1);
  return paths[0];
}

test("CLI logs a failure once, quietly, with CLI path overriding LOG_FILE", (t) => {
  const directory = temporaryDirectory(t);
  const filePath = join(directory, "cli.log");
  const environmentPath = join(directory, "env.log");
  const result = run(
    "src/cli.ts",
    ["run", "--max-iterations", "0", "--log-file", filePath],
    environmentPath,
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "[error] maxIterations must be a positive integer.\n",
  );
  assert.equal(existsSync(environmentPath), false);
  assert.equal(logs(environmentPath).length, 0);
  const record = JSON.parse(readFileSync(singleLog(filePath), "utf8").trim());
  assert.equal(record.level, "error");
  assert.match(record.data.stack, /_validateOptions/);
});

test("verbose CLI errors include details while dev uses the environment path", (t) => {
  const directory = temporaryDirectory(t);
  const filePath = join(directory, "verbose.log");
  const verbose = run(
    "src/cli.ts",
    ["run", "--verbose", "--max-iterations", "0"],
    filePath,
  );
  assert.equal(verbose.status, 1);
  assert.match(verbose.stderr, /_validateOptions/);
  assert.match(readFileSync(singleLog(filePath), "utf8"), /maxIterations/);
  const devPath = join(directory, "dev.log");
  const dev = run("src/index.ts", [], devPath);
  assert.equal(dev.status, 1);
  assert.equal(
    dev.stderr,
    "[error] maxIterations must be a positive integer.\n",
  );
  assert.match(readFileSync(singleLog(devPath), "utf8"), /_validateOptions/);
});

test("help exposes logging flags without creating a log", (t) => {
  const filePath = join(temporaryDirectory(t), "help.log");
  for (const args of [
    ["--log-file", filePath, "--help"],
    ["run", "--help"],
  ]) {
    const result = run("src/cli.ts", args, filePath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: prowl/);
    if (args.includes("--log-file")) assert.match(result.stdout, /--verbose/);
  }
  assert.equal(existsSync(filePath), false);
  assert.deepEqual(readdirSync(dirname(filePath)), []);
});

test("repeated CLI invocations retain separate run logs", (t) => {
  const basePath = join(temporaryDirectory(t), "agent.log");
  assert.equal(run("src/cli.ts", ["run"], basePath).status, 1);
  const firstPath = singleLog(basePath);
  const firstContents = readFileSync(firstPath, "utf8");
  assert.equal(run("src/cli.ts", ["run"], basePath).status, 1);
  const paths = logs(basePath);
  assert.equal(paths.length, 2);
  assert.equal(readFileSync(firstPath, "utf8"), firstContents);
  for (const path of paths) {
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
  }
});

test("an invalid log destination fails clearly without an uncaught stack", (t) => {
  const directory = temporaryDirectory(t);
  const blocked = join(directory, "blocked");
  writeFileSync(blocked, "not a directory");
  const result = run("src/cli.ts", ["run"], join(blocked, "agent.log"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to write log file/);
  assert.equal(result.stderr.trim().split("\n").length, 1);
});

test("gitignore covers default and custom logs", (t) => {
  const directory = temporaryDirectory(t);
  writeFileSync(join(directory, ".gitignore"), readFileSync(".gitignore"));
  const init = spawnSync("git", ["init", "--quiet", directory], {
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  const result = spawnSync(
    "git",
    ["check-ignore", "logs/prowl.log", "nested/custom.log", "src/logger.ts"],
    {
      cwd: directory,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "logs/prowl.log",
    "nested/custom.log",
  ]);
});
