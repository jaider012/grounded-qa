import OpenAI from 'openai';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { BedrockConfig, Config, LlmConfig } from './config.js';
import { describeBedrockError } from './bedrock-error.js';

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

/** JSON Schema for the model's answer, used in the `json_schema` response-format mode. */
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

/** Reads the non-standard `reasoning_content` field some servers add to the message. */
function reasoningContentOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const content = (message as { reasoning_content?: unknown }).reasoning_content;
  return typeof content === 'string' ? content : undefined;
}

/**
 * Creates an `Llm` backed by an OpenAI-compatible chat completions endpoint.
 * Always requests temperature 0 and a `json_schema` response format named
 * `grounded_answer`.
 */
export function createOpenAILlm(config: LlmConfig, options?: { client?: OpenAI; maxTokens?: number }): Llm {
  const client = options?.client ?? new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    async complete(messages: ChatMessage[]): Promise<string> {
      const completion = await client.chat.completions.create({
        model: config.model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'grounded_answer',
            strict: true,
            // ANSWER_SCHEMA is declared as `object` (its public type); the SDK's
            // `schema` field wants an index signature, which `object` does not
            // structurally provide, so a narrow cast bridges the two.
            schema: ANSWER_SCHEMA as Record<string, unknown>,
          },
        },
      });

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

// --- Bedrock -----------------------------------------------------------------

interface BedrockSendClient {
  send(command: unknown): Promise<unknown>;
}

/** The shape this module reads off a Converse response; the rest of the payload is ignored. */
interface ConverseLikeResponse {
  output?: {
    message?: {
      content?: unknown[];
    };
  };
}

/** Reads only the `text` blocks of a Converse response's message content, in order, joined. */
function textBlocksOf(response: unknown): string {
  const content = (response as ConverseLikeResponse)?.output?.message?.content ?? [];
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') texts.push(text);
    }
  }
  return texts.join('');
}

/**
 * Creates an `Llm` backed by Bedrock's Converse API: one `ConverseCommand`
 * per `complete` call. The Converse API has no universal JSON mode, so the
 * JSON instructions stay in the caller's system prompt (see `answer.ts`).
 * AWS errors are turned into clear messages naming the model and region.
 */
export function createBedrockLlm(config: BedrockConfig, options?: { client?: BedrockSendClient }): Llm {
  const client = options?.client ?? new BedrockRuntimeClient({ region: config.region });

  return {
    async complete(messages: ChatMessage[]): Promise<string> {
      const systemText = messages.find((message) => message.role === 'system')?.content ?? '';
      const userText = messages.find((message) => message.role === 'user')?.content ?? '';

      const command = new ConverseCommand({
        modelId: config.chatModelId,
        system: [{ text: systemText }],
        messages: [{ role: 'user', content: [{ text: userText }] }],
        inferenceConfig: { temperature: 0, maxTokens: 2000 },
      });

      let response: unknown;
      try {
        response = await client.send(command);
      } catch (error) {
        throw new Error(describeBedrockError(error, { modelId: config.chatModelId, region: config.region }), {
          cause: error,
        });
      }

      const text = textBlocksOf(response);
      if (text.length === 0) {
        throw new ModelOutputError('Bedrock returned no text content in the Converse response.');
      }
      return text;
    },
  };
}

/** Picks the `Llm` implementation from `config.provider`. */
export function createLlm(config: Config): Llm {
  if (config.provider === 'bedrock') return createBedrockLlm(config.bedrock);
  return createOpenAILlm(config.llm);
}
