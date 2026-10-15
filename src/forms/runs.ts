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

export async function runForms(client: AgentClient, options: FormRunOptions) {
  const { url, runs, maxIterations, context, instructions, model, baseUrl } =
    options;
  for (const [name, value] of Object.entries({ runs, maxIterations })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
  const session: AgentSession = { iterationsUsed: 0 };
  const summary = {
    requestedRuns: runs,
    iterationsUsed: 0,
    results: [] as FormRunResult[],
  };
  let activeRun: number | undefined;
  const finish = (result: FormRunResult) => {
    summary.results.push(result);
    logger.debug("Form run finished", { data: result });
    const report = [
      `Run ${result.runIndex}/${runs}: ${result.status}`,
      result.summary,
    ];
    if (result.evidence) report.push(`Evidence: ${result.evidence}`);
    if (result.reference) report.push(`Reference: ${result.reference}`);
    logger.info(report.join("\n"), { console: true });
  };

  try {
    for (let runIndex = 1; runIndex <= runs; runIndex++) {
      if (session.iterationsUsed >= maxIterations) {
        throw new Error("Agent exceeded maximum iterations.");
      }
      activeRun = session.runIndex = runIndex;
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
      const result = parseReport(report, runIndex);
      activeRun = undefined;
      finish(result);
      if (result.status !== "confirmed") {
        throw new Error(
          `Run ${runIndex}/${runs} ${result.status}: ${result.summary}`,
        );
      }
    }
  } catch (error) {
    if (activeRun !== undefined) {
      finish({
        runIndex: activeRun,
        status: "uncertain",
        summary: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    summary.iterationsUsed = session.iterationsUsed;
    logger.debug("Form runs summary", { data: summary });
    const confirmed = summary.results.filter(
      (result) => result.status === "confirmed",
    ).length;
    logger.info(
      `Form runs: ${confirmed}/${runs} confirmed; ${summary.iterationsUsed}/${maxIterations} iterations used.`,
      { console: true },
    );
  }
  return summary;
}
