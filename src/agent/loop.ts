import type { Client } from "@modelcontextprotocol/client";
import type { OllamaMessage, OllamaTool } from "../models/ollama.js";

import { chat } from "../models/ollama.js";
import { mcpToolsToOllamaTools } from "./tools.js";
import { system, automaticContext } from "./prompts.js";
import { logger } from "../logger.js";

import {
  BrowserContext,
  type BrowserClient,
  type BrowserResult,
} from "./context.js";
import { ConversationHistory } from "./history.js";
import { ContextArtifacts } from "./artifacts.js";
import {
  resolveContextOptions,
  type ContextOptions,
} from "./context-options.js";

const localTools: OllamaTool[] = [
  {
    type: "function",
    function: {
      name: "prowl_full_snapshot",
      description:
        "Get a fresh, complete browser snapshot for ambiguous fields, instructions, or errors.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prowl_browser_history",
      description:
        "Retrieve an original archived turn by turnId, a checkpoint by checkpoint, or list available turn IDs. Historical refs are stale.",
      parameters: {
        type: "object",
        properties: {
          turnId: { type: "integer", minimum: 1 },
          checkpoint: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
    },
  },
];

export async function runAgent(
  client: Client,
  task: string,
  model?: string,
  baseUrl?: string,
  maxIterations: number = Number(process.env.MAX_ITERATIONS ?? 30),
  contextOptions: ContextOptions = {},
) {
  if (!Number.isSafeInteger(maxIterations) || maxIterations <= 0) {
    throw new Error("maxIterations must be a positive integer.");
  }

  const context = resolveContextOptions(contextOptions);
  const automatic = context.mode === "auto";
  const startedAt = performance.now();
  const contextEvent = (data: unknown) =>
    logger.debug("Context event", {
      data: { schemaVersion: 1, ...(data as Record<string, unknown>) },
    });
  contextEvent({ kind: "context-config", ...context });
  logger.debug("Starting agent", {
    data: {
      model: model ?? (process.env.OLLAMA_MODEL || "default"),
      baseUrl:
        baseUrl ?? (process.env.OLLAMA_BASE_URL || "http://localhost:11434"),
      maxIterations,
      contextLength: Number(process.env.OLLAMA_NUM_CTX ?? 16384),
      task,
    },
  });
  logger.info("Discovering available MCP tools...", { console: true });
  const { tools } = await client.listTools().catch((error) => {
    logger.error("MCP tool discovery failed", { data: error });
    throw error;
  });
  logger.debug(`Discovered ${tools.length} tools`, { data: tools });
  const ollamaTools = [
    ...mcpToolsToOllamaTools(tools),
    ...(automatic ? localTools : []),
  ];

  const messages: OllamaMessage[] = [
    {
      role: "system",
      content: automatic ? system + automaticContext : system,
    },
    {
      role: "user",
      content: task,
    },
  ];

  const artifacts = new ContextArtifacts(logger.filePath);
  const browser = new BrowserContext(
    client as unknown as BrowserClient,
    tools,
    contextEvent,
    (value) => artifacts.snapshot(value),
  );
  const history = new ConversationHistory(
    messages,
    context.historyBytes,
    context.numCtx,
    contextEvent,
    (value) => artifacts.history(value),
  );
  let previousPromptTokens: number | undefined;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    logger.info(
      `Iteration ${iteration + 1}/${maxIterations}: waiting for model...`,
      { console: true },
    );

    if (automatic) {
      messages.splice(
        0,
        messages.length,
        ...history.prepare(previousPromptTokens),
      );
      previousPromptTokens = undefined;
    }
    logger.debug(
      `Requesting model response with ${messages.length} messages and ${ollamaTools.length} tools`,
    );
    const modelStartedAt = performance.now();
    const response = await chat(
      messages,
      ollamaTools,
      model,
      baseUrl,
      (metrics) => {
        previousPromptTokens = metrics.prompt_eval_count;
      },
    ).catch((error) => {
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

    const assistant: OllamaMessage = {
      ...response,
      content: response.content ?? "",
    };
    const turn: OllamaMessage[] = [assistant];
    const rawTurn: OllamaMessage[] = [assistant];
    messages.push(assistant);

    if (!response.tool_calls?.length) {
      if (automatic) history.appendTurn(turn, rawTurn);
      logger.debug("Stopping: the model returned no tool calls");
      logger.info(
        `Final response:\n${response.content || "(empty)"}\nAgent finished after ${iteration + 1} iterations in ${(performance.now() - startedAt).toFixed(0)} ms.`,
        { console: true },
      );
      return;
    }

    for (const [toolIndex, toolCall] of response.tool_calls.entries()) {
      logger.info(
        `Executing tool ${toolIndex + 1}/${response.tool_calls.length}: ${toolCall.function.name}`,
        { console: true },
      );
      logger.debug("Tool arguments", { data: toolCall.function.arguments });

      const toolStartedAt = performance.now();
      const name = toolCall.function.name;
      const args = toolCall.function.arguments;
      const localResult = async (): Promise<BrowserResult> => {
        try {
          if (name === "prowl_full_snapshot")
            return await browser.fullSnapshot();
          return {
            content: [
              { type: "text", text: JSON.stringify(history.retrieve(args)) },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      };
      const result = await (
        automatic && localTools.some((tool) => tool.function.name === name)
          ? localResult()
          : client.callTool({ name, arguments: args })
      ).catch((error) => {
        logger.error(
          `Tool ${name} failed after ${(performance.now() - toolStartedAt).toFixed(0)} ms`,
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
        automatic &&
        name !== "prowl_full_snapshot" &&
        name !== "prowl_browser_history"
          ? await browser.reduce(name, args, result)
          : result;
      const receipt: OllamaMessage = {
        role: "tool",
        tool_name: name,
        content: JSON.stringify(displayed),
      };
      turn.push(receipt);
      rawTurn.push({ ...receipt, content: JSON.stringify(result) });
      messages.push(receipt);
      logger.debug(
        `Added ${toolCall.function.name} result to conversation (${messages.length} messages)`,
      );
    }
    if (automatic) history.appendTurn(turn, rawTurn);
    logger.debug(
      `Iteration ${iteration + 1} complete; requesting the model's next action`,
    );
  }

  logger.error(
    `Stopping: reached the ${maxIterations}-iteration limit after ${(performance.now() - startedAt).toFixed(0)} ms`,
  );
  throw new Error("Agent exceeded maximum iterations.");
}
