import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, parse, resolve } from "node:path";
import { inspect } from "node:util";

interface LoggerOptions {
  filePath?: string;
  verbose?: boolean;
}
interface LogOptions {
  data?: unknown;
  console?: boolean;
}
type Level = "debug" | "info" | "warn" | "error";

class LogWriteError extends Error {}

function serialize(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (
      typeof item === "bigint" ||
      typeof item === "symbol" ||
      typeof item === "function"
    )
      return String(item);
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
      if (item instanceof Error)
        return {
          ...item,
          name: item.name,
          message: item.message,
          stack: item.stack,
          cause: item.cause,
        };
    }
    return item;
  });
}

export class Logger {
  private path = "";
  private verbose = false;
  private created = false;
  private failure?: LogWriteError;

  constructor(options: LoggerOptions = {}) {
    this.configure(options);
  }
  get filePath(): string {
    return this.path;
  }

  configure(options: LoggerOptions = {}): void {
    const { dir, name, ext } = parse(
      resolve(options.filePath ?? process.env.LOG_FILE ?? "logs/prowl.log"),
    );
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.path = join(
      dir,
      `${name}-${timestamp}-${randomUUID()}${ext || ".log"}`,
    );
    this.verbose = options.verbose ?? false;
    this.created = false;
    this.failure = undefined;
  }

  debug(message: string, options?: LogOptions): void {
    this.write("debug", message, options);
  }
  info(message: string, options?: LogOptions): void {
    this.write("info", message, options);
  }
  warn(message: string, options?: LogOptions): void {
    this.write("warn", message, options);
  }
  error(message: string, options?: LogOptions): void {
    this.write("error", message, options);
  }

  private write(level: Level, message: string, options: LogOptions = {}): void {
    if (this.failure) throw this.failure;
    const line = serialize({
      timestamp: new Date().toISOString(),
      level,
      message,
      data: options.data,
    });
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, line + "\n", {
        encoding: "utf8",
        flag: this.created ? "a" : "ax",
      });
      this.created = true;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.failure = new LogWriteError(
        `Unable to write log file ${this.path}: ${detail}`,
        { cause },
      );
      process.stderr.write(
        this.failure.message.replace(/[\r\n]+/g, " ") + "\n",
      );
      throw this.failure;
    }
    if (this.verbose || options.console) {
      const detail =
        this.verbose && options.data !== undefined
          ? "\n" +
            inspect(options.data, {
              depth: null,
              colors: false,
              maxArrayLength: null,
              maxStringLength: null,
            })
          : "";
      const output =
        level === "warn" || level === "error" ? process.stderr : process.stdout;
      output.write(`[${level}] ${message}${detail}\n`);
    }
  }
}

export const logger = new Logger();
export function configureLogger(options: LoggerOptions = {}): void {
  logger.configure(options);
}

/** Entry points report a failure once, without logging failures recursively. */
export function reportError(error: unknown): void {
  if (error instanceof LogWriteError) return;
  try {
    logger.error(error instanceof Error ? error.message : String(error), {
      data: error,
      console: true,
    });
  } catch (failure) {
    if (!(failure instanceof LogWriteError)) throw failure;
  }
}
