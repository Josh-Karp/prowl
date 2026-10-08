import type { Client } from "@modelcontextprotocol/client";
import type { OllamaMessage } from "../models/ollama.js";

import { chat } from "../models/ollama.js";
import { mcpToolsToOllamaTools } from "./tools.js";
import { system } from "./prompts.js";
import { logger } from "../logger.js";

export async function runAgent(
  client: Client,
  task: string,
  model?: string,
  baseUrl?: string,
  maxIterations: number = Number(process.env.MAX_ITERATIONS ?? 30),
) {
  if (!Number.isSafeInteger(maxIterations) || maxIterations <= 0) {
    throw new Error("maxIterations must be a positive integer.");
  }

  const startedAt = performance.now();
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
  const ollamaTools = mcpToolsToOllamaTools(tools);

  const messages: OllamaMessage[] = [
    {
      role: "system",
      content: system,
    },
    {
      role: "user",
      content: task,
    },
  ];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    logger.info(
      `Iteration ${iteration + 1}/${maxIterations}: waiting for model...`,
      { console: true },
    );

    logger.debug(
      `Requesting model response with ${messages.length} messages and ${ollamaTools.length} tools`,
    );
    const modelStartedAt = performance.now();
    const response = await chat(messages, ollamaTools, model, baseUrl).catch(
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

    messages.push({
      ...response,
      content: response.content ?? "",
    });

    if (!response.tool_calls?.length) {
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
      const result = await client
        .callTool({
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })
        .catch((error) => {
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

      messages.push({
        role: "tool",
        tool_name: toolCall.function.name,
        content: JSON.stringify(result),
      });
      logger.debug(
        `Added ${toolCall.function.name} result to conversation (${messages.length} messages)`,
      );
    }
    logger.debug(
      `Iteration ${iteration + 1} complete; requesting the model's next action`,
    );
  }

  logger.error(
    `Stopping: reached the ${maxIterations}-iteration limit after ${(performance.now() - startedAt).toFixed(0)} ms`,
  );
  throw new Error("Agent exceeded maximum iterations.");
}
