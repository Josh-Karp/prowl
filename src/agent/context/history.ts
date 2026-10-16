import type { OllamaMessage } from "#models/ollama.js";

export interface HistoryEvent {
  kind: "history" | "budget-exception";
  beforeBytes: number;
  afterBytes: number;
  archivedTurns: number;
  checkpoint: number;
}

interface HistoryOptions {
  budget: number;
  numCtx: number;
  onEvent?: (value: HistoryEvent) => void;
  onArchive?: (value: { id: number; messages: OllamaMessage[] }) => void;
}

interface Turn {
  id: number;
  messages: OllamaMessage[];
}

const size = (messages: OllamaMessage[]) =>
  Buffer.byteLength(JSON.stringify(messages));

const notice =
  "Historical refs must not be used for current interactions. Requested actions are distinct from observed results; no submission success is inferred. Retrieve a turn for its exact original evidence.";

function validateTurn(messages: OllamaMessage[]): void {
  const assistant = messages[0];
  const calls = assistant?.tool_calls ?? [];
  const pairedLength = calls.length + 1;
  // A no-tool turn may be followed by a recovery prompt when it was empty or its report was rejected.
  const recovery =
    calls.length === 0 && messages.length === 2 && messages[1].role === "user";

  if (
    assistant?.role !== "assistant" ||
    (!recovery && messages.length !== pairedLength) ||
    calls.some(
      (call, i) =>
        messages[i + 1]?.role !== "tool" ||
        messages[i + 1]?.tool_name !== call.function.name,
    )
  )
    throw new Error(
      "History requires complete, correctly paired assistant/tool turns.",
    );
}

function toolResult(message: OllamaMessage): Record<string, unknown> | null {
  if (message.role !== "tool") return null;
  try {
    const result = JSON.parse(message.content);
    return result && typeof result === "object" ? result : null;
  } catch {
    return null;
  }
}

function confirmationLines(text: string): string[] {
  const lines = text.split("\n");
  const selected = new Set<number>();
  const indent = (line: string) => line.match(/^\s*/)![0].length;
  for (const [index, line] of lines.entries()) {
    if (!/confirm|submitted|received|reference|\bDEMO-/i.test(line)) continue;
    selected.add(index);
    // Snapshots can render the value beside its label or in nested children.
    const next = index + 1;
    if (next >= lines.length) continue;
    const boundary = Math.min(indent(line), indent(lines[next]));
    for (let i = next; i < lines.length; i++) {
      if (/^\s*(?:###|```)/.test(lines[i])) break;
      if (i !== next && indent(lines[i]) <= boundary) break;
      selected.add(i);
    }
  }
  return lines.filter((_, index) => selected.has(index));
}

function confirmations(messages: OllamaMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.tool_name === "prowl_browser_history") return [];
    const content = toolResult(message)?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((item) =>
      item?.type === "text" && typeof item.text === "string"
        ? confirmationLines(item.text)
        : [],
    );
  });
}

function checkpointMessages(
  checkpoint: Record<string, unknown>,
): OllamaMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          function: {
            name: "prowl_browser_history",
            arguments: { checkpoint: checkpoint.checkpoint },
          },
        },
      ],
    },
    {
      role: "tool",
      tool_name: "prowl_browser_history",
      content: JSON.stringify(checkpoint),
    },
  ];
}

export class ConversationHistory {
  private readonly prefix: OllamaMessage[];
  private turns: Turn[] = [];
  private archive = new Map<number, OllamaMessage[]>();
  private checkpoints = new Map<number, Record<string, unknown>>();
  private version = 0;
  private nextId = 1;

  constructor(
    prefix: OllamaMessage[],
    private options: HistoryOptions,
  ) {
    this.prefix = structuredClone(prefix);
  }

  appendTurn(
    displayed: OllamaMessage[],
    original: OllamaMessage[] = displayed,
  ): void {
    validateTurn(displayed);
    validateTurn(original);
    if (
      displayed.length !== original.length ||
      displayed.some(
        (message, i) =>
          message.role !== original[i].role ||
          message.tool_name !== original[i].tool_name,
      )
    )
      throw new Error(
        "History requires matching displayed and original turn pairings.",
      );
    const id = this.nextId;
    const raw = structuredClone(original);
    this.options.onArchive?.({ id, messages: structuredClone(raw) });
    this.archive.set(id, raw);
    this.nextId++;
    const messages = structuredClone(displayed).map((message) => {
      delete message.thinking;
      return message;
    });
    this.turns.push({ id, messages });
  }

