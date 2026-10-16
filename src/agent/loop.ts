import type { Tool } from "@modelcontextprotocol/client";
import type {
  OllamaMessage,
  OllamaTool,
  OllamaMetrics,
} from "#models/ollama.js";
import type { BrowserClient } from "#agent/context/observations.js";
import type { ResolvedContextOptions } from "#agent/context/options.js";
import type { ResolvedModelOptions } from "#models/options.js";

import { chat, mcpToolsToOllamaTools } from "#models/ollama.js";
import {
  emptyResponseRecovery,
  reportRecovery,
  system,
} from "#agent/prompts.js";
import {
  automaticContext,
  contextTools,
  dispatchContextTool,
} from "#agent/context/tools.js";
import { logger } from "#logger.js";
import { BrowserContext } from "#agent/context/observations.js";
import { ConversationHistory } from "#agent/context/history.js";
import { ContextArtifacts } from "#agent/context/artifacts.js";
import { resolveContextOptions } from "#agent/context/options.js";
import { resolveModelOptions } from "#models/options.js";

export interface AgentClient extends BrowserClient {
  listTools(): Promise<{ tools: Tool[] }>;
}

export type FinishResult = { report: string } | { error: string };

export interface AgentFinish {
  // Ends the run when accepted; its schema stays with the caller.
  tool: OllamaTool;
  acceptArguments(args: Record<string, unknown>): FinishResult;
  acceptText(content: string): FinishResult;
}

export interface AgentOptions {
  model?: string;
  baseUrl?: string;
  maxIterations?: number;
  context?: ResolvedContextOptions;
  finish?: AgentFinish;
}

export interface AgentSession {
  iterationsUsed: number;
  artifacts?: ContextArtifacts;
  runIndex?: number;
}

const MAX_EMPTY_RESPONSE_RETRIES = 2;
const MAX_REPORT_RETRIES = 2;

function logContextEvent(data: object) {
  logger.debug("Context event", { data: { schemaVersion: 1, ...data } });
}

async function discoverTools(client: AgentClient) {
  logger.info("Discovering available MCP tools...", { console: true });

  const { tools } = await client.listTools().catch((error) => {
    logger.error("MCP tool discovery failed", { data: error });
    throw error;
  });

  logger.debug(`Discovered ${tools.length} tools`, { data: tools });

  return tools;
}

function createConversation(
  client: AgentClient,
  tools: Tool[],
  task: string,
  context: ResolvedContextOptions,
  session: AgentSession,
  finish?: AgentFinish,
) {
  const automatic = context.mode === "auto";
  const ollamaTools = [
    ...mcpToolsToOllamaTools(tools),
    ...(automatic ? contextTools : []),
    ...(finish ? [finish.tool] : []),
  ];

  const prefix: OllamaMessage[] = [
    {
      role: "system",
      content: automatic ? system + automaticContext : system,
    },
    {
      role: "user",
      content: task,
    },
  ];

  let browser: BrowserContext | undefined;
  let history: ConversationHistory | undefined;
  if (automatic) {
    const artifacts = (session.artifacts ??= new ContextArtifacts(
      logger.filePath,
    ));
    browser = new BrowserContext(client, {
      capabilities: tools,
      onEvent: logContextEvent,
      onArchive: (value) => artifacts.snapshot(value),
    });
    history = new ConversationHistory(prefix, {
      budget: context.historyBytes,
      numCtx: context.numCtx,
      onEvent: logContextEvent,
      onArchive: (value) =>
        artifacts.history({ ...value, runIndex: session.runIndex }),
    });
  }

  const appendTurn = (
    displayed: OllamaMessage[],
    original: OllamaMessage[],
  ) => {
    if (history) history.appendTurn(displayed, original);
    else prefix.push(...displayed);
  };
  return {
    ollamaTools,
    browser,
    history,
    prepareMessages: (previousPromptTokens?: number) =>
      history?.prepare(previousPromptTokens) ?? prefix,
    appendTurn,
  };
}

