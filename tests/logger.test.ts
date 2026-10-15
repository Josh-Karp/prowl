import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { Logger, configureLogger, logger, reportError } from "#logger.js";
import { ContextArtifacts } from "#agent/context/artifacts.js";
import {
  temporaryDirectory,
  readJsonLines,
  captureOutput,
} from "#tests/helpers.js";

test("each run keeps its log, history and snapshots together in one folder", (t) => {
  const directory = temporaryDirectory(t, "prowl-run-folder-");
  const paths: string[] = [];
  for (const value of ["first", "second"]) {
    const log = new Logger({ filePath: join(directory, "custom.log") });
    const runDirectory = dirname(log.filePath);
    assert.equal(dirname(runDirectory), directory);
    assert.match(basename(runDirectory), /^custom-\d{4}-\d{2}-\d{2}T/);
    assert.equal(basename(log.filePath), "custom.log");
    assert.equal(existsSync(runDirectory), false);
    log.info(value);
    const artifacts = new ContextArtifacts(log.filePath);
    artifacts.history({ value });
    artifacts.snapshot({ value });
    assert.deepEqual(readdirSync(runDirectory).sort(), [
      "custom.log",
      "history.jsonl",
      "snapshot-0001.json",
    ]);
    assert.equal(
      JSON.parse(readFileSync(join(runDirectory, "history.jsonl"), "utf8"))
        .value,
      value,
    );
    paths.push(log.filePath);
  }
  assert.notEqual(dirname(paths[0]), dirname(paths[1]));
  assert.match(readFileSync(paths[0], "utf8"), /first/);
  assert.doesNotMatch(readFileSync(paths[0], "utf8"), /second/);
});

test("quiet logging persists every level and only explicitly shows concise progress", (t) => {
  const directory = temporaryDirectory(t, "prowl-logger-");
  const filePath = join(directory, "nested", "agent.log");
  const output = captureOutput(t);
  const log = new Logger({ filePath });
  assert.equal(existsSync(filePath), false);
  log.debug("Details", { data: { response: "private-payload" } });
  log.info("Waiting for model", { console: true, data: "hidden-detail" });
  log.warn("Warning");
  log.error("Failed", { console: true, data: new Error("hidden-stack") });
  const records = readJsonLines(log.filePath);
  assert.deepEqual(
    records.map((record) => record.level),
    ["debug", "info", "warn", "error"],
  );
  assert.ok(
    records.every((record) => !Number.isNaN(Date.parse(record.timestamp))),
  );
  assert.equal(records[0].data.response, "private-payload");
  assert.match(records[3].data.stack, /hidden-stack/);
  assert.match(output.stdout, /Waiting for model/);
  assert.doesNotMatch(output.stdout, /Details|hidden-detail|private-payload/);
  assert.match(output.stderr, /Failed/);
  assert.doesNotMatch(output.stderr, /hidden-stack|Warning/);
});

test("console-only entries never create or append to a log file", (t) => {
  const directory = temporaryDirectory(t, "prowl-console-only-");
  const output = captureOutput(t);
  const log = new Logger({ filePath: join(directory, "nested", "agent.log") });
  log.info("Console only", { console: true, persist: false });
  assert.equal(output.stdout, "[info] Console only\n");
  assert.equal(existsSync(join(directory, "nested")), false);
  log.info("Saved entry");
  const contents = readFileSync(log.filePath, "utf8");
  log.warn("Console warning", { console: true, persist: false });
  assert.equal(output.stderr, "[warn] Console warning\n");
  assert.equal(readFileSync(log.filePath, "utf8"), contents);
});

test("console-only logging works even after a file write failure", (t) => {
  const directory = temporaryDirectory(t, "prowl-console-error-");
  const blocked = join(directory, "file");
  writeFileSync(blocked, "not a directory");
  const output = captureOutput(t);
  const log = new Logger({
    filePath: join(blocked, "agent.log"),
    verbose: true,
  });
  assert.throws(() => log.info("Cannot write"), /Unable to write log file/);
  log.error("Console error", {
    console: true,
    persist: false,
    data: { detail: "visible" },
  });
  assert.match(output.stderr, /\[error\] Console error\n.*visible/s);
});

test("each logger run gets a separate file and preserves previous logs", (t) => {
  const directory = temporaryDirectory(t, "prowl-verbose-");
  const filePath = join(directory, "agent.log");
  writeFileSync(filePath, "Legacy log\n");
  const output = captureOutput(t);
  const earlier = new Logger({ filePath });
  earlier.info("Earlier entry");
  const log = new Logger({ filePath, verbose: true });
  log.debug("Response", { data: { payload: "detailed-value" } });
  log.warn("Slow", { data: { elapsed: 50 } });
  assert.match(output.stdout, /Response.*detailed-value/s);
  assert.match(output.stderr, /Slow.*50/s);
  assert.notEqual(earlier.filePath, log.filePath);
  assert.match(dirname(log.filePath), /agent-\d{4}-\d{2}-\d{2}T/);
  assert.equal(basename(log.filePath), "agent.log");
  assert.equal(readFileSync(filePath, "utf8"), "Legacy log\n");
  assert.equal(
    readFileSync(earlier.filePath, "utf8").trim().split("\n").length,
    1,
  );
  assert.equal(readFileSync(log.filePath, "utf8").trim().split("\n").length, 2);
});

