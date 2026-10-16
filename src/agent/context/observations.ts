import type {
  CallToolResult as BrowserResult,
  ContentBlock,
  TextContent,
  Tool,
} from "@modelcontextprotocol/client";
import type { NativeField, NativeForm } from "#agent/context/nativeForm.js";

import {
  nativeFormSchema,
  nativeFormScript,
} from "#agent/context/nativeForm.js";

export interface BrowserClient {
  callTool(call: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<BrowserResult>;
}

export interface ContextEvent {
  kind: "observation";
  originalBytes: number;
  returnedBytes: number;
  reduced: boolean;
  reason: string;
}

interface BrowserContextOptions {
  capabilities: Tool[];
  onEvent?: (event: ContextEvent) => void;
  onArchive?: (value: BrowserResult) => void;
}

type ReductionAttempt =
  { reduced: true; result: BrowserResult } | { reduced: false; reason: string };

function isTextContent(value: ContentBlock): value is TextContent {
  return (
    !!value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

/** Mixed or malformed content is conservatively passed through by the reducer. */
function readTextContent(result: BrowserResult): TextContent[] | null {
  if (!Array.isArray(result.content) || !result.content.length) return null;
  const content = result.content.filter(isTextContent);
  return content.length === result.content.length ? content : null;
}

// The supported Playwright output has one fenced YAML snapshot section.
const SNAPSHOT_PATTERN = /### Snapshot\s*\n```ya?ml\n([\s\S]*?)\n```/g;

function parseSnapshot(
  result: BrowserResult,
): { content: TextContent[]; tree: string } | null {
  const content = readTextContent(result);
  if (!content || result.isError) return null;
  const matches = content.flatMap((item) => [
    ...item.text.matchAll(SNAPSHOT_PATTERN),
  ]);
  return matches.length === 1 ? { content, tree: matches[0][1] } : null;
}

export function hasPageSnapshot(result: BrowserResult): boolean {
  return parseSnapshot(result) !== null;
}

function parseNativeFormResult(result: BrowserResult): NativeForm | null {
  if (result.isError) return null;
  const match = readTextContent(result)
    ?.map((item) => item.text)
    .join("\n")
    .match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    const parsed = nativeFormSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function attachFieldRefs(
  fields: NativeField[],
  tree: string,
): NativeField[] | null {
  const refs: Array<{ role: string; label: string; ref: string }> = [];
  for (const line of tree.split("\n")) {
    const match = line.match(
      /^\s*- ([\w-]+) ("(?:[^"\\]|\\.)*")(?=\s|:|$).*?\[ref=([^\]]+)\]/,
    );
    if (!match) continue;
    try {
      refs.push({ role: match[1], label: JSON.parse(match[2]), ref: match[3] });
    } catch {
      return null;
    }
  }

  const mapped: NativeField[] = [];
  for (const field of fields) {
    const matches = refs.filter(
      (ref) => ref.role === field.role && ref.label === field.label,
    );
    if (
      matches.length !== 1 ||
      mapped.some((previous) => previous.ref === matches[0].ref)
    )
      return null;
    mapped.push({ ...field, ref: matches[0].ref });
  }

  return mapped;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function replaceSnapshot(
  result: BrowserResult,
  content: TextContent[],
  replacement: string,
): BrowserResult {
  return {
    ...result,
    content: content.map((item) => ({
      ...item,
      text: item.text.replace(SNAPSHOT_PATTERN, () => replacement),
    })),
  };
}

function mergeFreshSnapshot(
  original: BrowserResult,
  originalContent: TextContent[],
  fresh: BrowserResult,
): BrowserResult {
  // An action receipt may survive a refresh; its page evidence and refs may not.
  const receipts = originalContent.flatMap((item) => {
    const text = item.text
      .replace(SNAPSHOT_PATTERN, "")
      .replace(/### Page\s*\n[\s\S]*?(?=\n### |$)/g, "")
      .trim();
    return text
      ? [{ ...item, text: "### Original action receipt\n" + text }]
      : [];
  });
  return {
    ...original,
    ...fresh,
    content: [
      ...(Array.isArray(fresh.content) ? fresh.content : []),
      ...receipts,
    ],
  };
}

const MIN_SNAPSHOT_BYTES = 8 * 1024;

const MIN_SAVINGS_BYTES = 2 * 1024;

const MIN_SAVINGS_RATIO = 0.25;

const SNAPSHOT_CUSTOMIZATIONS = ["target", "depth", "boxes", "filename"];

function supportsReduction(capabilities: Tool[]): boolean {
  const schema = capabilities.find(
    (tool) => tool.name === "browser_snapshot",
  )?.inputSchema;
  if (!schema || typeof schema !== "object" || !("properties" in schema))
    return false;
  const properties = schema.properties;
  return (
    !!properties &&
    typeof properties === "object" &&
    "target" in properties &&
    !!properties.target &&
    capabilities.some((tool) => tool.name === "browser_evaluate")
  );
}

export class BrowserContext {
  private supported: boolean;

  constructor(
    private client: BrowserClient,
    private options: BrowserContextOptions,
  ) {
    this.supported = supportsReduction(options.capabilities);
  }

  async fullSnapshot(): Promise<BrowserResult> {
    const result = await this.client.callTool({
      name: "browser_snapshot",
      arguments: {},
    });
    this.options.onArchive?.(result);
    return result;
  }

  async reduce(
    name: string,
    args: Record<string, unknown>,
    original: BrowserResult,
  ): Promise<BrowserResult> {
    const snapshot = parseSnapshot(original);
    if (!snapshot) return original;
    const { content } = snapshot;
    const originalBytes = serializedBytes(original);
    if (
      originalBytes < MIN_SNAPSHOT_BYTES ||
      (name === "browser_snapshot" &&
        SNAPSHOT_CUSTOMIZATIONS.some((key) => Object.hasOwn(args, key)))
    )
      return original;
    if (!this.supported) {
      return this.record(
        original,
        originalBytes,
        false,
        "unsupported MCP capabilities",
      );
    }

    this.options.onArchive?.(original);
    const attempt = await this.tryReduce(original, content, originalBytes);
    if (attempt.reduced) {
      return this.record(
        attempt.result,
        originalBytes,
        true,
        "scoped native form",
      );
    }

    // Refresh outside the helper catch: failed refreshes must propagate, never reuse stale refs.
    const fresh = await this.fullSnapshot();
    const result = mergeFreshSnapshot(original, content, fresh);
    return this.record(result, originalBytes, false, attempt.reason);
  }

  private record(
    result: BrowserResult,
    originalBytes: number,
    reduced: boolean,
    reason: string,
  ): BrowserResult {
    this.options.onEvent?.({
      kind: "observation",
      originalBytes,
      returnedBytes: serializedBytes(result),
      reduced,
      reason,
    });
    return result;
  }

  private async observeForm(): Promise<NativeForm | null> {
    return parseNativeFormResult(
      await this.client.callTool({
        name: "browser_evaluate",
        arguments: { function: nativeFormScript },
      }),
    );
  }

  private async tryReduce(
    original: BrowserResult,
    content: TextContent[],
    originalBytes: number,
  ): Promise<ReductionAttempt> {
    try {
      const before = await this.observeForm();
      if (!before)
        return {
          reduced: false,
          reason: "unsupported or ambiguous native form",
        };

      const scoped = await this.client.callTool({
        name: "browser_snapshot",
        arguments: { target: before.target },
      });
      const tree = parseSnapshot(scoped)?.tree;
      const after = await this.observeForm();
      const fields = tree ? attachFieldRefs(before.fields, tree) : null;
      if (!after || JSON.stringify(after) !== JSON.stringify(before)) {
        return { reduced: false, reason: "page changed during extraction" };
      }
      if (!fields)
        return { reduced: false, reason: "ambiguous native control refs" };

      const metadata = {
        url: before.url,
        outside: before.outside,
        feedback: before.feedback,
        fields,
      };
      const replacement =
        "### Snapshot\n```yaml\n" +
        tree +
        "\n```\n### Native form metadata\n" +
        JSON.stringify(metadata);
      const result = replaceSnapshot(original, content, replacement);
      const saved = originalBytes - serializedBytes(result);
      if (
        saved < MIN_SAVINGS_BYTES ||
        saved < originalBytes * MIN_SAVINGS_RATIO
      ) {
        return { reduced: false, reason: "insufficient savings" };
      }
      return { reduced: true, result };
    } catch {
      // Conservative fallback for helper failures; the caller obtains a fresh observation.
      return { reduced: false, reason: "form extraction failed" };
    }
  }
}