async function requestModelResponse(
  messages: OllamaMessage[],
  tools: OllamaTool[],
  configuration: ResolvedModelOptions,
  onMetrics?: (metrics: OllamaMetrics) => void,
) {
  logger.debug(
    `Requesting model response with ${messages.length} messages and ${tools.length} tools`,
  );

  const modelStartedAt = performance.now();
  const response = await chat(messages, {
    tools,
    onMetrics,
    configuration,
  }).catch((error) => {
    logger.error(
      `Model request failed after ${(performance.now() - modelStartedAt).toFixed(0)} ms`,
      { data: error },
    );
    throw error;
  });

  logger.debug(
    `Model response (${(performance.now() - modelStartedAt).toFixed(0)} ms, ${response.tool_calls?.length ?? 0} tool calls)`,
    { data: response },
  );

  return response;
}

// Plain text keeps validation messages out of checkpointed confirmation evidence.
function finishReceipt(name: string, result: FinishResult): OllamaMessage {
  return {
    role: "tool",
    tool_name: name,
    content:
      "report" in result
        ? "Report accepted."
        : `Error: report rejected. ${result.error}`,
  };
}

async function executeTool(
  client: AgentClient,
  toolCall: NonNullable<OllamaMessage["tool_calls"]>[number],
  browser?: BrowserContext,
  history?: ConversationHistory,
) {
  logger.debug("Tool arguments", { data: toolCall.function.arguments });

  const toolStartedAt = performance.now();
  const name = toolCall.function.name;
  const args = toolCall.function.arguments;
  const local =
    browser && history
      ? dispatchContextTool(name, args, browser, history)
      : undefined;
  const result = await (
    local ?? client.callTool({ name, arguments: args })
  ).catch((error) => {
    logger.error(
      `Tool ${toolCall.function.name} failed after ${(performance.now() - toolStartedAt).toFixed(0)} ms`,
      { data: error },
    );
    throw error;
  });
  logger.debug(
    `Tool ${toolCall.function.name} returned in ${(performance.now() - toolStartedAt).toFixed(0)} ms (isError: ${result.isError === true})`,
    { data: result },
  );
  if (result.isError)
    logger.warn(
      `Tool ${toolCall.function.name} reported an error; waiting for the model's next action.`,
      { console: true },
    );

  const displayed =
    browser && !local ? await browser.reduce(name, args, result) : result;
  const displayedReceipt: OllamaMessage = {
    role: "tool",
    tool_name: name,
    content: JSON.stringify(displayed),
  };
  return {
    receipt: displayedReceipt,
    originalReceipt: history
      ? { ...displayedReceipt, content: JSON.stringify(result) }
      : displayedReceipt,
  };
}

