import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** Owns only the directory associated with this invocation's unique log path. */
export class ContextArtifacts {
  readonly directory: string;
  private sequence = 0;
  private historyCreated = false;
  constructor(logPath: string) {
    this.directory = logPath + ".artifacts";
  }
  snapshot(value: unknown): void {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(
      join(
        this.directory,
        `snapshot-${String(++this.sequence).padStart(4, "0")}.json`,
      ),
      JSON.stringify(value, null, 2) + "\n",
      { flag: "wx" },
    );
  }
  history(value: unknown): void {
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(
      join(this.directory, "history.jsonl"),
      JSON.stringify(value) + "\n",
      { flag: this.historyCreated ? "a" : "ax" },
    );
    this.historyCreated = true;
  }
}
