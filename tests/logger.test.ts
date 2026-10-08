import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Logger, configureLogger, logger, reportError } from "../src/logger.js";

function capture(t: TestContext) {
  let stdout = "",
    stderr = "";
  t.mock.method(process.stdout, "write", (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  t.mock.method(process.stderr, "write", (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

test("quiet logging persists every level and only explicitly shows concise progress", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "prowl-logger-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = join(directory, "nested", "agent.log");
  const output = capture(t);
  const log = new Logger({ filePath });
  assert.equal(existsSync(filePath), false);
  log.debug("Details", { data: { response: "private-payload" } });
  log.info("Waiting for model", { console: true, data: "hidden-detail" });
  log.warn("Warning");
  log.error("Failed", { console: true, data: new Error("hidden-stack") });
  const records = readFileSync(log.filePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
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

test("each logger run gets a separate file and preserves previous logs", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "prowl-verbose-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = join(directory, "agent.log");
  writeFileSync(filePath, "Legacy log\n");
  const output = capture(t);
  const earlier = new Logger({ filePath });
  earlier.info("Earlier entry");
  const log = new Logger({ filePath, verbose: true });
  log.debug("Response", { data: { payload: "detailed-value" } });
  log.warn("Slow", { data: { elapsed: 50 } });
  assert.match(output.stdout, /Response.*detailed-value/s);
  assert.match(output.stderr, /Slow.*50/s);
  assert.notEqual(earlier.filePath, log.filePath);
  assert.match(log.filePath, /agent-\d{4}-\d{2}-\d{2}T.*\.log$/);
  assert.equal(readFileSync(filePath, "utf8"), "Legacy log\n");
  assert.equal(
    readFileSync(earlier.filePath, "utf8").trim().split("\n").length,
    1,
  );
  assert.equal(readFileSync(log.filePath, "utf8").trim().split("\n").length, 2);
});

test("records safely serialize multiline strings, circular data, bigint and errors", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "prowl-serialize-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
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
  const directory = mkdtempSync(join(tmpdir(), "prowl-config-"));
  const original = process.env.LOG_FILE;
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
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
  const directory = mkdtempSync(join(tmpdir(), "prowl-new-run-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
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
  const directory = mkdtempSync(join(tmpdir(), "prowl-log-collision-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  capture(t);
  const log = new Logger({ filePath: join(directory, "agent.log") });
  writeFileSync(log.filePath, "Existing run\n");
  assert.throws(() => log.info("New run"), /Unable to write log file/);
  assert.equal(readFileSync(log.filePath, "utf8"), "Existing run\n");
});

test("an unwritable destination fails visibly once without recursive reporting", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "prowl-log-error-"));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    configureLogger();
  });
  const blocked = join(directory, "file");
  writeFileSync(blocked, "not a directory");
  const output = capture(t);
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
