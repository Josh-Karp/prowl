import type { OllamaMessage } from "../models/ollama.js";
export interface HistoryEvent {
  kind: "history" | "budget-exception";
  beforeBytes: number;
  afterBytes: number;
  archivedTurns: number;
  checkpoint: number;
}
interface Turn {
  id: number;
  messages: OllamaMessage[];
}
const size = (messages: OllamaMessage[]) =>
  Buffer.byteLength(JSON.stringify(messages));
const notice =
  "Historical refs must not be used for current interactions. Requested actions are distinct from observed results; no submission success is inferred. Retrieve a turn for its exact original evidence.";

function confirmations(messages: OllamaMessage[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (
      message.role !== "tool" ||
      message.tool_name === "prowl_browser_history"
    )
      continue;
    try {
      const result = JSON.parse(message.content);
      if (!Array.isArray(result.content)) continue;
      for (const item of result.content) {
        if (item.type !== "text" || typeof item.text !== "string") continue;
        for (const line of item.text.split("\n")) {
          if (/confirm|submitted|received|reference|\bDEMO-/i.test(line))
            lines.push(line);
        }
      }
    } catch {
      /* Plain receipts remain accessible in the archive. */
    }
  }
  return lines;
}

export class ConversationHistory {
  private prefix: OllamaMessage[];
  private turns: Turn[] = [];
  private archive = new Map<number, OllamaMessage[]>();
  private checkpoints = new Map<number, Record<string, unknown>>();
  private checkpointMessages: OllamaMessage[] = [];
  private version = 0;
  private nextId = 1;
  private evidence: string[] = [];

  constructor(
    prefix: OllamaMessage[],
    private budget: number,
    private numCtx: number,
    private event: (value: HistoryEvent) => void = () => {},
    private persist: (value: {
      id: number;
      messages: OllamaMessage[];
    }) => void = () => {},
  ) {
    this.prefix = structuredClone(prefix);
  }

  appendTurn(
    messages: OllamaMessage[],
    original: OllamaMessage[] = messages,
  ): void {
    const assistant = messages[0];
    const calls = assistant?.tool_calls ?? [];
    if (
      assistant?.role !== "assistant" ||
      messages.length !== calls.length + 1 ||
      calls.some(
        (call, i) =>
          messages[i + 1]?.role !== "tool" ||
          messages[i + 1]?.tool_name !== call.function.name,
      )
    ) {
      throw new Error(
        "History requires complete, correctly paired assistant/tool turns.",
      );
    }
    const id = this.nextId++;
    const raw = structuredClone(original);
    this.persist({ id, messages: raw });
    this.archive.set(id, raw);
    // Completed reasoning is diagnostic history; replaying it costs input tokens.
    const displayed = structuredClone(messages).map((message) => {
      const withoutThinking = { ...message };
      delete withoutThinking.thinking;
      return withoutThinking;
    });
    this.turns.push({ id, messages: displayed });
    this.evidence = [
      ...new Set([...this.evidence, ...confirmations(messages)]),
    ];
  }

  retrieve(args: Record<string, unknown>): Record<string, unknown> {
    if (args.checkpoint !== undefined) {
      const checkpoint = this.checkpoints.get(Number(args.checkpoint));
      if (!checkpoint) throw new Error("Unknown history checkpoint.");
      return structuredClone(checkpoint);
    }
    if (args.turnId !== undefined) {
      const messages = this.archive.get(Number(args.turnId));
      if (!messages) throw new Error("Unknown history turn.");
      return {
        notice,
        turnId: Number(args.turnId),
        messages: structuredClone(messages),
      };
    }
    return {
      notice,
      turns: [...this.archive.keys()],
      checkpoint: this.version || null,
    };
  }

  private messages(): OllamaMessage[] {
    return [
      ...this.prefix,
      ...this.checkpointMessages,
      ...this.turns.flatMap((turn) => turn.messages),
    ];
  }
  prepare(previousPromptTokens?: number): OllamaMessage[] {
    const beforeBytes = size(this.messages());
    const pressure =
      beforeBytes > this.budget ||
      (previousPromptTokens !== undefined &&
        previousPromptTokens >= this.numCtx * 0.8);
    if (!pressure) return structuredClone(this.messages());
    const protectedIds = new Set(this.turns.slice(-2).map((turn) => turn.id));
    const latestObservation = [...this.turns]
      .reverse()
      .find((turn) =>
        turn.messages.some(
          (message) =>
            message.role === "tool" &&
            message.tool_name !== "prowl_browser_history" &&
            /### Snapshot/.test(message.content),
        ),
      );
    if (latestObservation) protectedIds.add(latestObservation.id);
    const latestError = [...this.turns].reverse().find((turn) =>
      turn.messages.some((message) => {
        if (message.role !== "tool") return false;
        try {
          return JSON.parse(message.content).isError === true;
        } catch {
          return false;
        }
      }),
    );
    if (latestError) protectedIds.add(latestError.id);
    const removed: Turn[] = [];
    let remaining = [...this.turns];
    let replacement = this.checkpointMessages;
    let candidate: Record<string, unknown> | undefined;
    const version = this.version + 1;
    for (const turn of this.turns) {
      if (protectedIds.has(turn.id)) continue;
      removed.push(turn);
      remaining = remaining.filter((value) => value.id !== turn.id);
      const live = new Set(remaining.map((value) => value.id));
      const archived = [...this.archive.keys()].filter((id) => !live.has(id));
      const ranges: Array<[number, number]> = [];
      for (const id of archived) {
        const last = ranges[ranges.length - 1];
        if (last && last[1] + 1 === id) last[1] = id;
        else ranges.push([id, id]);
      }
      candidate = {
        notice,
        checkpoint: version,
        archivedTurns: { count: archived.length, ranges },
        literalConfirmationEvidence: this.evidence,
        recentArchivedReceipts: removed.slice(-2).map((value) => ({
          turnId: value.id,
          requestedActions: value.messages[0].tool_calls?.map((call) => ({
            name: call.function.name,
          })),
          results: value.messages
            .slice(1)
            .map((message) => ({ tool: message.tool_name })),
          evidence: `Retrieve turn ${value.id} for exact arguments and execution receipts.`,
        })),
      };
      replacement = [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "prowl_browser_history",
                arguments: { checkpoint: version },
              },
            },
          ],
        },
        {
          role: "tool",
          tool_name: "prowl_browser_history",
          content: JSON.stringify(candidate),
        },
      ];
      // Size the actual replacement, not the checkpoint being removed.
      if (
        size([
          ...this.prefix,
          ...replacement,
          ...remaining.flatMap((value) => value.messages),
        ]) <=
        this.budget / 2
      )
        break;
    }
    if (removed.length && candidate) {
      this.turns = remaining;
      this.version = version;
      this.checkpoints.set(version, candidate);
      this.checkpointMessages = replacement;
      this.event({
        kind: "history",
        beforeBytes,
        afterBytes: size(this.messages()),
        archivedTurns: this.archive.size - this.turns.length,
        checkpoint: this.version,
      });
    }
    const afterBytes = size(this.messages());
    if (afterBytes > this.budget)
      this.event({
        kind: "budget-exception",
        beforeBytes,
        afterBytes,
        archivedTurns: this.archive.size - this.turns.length,
        checkpoint: this.version,
      });
    return structuredClone(this.messages());
  }
}
