import type { Tool } from "@modelcontextprotocol/client";
import type {
  OllamaMessage,
  OllamaTool,
  OllamaMetrics,
} from "#models/ollama.js";
import type { BrowserClient } from "#agent/context/observations.js";
import type { ResolvedContextOptions } from "#agent/context/options.js";

import { chat, mcpToolsToOllamaTools } from "#models/ollama.js";
import { emptyResponseRecovery, system } from "#agent/prompts.js";
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

export interface AgentClient extends BrowserClient {
  listTools(): Promise<{ tools: Tool[] }>;
}

export interface AgentSession {
  iterationsUsed: number;
  artifacts?: ContextArtifacts;
  runIndex?: number;
}

const MAX_EMPTY_RESPONSE_RETRIES = 2;

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
) {
  const automatic = context.mode === "auto";
  const ollamaTools = [
    ...mcpToolsToOllamaTools(tools),
    ...(automatic ? contextTools : []),
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

  const artifacts = automatic
    ? (session.artifacts ??= new ContextArtifacts(logger.filePath))
    : undefined;
  const browser = automatic
    ? new BrowserContext(client, {
        capabilities: tools,
        onEvent: logContextEvent,
        onArchive: (value) => artifacts!.snapshot(value),
      })
    : undefined;

  const history = automatic
    ? new ConversationHistory(prefix, {
        budget: context.historyBytes,
        numCtx: context.numCtx,
        onEvent: logContextEvent,
        onArchive: (value) =>
          artifacts!.history({ ...value, runIndex: session.runIndex }),
      })
    : undefined;

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
  model?: string,
  baseUrl?: string,
  onMetrics?: (metrics: OllamaMetrics) => void,
) {
  logger.debug(
    `Requesting model response with ${messages.length} messages and ${tools.length} tools`,
  );

  const modelStartedAt = performance.now();
  const response = await chat(messages, tools, model, baseUrl, onMetrics).catch(
    (error) => {
      logger.error(
        `Model request failed after ${(performance.now() - modelStartedAt).toFixed(0)} ms`,
        { data: error },
      );
      throw error;
    },
  );

  logger.debug(
    `Model response (${(performance.now() - modelStartedAt).toFixed(0)} ms, ${response.tool_calls?.length ?? 0} tool calls)`,
    { data: response },
  );

  return response;
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
  model?: string,
  baseUrl?: string,
  maxIterations: number = Number(process.env.MAX_ITERATIONS ?? 30),
  configuration?: ResolvedContextOptions,
  session: AgentSession = { iterationsUsed: 0 },
) {
  if (!Number.isSafeInteger(maxIterations) || maxIterations <= 0) {
    throw new Error("maxIterations must be a positive integer.");
  }

  const context = configuration ?? resolveContextOptions();

  logContextEvent({ kind: "context-config", ...context });
  const startedAt = performance.now();

  logger.debug("Starting agent", {
    data: {
      model: model ?? (process.env.OLLAMA_MODEL || "default"),
      baseUrl:
        baseUrl ?? (process.env.OLLAMA_BASE_URL || "http://localhost:11434"),
      maxIterations,
      contextLength: context.numCtx,
      runIndex: session.runIndex,
      task,
    },
  });

  const tools = await discoverTools(client);
  const { ollamaTools, browser, history, prepareMessages, appendTurn } =
    createConversation(client, tools, task, context, session);
  let previousPromptTokens: number | undefined;
  let consecutiveEmptyResponses = 0;

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
      model,
      baseUrl,
      (metrics) => {
        previousPromptTokens = metrics.prompt_eval_count;
      },
    );

    const assistant: OllamaMessage = {
      ...response,
      content: response.content ?? "",
    };
    const turn: OllamaMessage[] = [assistant];
    const originalTurn: OllamaMessage[] = history ? [assistant] : turn;

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
        if (history) originalTurn.push(recovery);
        appendTurn(turn, originalTurn);
        continue;
      }

      appendTurn(turn, originalTurn);
      logger.debug("Stopping: the model returned no tool calls");
      logger.info(
        `Final response:\n${response.content}\nAgent finished after ${iteration + 1} iterations in ${(performance.now() - startedAt).toFixed(0)} ms.`,
        { console: session.runIndex === undefined },
      );

      return response.content;
    }

    consecutiveEmptyResponses = 0;
    for (const [toolIndex, toolCall] of response.tool_calls.entries()) {
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
      if (history) originalTurn.push(originalReceipt);
      logger.debug(
        `Added ${toolCall.function.name} result to conversation (${messages.length + turn.length} messages)`,
      );
    }
    appendTurn(turn, originalTurn);
    logger.debug(
      `Iteration ${session.iterationsUsed} complete; requesting the model's next action`,
    );
  }

  logger.error(
    `Stopping: reached the ${maxIterations}-iteration limit after ${(performance.now() - startedAt).toFixed(0)} ms`,
  );
  throw new Error("Agent exceeded maximum iterations.");
}
