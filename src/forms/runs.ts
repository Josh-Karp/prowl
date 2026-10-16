import type {
  AgentClient,
  AgentFinish,
  AgentSession,
  FinishResult,
} from "#agent/loop.js";
import type { ResolvedContextOptions } from "#agent/context/options.js";

import { z } from "zod";
import { logger } from "#logger.js";
import { runAgent } from "#agent/loop.js";
import { formTask } from "#forms/prompts.js";

export type FormRunResult = z.infer<typeof reportFields> & { runIndex: number };

interface BatchOptions {
  url: string;
  runs: number;
  maxIterations: number;
  context: ResolvedContextOptions;
  instructions?: string;
  model?: string;
  baseUrl?: string;
}

interface BatchSummary {
  requestedRuns: number;
  iterationsUsed: number;
  results: FormRunResult[];
}

const REPORT_TOOL = "prowl_submit_report";

const reportFields = z.object({
  status: z
    .enum(["confirmed", "blocked", "uncertain"])
    .describe(
      '"confirmed" only after observing a visible success confirmation; otherwise "blocked" or "uncertain".',
    ),
  summary: z
    .string()
    .trim()
    .min(1)
    .describe("Entered fields and observed outcome or blocker."),
  evidence: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Literal visible confirmation text, required for "confirmed". Never invent it.',
    ),
  reference: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("The exact reference/ID if shown; omit it if none is shown."),
});

const reportSchema = z.preprocess(
  normalizeReport,
  reportFields.refine(
    (report) => report.status !== "confirmed" || !!report.evidence,
    { message: 'evidence is required when status is "confirmed".' },
  ),
);

const reportTool = {
  type: "function" as const,
  function: {
    name: REPORT_TOOL,
    description:
      "Submit the final outcome of this registration after verifying it in the browser. Call it once, alone in its turn. It ends the run.",
    parameters: z.toJSONSchema(reportFields),
  },
};

// Models differ in how they spell "absent"; none of these rewrites can create a confirmation.
function normalizeReport(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return value;
  const report: Record<string, unknown> = { ...value };
  if (typeof report.status === "string")
    report.status = report.status.trim().toLowerCase();
  for (const field of ["evidence", "reference"]) {
    const text = report[field];
    if (text === null || (typeof text === "string" && !text.trim()))
      delete report[field];
  }
  return report;
}

// Report text may quote any page, so only a fence spanning the whole response is removed.
function extractReportText(content: string) {
  const text = content
    .replace(/^\s*(?:<think>[\s\S]*?<\/think>\s*)+/, "")
    .trim();
  const fenced = /^(```|~~~)[\w-]*[ \t]*\n([\s\S]*)\n[ \t]*\1$/.exec(text);
  return fenced ? fenced[2] : text;
}

function acceptReport(value: unknown): FinishResult {
  const parsed = reportSchema.safeParse(value);
  return parsed.success
    ? { report: JSON.stringify(parsed.data) }
    : { error: z.prettifyError(parsed.error) };
}

const reportFinish: AgentFinish = {
  tool: reportTool,
  acceptArguments: acceptReport,
  acceptText(content) {
    try {
      return acceptReport(JSON.parse(extractReportText(content)));
    } catch {
      return {
        error: `The response was not a JSON report. Call ${REPORT_TOOL} instead.`,
      };
    }
  },
};

function parseReport(content: string, runIndex: number): FormRunResult {
  try {
    const parsed = reportSchema.safeParse(JSON.parse(content));
    if (parsed.success) return { ...parsed.data, runIndex };
  } catch {
    // A prose or malformed report cannot authorize another registration.
  }
  return {
    runIndex,
    status: "uncertain",
    summary:
      "Model did not return a valid structured run result. See the logged final response.",
  };
}

function logRunResult(result: FormRunResult, requestedRuns: number) {
  logger.debug("Form run finished", { data: result });

  const report = [
    `Run ${result.runIndex}/${requestedRuns}: ${result.status}`,
    result.summary,
  ];

  if (result.evidence) report.push(`Evidence: ${result.evidence}`);
  if (result.reference) report.push(`Reference: ${result.reference}`);

  logger.info(report.join("\n"), { console: true });
}

function logRunSummary(summary: BatchSummary, maxIterations: number) {
  logger.debug("Form runs summary", { data: summary });

  const confirmed = summary.results.filter(
    (result) => result.status === "confirmed",
  ).length;

  logger.info(
    `Form runs: ${confirmed}/${summary.requestedRuns} confirmed; ${summary.iterationsUsed}/${maxIterations} iterations used.`,
    { console: true },
  );
}

export async function runBatch(client: AgentClient, options: BatchOptions) {
  const { runs, maxIterations } = options;
  const session: AgentSession = { iterationsUsed: 0 };
  const summary: BatchSummary = {
    requestedRuns: runs,
    iterationsUsed: 0,
    results: [],
  };

  async function runForm(runIndex: number) {
    const { url, instructions, model, baseUrl, context } = options;
    session.runIndex = runIndex;
    let result: FormRunResult | undefined;

    try {
      logger.debug("Form run started", {
        data: {
          runIndex,
          requestedRuns: runs,
          iterationsUsed: session.iterationsUsed,
        },
      });
      logger.info(
        `Run ${runIndex}/${runs}: starting with a fresh conversation...`,
        { console: true },
      );

      const report = await runAgent(
        client,
        formTask(url, runs, instructions, runIndex),
        { model, baseUrl, maxIterations, context, finish: reportFinish },
        session,
      );
      result = parseReport(report, runIndex);
      return result;
    } catch (error) {
      result = {
        runIndex,
        status: "uncertain",
        summary: error instanceof Error ? error.message : String(error),
      };
      throw error;
    } finally {
      if (result) {
        summary.results.push(result);
        logRunResult(result, runs);
      }
    }
  }

  try {
    for (let runIndex = 1; runIndex <= runs; runIndex++) {
      if (session.iterationsUsed >= maxIterations) {
        throw new Error("Agent exceeded maximum iterations.");
      }

      const result = await runForm(runIndex);
      if (result.status !== "confirmed") {
        throw new Error(
          `Run ${runIndex}/${runs} ${result.status}: ${result.summary}`,
        );
      }
    }
  } finally {
    summary.iterationsUsed = session.iterationsUsed;
    logRunSummary(summary, maxIterations);
  }
  return summary;
}
