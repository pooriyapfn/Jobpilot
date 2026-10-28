import { OpenRouter } from "@openrouter/sdk";
import { OpenRouterError } from "@openrouter/sdk/models/errors";
import { toJSONSchema, type ZodType } from "zod";
import { config } from "./config.ts";
import { parseJson } from "./parseJson.ts";

const openRouter = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

export const MODELS = config.models;

const DEFAULT_MODEL: string = MODELS.extraction;
const JSON_MAX_ATTEMPTS = 2;

// Set DEBUG_LLM=1 for the raw per-request/response trace; normal runs stay quiet
// and let runner.ts print the human-readable progress instead.
const DEBUG = process.env.DEBUG_LLM === "1";

const log = (message: string) => {
  if (DEBUG) console.log(`[LLM] ${message}`);
};

const logError = (message: string, error: unknown) => {
  if (error instanceof OpenRouterError) {
    console.error(`✗ ${message}: ${error.message} (HTTP ${error.statusCode})`);
    if (DEBUG) console.error(`  body: ${error.body}`);
    return;
  }
  console.error(
    `✗ ${message}: ${error instanceof Error ? error.message : String(error)}`,
  );
  if (DEBUG && error instanceof Error && error.stack) console.error(error.stack);
};

export type LLM = (prompt: string, model?: string) => Promise<string>;

export type LLMJson = <S extends ZodType>(
  prompt: string,
  schema: S,
  opts?: { name?: string; model?: string },
) => Promise<S["_output"]>;

let runCost = 0;

export const getRunCost = () => runCost;

const logUsage = (result: unknown): void => {
  const usage =
    result && typeof result === "object" && "usage" in result
      ? (
          result as {
            usage?: {
              promptTokens?: number;
              completionTokens?: number;
              cost?: number | null;
            };
          }
        ).usage
      : undefined;

  if (!usage) return;

  if (typeof usage.cost === "number") runCost += usage.cost;

  log(
    `usage promptTokens=${usage.promptTokens ?? "?"} completionTokens=${usage.completionTokens ?? "?"} cost=${usage.cost != null ? `$${usage.cost.toFixed(6)}` : "?"} runTotal=$${runCost.toFixed(6)}`,
  );
};

const readContent = (result: unknown): string => {
  const content =
    result &&
    typeof result === "object" &&
    "choices" in result &&
    Array.isArray((result as { choices: unknown[] }).choices)
      ? (
          result as {
            choices: Array<{ message?: { content?: unknown } }>;
          }
        ).choices[0]?.message?.content
      : undefined;

  if (typeof content !== "string" || !content) {
    throw new Error("LLM returned empty response");
  }

  return content;
};

export const callLLM: LLM = async (prompt, model = DEFAULT_MODEL) => {
  const start = Date.now();
  log(`request model=${model} promptChars=${prompt.length}`);

  try {
    const result = await openRouter.chat.send({
      chatRequest: {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      },
    });

    logUsage(result);
    const content = readContent(result);
    log(
      `response model=${model} ms=${Date.now() - start} chars=${content.length}`,
    );
    return content;
  } catch (error) {
    logError(`request failed model=${model} ms=${Date.now() - start}`, error);
    throw error;
  }
};

export const callLLMJson: LLMJson = async (prompt, schema, opts = {}) => {
  const model = opts.model ?? DEFAULT_MODEL;
  const name = opts.name ?? "response";
  const jsonSchema = toJSONSchema(schema);
  let lastError: unknown;

  for (let attempt = 0; attempt < JSON_MAX_ATTEMPTS; attempt++) {
    const start = Date.now();
    log(
      `request name=${name} model=${model} attempt=${attempt + 1}/${JSON_MAX_ATTEMPTS} promptChars=${prompt.length}`,
    );

    try {
      const result = await openRouter.chat.send({
        chatRequest: {
          model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          responseFormat: {
            type: "json_schema",
            jsonSchema: {
              name,
              schema: jsonSchema,
              strict: true,
            },
          },
        },
      });

      logUsage(result);
      const parsed = parseJson(readContent(result), schema);
      log(`response name=${name} model=${model} ms=${Date.now() - start}`);
      return parsed;
    } catch (error) {
      lastError = error;
      logError(
        `request failed name=${name} model=${model} attempt=${attempt + 1}/${JSON_MAX_ATTEMPTS} ms=${Date.now() - start}`,
        error,
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to parse structured LLM JSON");
};
