import OpenAI from 'openai';
import type { LlmConfig } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface Llm {
  complete(messages: ChatMessage[]): Promise<string>;
}

export class ModelOutputError extends Error {
  override name = 'ModelOutputError';
}

/** JSON Schema for the model's answer, used in `json_schema` response-format mode. */
export const ANSWER_SCHEMA: object = {
  type: 'object',
  properties: {
    answerable: { type: 'boolean' },
    answer: { type: 'string' },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          passage_id: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['passage_id', 'quote'],
        additionalProperties: false,
      },
    },
  },
  required: ['answerable', 'answer', 'citations'],
  additionalProperties: false,
};

const DEFAULT_MAX_TOKENS = 800;

function buildResponseFormat(config: LlmConfig) {
  if (config.jsonMode === 'json_schema') {
    return {
      type: 'json_schema' as const,
      json_schema: {
        name: 'grounded_answer',
        strict: true,
        // ANSWER_SCHEMA is declared as `object` (its public type); the SDK's
        // `schema` field wants an index signature, which `object` does not
        // structurally provide, so a narrow cast bridges the two.
        schema: ANSWER_SCHEMA as Record<string, unknown>,
      },
    };
  }
  return { type: 'json_object' as const };
}

/** Reads the non-standard `reasoning_content` field some servers add to the message. */
function reasoningContentOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const content = (message as { reasoning_content?: unknown }).reasoning_content;
  return typeof content === 'string' ? content : undefined;
}

/**
 * Creates an `Llm` backed by an OpenAI-compatible chat completions endpoint.
 * Always requests temperature 0 and the response format matching
 * `config.jsonMode`. `config.extraBody` is spread last, so the operator's
 * explicit provider configuration (e.g. DeepSeek's `thinking` flag) wins
 * over this module's own defaults.
 */
export function createOpenAILlm(config: LlmConfig, options?: { client?: OpenAI; maxTokens?: number }): Llm {
  const client = options?.client ?? new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    async complete(messages: ChatMessage[]): Promise<string> {
      const body = {
        model: config.model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: buildResponseFormat(config),
        ...config.extraBody,
      };

      const completion = await client.chat.completions.create(body);

      const message = completion.choices[0]?.message;
      const content = message?.content;
      if (content !== undefined && content !== null && content.length > 0) {
        return content;
      }

      const reasoningContent = reasoningContentOf(message);
      if (reasoningContent !== undefined && reasoningContent.length > 0) {
        throw new ModelOutputError(
          'The model returned its output only as reasoning_content. Thinking models in LM Studio do this with structured output; load a non-thinking model or turn thinking off.',
        );
      }

      throw new ModelOutputError('The model returned an empty response.');
    },
  };
}

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
const CODE_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * Parses a chat model's raw text output defensively: strips `<think>...</think>`
 * blocks (and an unterminated leading one), strips a Markdown code fence,
 * trims, then `JSON.parse`s. On failure, retries with the substring between
 * the first `{` and the last `}`. Returns `unknown`; `grounding.ts` validates
 * the shape.
 */
export function parseModelJson(raw: string): unknown {
  let text = raw.replace(THINK_BLOCK, '');

  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1 && /<think>/i.test(text.slice(0, firstBrace))) {
    text = text.slice(firstBrace);
  }

  const fenceMatch = text.match(CODE_FENCE);
  if (fenceMatch) {
    text = fenceMatch[1] ?? '';
  }

  text = text.trim();
  if (text.length === 0) {
    throw new ModelOutputError('The model returned an empty response.');
  }

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Fall through to the error below.
      }
    }
    throw new ModelOutputError('The model did not return valid JSON.');
  }
}

/**
 * Throws a clear error naming the missing model, the base URL, and the
 * available ids, unless `model` is one of `available`. Meant to fail fast
 * at startup so a wrong model name is never silently used.
 */
export function assertModelAvailable(available: readonly string[], model: string, baseURL: string): void {
  if (available.includes(model)) return;
  const list = available.length > 0 ? available.join(', ') : 'none';
  throw new Error(
    `LLM_MODEL "${model}" is not available at ${baseURL}. Available models: ${list}. Fix LLM_MODEL or load the model.`,
  );
}

/** Lists the model ids available at the configured endpoint. */
export async function listModels(config: LlmConfig, options?: { client?: OpenAI }): Promise<string[]> {
  const client = options?.client ?? new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
  const page = await client.models.list();
  return page.data.map((model) => model.id);
}