test("records safely serialize multiline strings, circular data, bigint and errors", (t) => {
  const directory = temporaryDirectory(t, "prowl-serialize-");
  const filePath = join(directory, "agent.log");
  const data: Record<string, unknown> = {
    text: "one\ntwo",
    count: 10n,
    error: new Error("oops"),
  };
  data.self = data;
  const log = new Logger({ filePath });
  log.info("Data", { data });
  const lines = readFileSync(log.filePath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.data.text, "one\ntwo");
  assert.equal(record.data.count, "10");
  assert.equal(record.data.self, "[Circular]");
  assert.match(record.data.error.stack, /oops/);
});

test("configuration uses LOG_FILE while an explicit path takes precedence", (t) => {
  const directory = temporaryDirectory(t, "prowl-config-");
  const original = process.env.LOG_FILE;
  t.after(() => {
    if (original === undefined) delete process.env.LOG_FILE;
    else process.env.LOG_FILE = original;
    configureLogger();
  });
  process.env.LOG_FILE = join(directory, "environment.log");
  configureLogger();
  const environmentPath = logger.filePath;
  logger.info("Environment");
  configureLogger({ filePath: join(directory, "explicit.log") });
  const explicitPath = logger.filePath;
  logger.info("CLI");
  assert.ok(environmentPath.startsWith(join(directory, "environment-")));
  assert.ok(explicitPath.startsWith(join(directory, "explicit-")));
  assert.match(readFileSync(environmentPath, "utf8"), /Environment/);
  assert.match(readFileSync(explicitPath, "utf8"), /CLI/);
});

test("reconfiguring starts a new run and never appends to the preceding run", (t) => {
  const directory = temporaryDirectory(t, "prowl-new-run-");
  const options = { filePath: join(directory, "agent") };
  const log = new Logger(options);
  const firstPath = log.filePath;
  assert.equal(existsSync(firstPath), false);
  log.info("First run");
  const firstContents = readFileSync(firstPath, "utf8");
  log.configure(options);
  assert.notEqual(log.filePath, firstPath);
  assert.ok(log.filePath.endsWith(".log"));
  assert.equal(existsSync(log.filePath), false);
  log.info("Second run");
  assert.equal(readFileSync(firstPath, "utf8"), firstContents);
  assert.match(readFileSync(log.filePath, "utf8"), /Second run/);
});

test("an existing generated filename is never overwritten or appended to", (t) => {
  const directory = temporaryDirectory(t, "prowl-log-collision-");
  captureOutput(t);
  const log = new Logger({ filePath: join(directory, "agent.log") });
  mkdirSync(dirname(log.filePath), { recursive: true });
  writeFileSync(log.filePath, "Existing run\n");
  assert.throws(() => log.info("New run"), /Unable to write log file/);
  assert.equal(readFileSync(log.filePath, "utf8"), "Existing run\n");
});

test("an unwritable destination fails visibly once without recursive reporting", (t) => {
  const directory = temporaryDirectory(t, "prowl-log-error-");
  t.after(() => configureLogger());
  const blocked = join(directory, "file");
  writeFileSync(blocked, "not a directory");
  const output = captureOutput(t);
  configureLogger({ filePath: join(blocked, "agent.log") });
  let failure: unknown;
  try {
    logger.info("Cannot write");
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  reportError(failure);
  assert.match(output.stderr, /Unable to write log file/);
  assert.equal(output.stderr.trim().split("\n").length, 1);
});

test("context artifacts create files lazily, append history and number snapshots", (t) => {
  const directory = temporaryDirectory(t, "prowl-artifact-writes-");
  const runDirectory = join(directory, "run");
  const artifacts = new ContextArtifacts(join(runDirectory, "custom.log"));
  assert.equal(artifacts.directory, runDirectory);
  assert.equal(existsSync(runDirectory), false);
  artifacts.history({ turn: 1, content: "first\nreceipt" });
  artifacts.history({ turn: 2, content: "second receipt" });
  artifacts.snapshot({ ref: "e1" });
  artifacts.snapshot({ ref: "e2" });
  assert.deepEqual(readdirSync(runDirectory).sort(), [
    "history.jsonl",
    "snapshot-0001.json",
    "snapshot-0002.json",
  ]);
  assert.deepEqual(readJsonLines(join(runDirectory, "history.jsonl")), [
    { turn: 1, content: "first\nreceipt" },
    { turn: 2, content: "second receipt" },
  ]);
  for (const [filename, expected] of [
    ["snapshot-0001.json", { ref: "e1" }],
    ["snapshot-0002.json", { ref: "e2" }],
  ] as const) {
    assert.deepEqual(
      JSON.parse(readFileSync(join(runDirectory, filename), "utf8")),
      expected,
    );
  }
});

test("context artifacts preserve existing history and snapshots on collisions", (t) => {
  const directory = temporaryDirectory(t, "prowl-artifact-collisions-");
  const logPath = join(directory, "custom.log");
  const first = new ContextArtifacts(logPath);
  first.history({ content: "original history" });
  first.snapshot({ content: "original snapshot" });
  const second = new ContextArtifacts(logPath);
  assert.throws(() => second.history({ content: "replacement" }), {
    code: "EEXIST",
  });
  assert.throws(() => second.snapshot({ content: "replacement" }), {
    code: "EEXIST",
  });
  assert.deepEqual(
    JSON.parse(readFileSync(join(directory, "history.jsonl"), "utf8")),
    { content: "original history" },
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(directory, "snapshot-0001.json"), "utf8")),
    { content: "original snapshot" },
  );
});