export async function runAgent(
  client: AgentClient,
  task: string,
  options: AgentOptions = {},
  session: AgentSession = { iterationsUsed: 0 },
) {
  const {
    model,
    baseUrl,
    finish,
    maxIterations = Number(process.env.MAX_ITERATIONS ?? 30),
  } = options;
  if (!Number.isSafeInteger(maxIterations) || maxIterations <= 0) {
    throw new Error("maxIterations must be a positive integer.");
  }

  const context = options.context ?? resolveContextOptions();
  const modelOptions = resolveModelOptions({
    model,
    baseUrl,
    numCtx: context.numCtx,
  });

  logContextEvent({ kind: "context-config", ...context });
  const startedAt = performance.now();

  logger.debug("Starting agent", {
    data: {
      model: modelOptions.model,
      baseUrl: modelOptions.baseUrl,
      maxIterations,
      contextLength: context.numCtx,
      runIndex: session.runIndex,
      task,
    },
  });

  const tools = await discoverTools(client);
  const { ollamaTools, browser, history, prepareMessages, appendTurn } =
    createConversation(client, tools, task, context, session, finish);
  let previousPromptTokens: number | undefined;
  let consecutiveEmptyResponses = 0;
  let rejectedTextReports = 0;

  const finished = (report: string, iteration: number) => {
    logger.debug("Stopping: the model returned a final report");
    logger.info(
      `Final response:\n${report}\nAgent finished after ${iteration + 1} iterations in ${(performance.now() - startedAt).toFixed(0)} ms.`,
      { console: session.runIndex === undefined },
    );
    return report;
  };

  for (let iteration = 0; session.iterationsUsed < maxIterations; iteration++) {
    session.iterationsUsed++;
    logger.info(
      `Iteration ${session.iterationsUsed}/${maxIterations}: waiting for model...`,
      { console: true },
    );

    const messages = prepareMessages(previousPromptTokens);
    previousPromptTokens = undefined;
    const response = await requestModelResponse(
      messages,
      ollamaTools,
      modelOptions,
      (metrics) => {
        previousPromptTokens = metrics.prompt_eval_count;
      },
    );

    const assistant: OllamaMessage = {
      ...response,
      content: response.content ?? "",
    };
    const turn: OllamaMessage[] = [assistant];
    const originalTurn: OllamaMessage[] = [assistant];

    if (!response.tool_calls?.length) {
      // Empty or thinking-only responses do not indicate completion; ask the model to continue.
      if (!(response.content ?? "").trim()) {
        consecutiveEmptyResponses++;
        if (consecutiveEmptyResponses > MAX_EMPTY_RESPONSE_RETRIES) {
          appendTurn(turn, originalTurn);
          logger.debug("Stopping: empty-response recovery exhausted");
          throw new Error(
            `Model returned an empty response without tool calls after ${MAX_EMPTY_RESPONSE_RETRIES} recovery attempts.`,
          );
        }
        if (session.iterationsUsed >= maxIterations) {
          appendTurn(turn, originalTurn);
          break;
        }

        logger.warn(
          `Model returned no tool calls or final report; recovery attempt ${consecutiveEmptyResponses}/${MAX_EMPTY_RESPONSE_RETRIES}.`,
          { console: true },
        );
        const recovery: OllamaMessage = {
          role: "user",
          content: emptyResponseRecovery,
        };
        turn.push(recovery);
        originalTurn.push(recovery);
        appendTurn(turn, originalTurn);
        continue;
      }

      const text = finish?.acceptText(response.content);
      if (
        finish &&
        text &&
        "error" in text &&
        rejectedTextReports < MAX_REPORT_RETRIES &&
        session.iterationsUsed < maxIterations
      ) {
        rejectedTextReports++;
        logger.warn(
          `Model final report was not accepted; recovery attempt ${rejectedTextReports}/${MAX_REPORT_RETRIES}.`,
          { console: true },
        );
        const recovery: OllamaMessage = {
          role: "user",
          content: reportRecovery(finish.tool.function.name, text.error),
        };
        turn.push(recovery);
        originalTurn.push(recovery);
        appendTurn(turn, originalTurn);
        continue;
      }

      appendTurn(turn, originalTurn);
      // An exhausted rejection returns the raw text so the caller records it as unaccepted.
      return finished(
        text && "report" in text ? text.report : response.content,
        iteration,
      );
    }

    consecutiveEmptyResponses = 0;
    const finishName = finish?.tool.function.name;
    let report: string | undefined;
    for (const [toolIndex, toolCall] of response.tool_calls.entries()) {
      if (finish && toolCall.function.name === finishName) {
        // A report must describe verified state, so it cannot share a turn with actions.
        const result: FinishResult =
          response.tool_calls.length === 1
            ? finish.acceptArguments(toolCall.function.arguments ?? {})
            : {
                error: `${finishName} must be the only tool call in its turn. Verify the current page, then call it again alone.`,
              };
        logger.debug("Final report tool call", {
          data: { arguments: toolCall.function.arguments, result },
        });
        if ("report" in result) report = result.report;
        else
          logger.warn(
            `Tool ${finishName} reported an error; waiting for the model's next action.`,
            { console: true },
          );
        const receipt = finishReceipt(toolCall.function.name, result);
        turn.push(receipt);
        originalTurn.push(receipt);
        continue;
      }
      logger.info(
        `Executing tool ${toolIndex + 1}/${response.tool_calls.length}: ${toolCall.function.name}`,
        { console: true },
      );
      const { receipt, originalReceipt } = await executeTool(
        client,
        toolCall,
        browser,
        history,
      );
      turn.push(receipt);
      originalTurn.push(originalReceipt);
      logger.debug(
        `Added ${toolCall.function.name} result to conversation (${messages.length + turn.length} messages)`,
      );
    }
    appendTurn(turn, originalTurn);
    if (report !== undefined) return finished(report, iteration);
    logger.debug(
      `Iteration ${session.iterationsUsed} complete; requesting the model's next action`,
    );
  }

  logger.error(
    `Stopping: reached the ${maxIterations}-iteration limit after ${(performance.now() - startedAt).toFixed(0)} ms`,
  );
  throw new Error("Agent exceeded maximum iterations.");
}
