import type { AgentClient, AgentSession } from "#agent/loop.js";
import type { ResolvedContextOptions } from "#agent/context/options.js";

import { z } from "zod";
import { logger } from "#logger.js";
import { runAgent } from "#agent/loop.js";
import { formTask } from "#forms/prompts.js";

export type FormRunResult = z.infer<typeof reportSchema> & { runIndex: number };

interface FormRunOptions {
  url: string;
  runs: number;
  maxIterations: number;
  context: ResolvedContextOptions;
  instructions?: string;
  model?: string;
  baseUrl?: string;
}

interface FormRunSummary {
  requestedRuns: number;
  iterationsUsed: number;
  results: FormRunResult[];
}

const reportSchema = z
  .object({
    status: z.enum(["confirmed", "blocked", "uncertain"]),
    summary: z.string().trim().min(1),
    evidence: z.string().trim().min(1).optional(),
    reference: z.string().trim().min(1).optional(),
  })
  .refine((report) => report.status !== "confirmed" || !!report.evidence);

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

function logRunSummary(summary: FormRunSummary, maxIterations: number) {
  logger.debug("Form runs summary", { data: summary });

  const confirmed = summary.results.filter(
    (result) => result.status === "confirmed",
  ).length;

  logger.info(
    `Form runs: ${confirmed}/${summary.requestedRuns} confirmed; ${summary.iterationsUsed}/${maxIterations} iterations used.`,
    { console: true },
  );
}

export async function runBatch(client: AgentClient, options: FormRunOptions) {
  const { runs, maxIterations } = options;
  const session: AgentSession = { iterationsUsed: 0 };
  const summary: FormRunSummary = {
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
        model,
        baseUrl,
        maxIterations,
        context,
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
