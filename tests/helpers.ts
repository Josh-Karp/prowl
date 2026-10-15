import type { TestContext } from "node:test";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function temporaryDirectory(t: TestContext, prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function readJsonLines(path: string) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

export function captureOutput(t: TestContext) {
  let stdout = "",
    stderr = "";
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    // The isolated Node test runner sends binary events over stdout.
    if (typeof chunk !== "string") return write(chunk);
    stdout += chunk;
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