  retrieve(query: {
    turnId?: number;
    checkpoint?: number;
  }): Record<string, unknown> {
    if (query.checkpoint !== undefined) {
      const checkpoint = this.checkpoints.get(query.checkpoint);
      if (!checkpoint) throw new Error("Unknown history checkpoint.");
      return structuredClone(checkpoint);
    }
    if (query.turnId !== undefined) {
      const messages = this.archive.get(query.turnId);
      if (!messages) throw new Error("Unknown history turn.");
      return {
        notice,
        turnId: query.turnId,
        messages: structuredClone(messages),
      };
    }
    return {
      notice,
      turns: [...this.archive.keys()],
      checkpoint: this.version || null,
    };
  }

  private messages(
    turns = this.turns,
    checkpoint = this.checkpoints.get(this.version),
  ): OllamaMessage[] {
    return [
      ...this.prefix,
      ...(checkpoint ? checkpointMessages(checkpoint) : []),
      ...turns.flatMap((turn) => turn.messages),
    ];
  }

  private checkpoint(
    remaining: Turn[],
    removed: Turn[],
  ): Record<string, unknown> {
    const live = new Set(remaining.map((turn) => turn.id));
    const archived = [...this.archive.keys()].filter((id) => !live.has(id));
    const ranges: Array<[number, number]> = [];
    const archivedRequestedActionCounts: Record<string, number> =
      Object.create(null);

    for (const id of archived) {
      const last = ranges.at(-1);
      if (last && last[1] + 1 === id) last[1] = id;
      else ranges.push([id, id]);
      for (const call of this.archive.get(id)![0].tool_calls ?? []) {
        const name = call.function.name;
        archivedRequestedActionCounts[name] =
          (archivedRequestedActionCounts[name] ?? 0) + 1;
      }
    }
    return {
      notice,
      checkpoint: this.version + 1,
      archivedTurns: { count: archived.length, ranges },
      archivedRequestedActionCounts,
      literalConfirmationEvidence: [
        ...new Set([...this.archive.values()].flatMap(confirmations)),
      ],
      recentArchivedReceipts: removed.slice(-2).map((turn) => ({
        turnId: turn.id,
        requestedActions: turn.messages[0].tool_calls?.map((call) => ({
          name: call.function.name,
        })),
        results: turn.messages
          .filter((message) => message.role === "tool")
          .map((message) => ({ tool: message.tool_name })),
        evidence: `Retrieve turn ${turn.id} for exact arguments and execution receipts.`,
      })),
    };
  }

  prepare(previousPromptTokens?: number): OllamaMessage[] {
    const beforeBytes = size(this.messages());
    if (
      beforeBytes <= this.options.budget &&
      !(
        previousPromptTokens !== undefined &&
        previousPromptTokens >= this.options.numCtx * 0.8
      )
    )
      return structuredClone(this.messages());

    const protectedIds = new Set(this.turns.slice(-2).map((turn) => turn.id));
    const newestFirst = [...this.turns].reverse();
    const observation = newestFirst.find((turn) =>
      turn.messages.some(
        (message) =>
          message.role === "tool" &&
          message.tool_name !== "prowl_browser_history" &&
          /### Snapshot/.test(message.content),
      ),
    );
    const error = newestFirst.find((turn) =>
      turn.messages.some((message) => toolResult(message)?.isError === true),
    );
    if (observation) protectedIds.add(observation.id);
    if (error) protectedIds.add(error.id);

    const removed: Turn[] = [];
    let remaining = [...this.turns];
    let candidate: Record<string, unknown> | undefined;
    for (const turn of this.turns) {
      if (protectedIds.has(turn.id)) continue;
      removed.push(turn);
      remaining = remaining.filter((value) => value.id !== turn.id);
      candidate = this.checkpoint(remaining, removed);
      if (size(this.messages(remaining, candidate)) <= this.options.budget / 2)
        break;
    }
    if (candidate) {
      this.turns = remaining;
      this.checkpoints.set(++this.version, candidate);
      this.emit("history", beforeBytes);
    }
    if (size(this.messages()) > this.options.budget)
      this.emit("budget-exception", beforeBytes);
    return structuredClone(this.messages());
  }

  private emit(kind: HistoryEvent["kind"], beforeBytes: number): void {
    this.options.onEvent?.({
      kind,
      beforeBytes,
      afterBytes: size(this.messages()),
      archivedTurns: this.archive.size - this.turns.length,
      checkpoint: this.version,
    });
  }
}
