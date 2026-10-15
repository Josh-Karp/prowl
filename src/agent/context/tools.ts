import type { CallToolResult } from "@modelcontextprotocol/client";
import type { OllamaTool } from "#models/ollama.js";
import type { BrowserContext } from "#agent/context/observations.js";
import type { ConversationHistory } from "#agent/context/history.js";

import { z } from "zod";

export const automaticContext = `
Automatic context handling is enabled:
- Observations may include a scoped snapshot plus native form metadata: required/disabled/readonly state, HTML type, constraints, current value, native option values, help, and current refs. Preserve outside instructions and feedback.
- Use prowl_full_snapshot for ambiguous fields, missing instructions, or incomplete errors. It returns a fresh full observation.
- Older turns may be replaced by deterministic checkpoints. Requested action counts do not prove successful submissions. Literal confirmation evidence is historical evidence; verify current state before interacting.
- Use prowl_browser_history to retrieve exact original arguments/results by turnId, retrieve a checkpoint by version, or list turn IDs with no arguments. Historical refs are stale; only a fresh observation supplies current refs.
`;

const fullSnapshotArgs = z.strictObject({});

const historyArgs = z
  .strictObject({
    turnId: z.number().int().positive().optional(),
    checkpoint: z.number().int().positive().optional(),
  })
  .refine(
    (value) => value.turnId === undefined || value.checkpoint === undefined,
    {
      message: "Supply at most one of turnId and checkpoint.",
    },
  );

export const contextTools: OllamaTool[] = [
  {
    type: "function",
    function: {
      name: "prowl_full_snapshot",
      description:
        "Get a fresh complete browser snapshot for ambiguous fields, instructions, or errors.",
      parameters: z.toJSONSchema(fullSnapshotArgs),
    },
  },
  {
    type: "function",
    function: {
      name: "prowl_browser_history",
      description:
        "Retrieve an original turn by turnId, a checkpoint by checkpoint, or list available turn IDs. Supply at most one ID. Historical refs are stale.",
      parameters: z.toJSONSchema(historyArgs),
    },
  },
];

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export function dispatchContextTool(
  name: string,
  args: Record<string, unknown>,
  browser: BrowserContext,
  history: ConversationHistory,
): Promise<CallToolResult> | undefined {
  switch (name) {
    case "prowl_full_snapshot": {
      const parsed = fullSnapshotArgs.safeParse(args);
      // Validation is a tool error; browser execution failures propagate.
      return parsed.success
        ? browser.fullSnapshot()
        : Promise.resolve(toolError(parsed.error.message));
    }
    case "prowl_browser_history": {
      const parsed = historyArgs.safeParse(args);
      if (!parsed.success)
        return Promise.resolve(toolError(parsed.error.message));
      try {
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: JSON.stringify(history.retrieve(parsed.data)),
            },
          ],
        });
      } catch (error) {
        return Promise.resolve(
          toolError(error instanceof Error ? error.message : String(error)),
        );
      }
    }
    default:
      return undefined;
  }
}
