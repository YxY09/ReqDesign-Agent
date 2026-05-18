/**
 * LLM client abstraction — unified interface across OpenAI-compatible and
 * Anthropic providers.
 *
 * Ported from reqdesign/llm_client.py (Phase 4).
 *
 * @module llmClient
 */

import OpenAI, { type ClientOptions as OpenAIClientOptions } from "openai";
import Anthropic, { type ClientOptions as AnthropicClientOptions } from "@anthropic-ai/sdk";
import type { AgentConfig } from "./config.js";
import { setupLogger, type Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Streaming callback — invoked for each text fragment received from the LLM. */
export type OnChunk = (text: string) => void;

export interface LlmStreamEvent {
  kind: "start" | "chunk" | "end";
  tag: string;
  text?: string;
  provider: string;
  model: string;
  timestamp: number;
  messageCount?: number;
  promptChars?: number;
  responseChars?: number;
  temperature?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Roles of each message in the request (e.g. ["system", "user"]). */
  messageRoles?: string[];
  /** First segment of the last user message (the actual question/prompt). */
  promptPreview?: string;
}

interface LlmTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

interface StreamResult {
  text: string;
  usage?: LlmTokenUsage;
}

/** A single chat message in the format accepted by both SDKs. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Provider defaults
// ---------------------------------------------------------------------------

const OPENAI_COMPAT_PROVIDERS = new Set([
  "openai",
  "deepseek",
  "qwen",
  "minimax",
]);

const DEFAULT_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  minimax: "https://api.minimax.chat/v1",
};

// ---------------------------------------------------------------------------
// LLMClient
// ---------------------------------------------------------------------------

/**
 * Unified async client for OpenAI-compatible and Anthropic LLM providers.
 *
 * Supports both non-streaming and streaming chat completions, as well as
 * convenience helpers for JSON and plain-text generation.
 */
export class LLMClient {
  readonly provider: string;
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly timeout: number;

  private readonly config: AgentConfig;
  private readonly _client: OpenAI | Anthropic;
  private readonly _logger: Logger;

  /** Replaces the Python `threading.local()` stream tag. */
  private _streamTag = "";
  private _streamListener: ((event: LlmStreamEvent) => void) | null = null;

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  constructor(config: AgentConfig) {
    this.config = config;
    this.provider = config.llm.provider;
    this.model = config.llm.model;
    this.temperature = config.llm.temperature;
    this.maxTokens = config.llm.maxTokens;
    this.timeout = config.llm.timeout;

    this._logger = setupLogger("reqdesign.llm", config.logging.level);

    const apiKey = config.getApiKey();
    if (!apiKey) {
      throw new Error(
        `[LLMClient] No API key configured for provider '${this.provider}'. ` +
          "Set the appropriate environment variable or add api_key to config.",
      );
    }

    this._client = this._initClient(apiKey);
  }

  // -----------------------------------------------------------------------
  // Stream tag (replaces thread-local storage)
  // -----------------------------------------------------------------------

  /** Tag used to auto-enable streaming. When non-empty and no `onChunk` is
   *  provided to {@link chat}, streaming is enabled automatically. */
  get streamTag(): string {
    return this._streamTag;
  }

  set streamTag(value: string) {
    this._streamTag = value ?? "";
  }

  setStreamListener(listener?: (event: LlmStreamEvent) => void): void {
    this._streamListener = listener ?? null;
  }

  // -----------------------------------------------------------------------
  // Public API — chat
  // -----------------------------------------------------------------------

  /**
   * Send a chat completion request and return the full assistant response.
   *
   * When `onChunk` is provided (or when `streamTag` is set), the response is
   * streamed and the callback is invoked for each text fragment.
   *
   * @param messages    - Conversation messages.
   * @param temperature - Override the default temperature (optional).
   * @param onChunk     - Streaming callback (optional).
   * @returns The full assistant response text.
   */
  async chat(
    messages: ChatMessage[],
    temperature?: number,
    onChunk?: OnChunk,
  ): Promise<string> {
    const streamTag = this._streamTag;
    const chunkHandler = this._buildChunkHandler(onChunk, streamTag);
    const shouldStream = chunkHandler !== undefined;
    const emitMetadata = shouldStream && this._streamListener !== null && streamTag.trim().length > 0;
    if (emitMetadata) {
      // Extract prompt preview: the last user message, bounded for TUI display.
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const promptPreview = lastUserMsg
        ? lastUserMsg.content.slice(0, 1200)
        : undefined;
      this._emitStreamEvent(streamTag, "start", {
        messageCount: messages.length,
        promptChars: messages.reduce((total, message) => total + Array.from(message.content).length, 0),
        temperature: temperature ?? this.temperature,
        messageRoles: messages.map((m) => m.role),
        promptPreview,
      });
      this._logger.info(
        `[LLMClient] Request started: tag=${streamTag}, provider=${this.provider}, model=${this.model}, messages=${messages.length}`,
      );
    }

    try {
      if (OPENAI_COMPAT_PROVIDERS.has(this.provider)) {
        if (shouldStream) {
          const response = await this._chatStreamOpenai(messages, temperature, chunkHandler);
          if (emitMetadata) {
            this._emitStreamEvent(streamTag, "end", {
              responseChars: Array.from(response.text).length,
              ...response.usage,
            });
            this._logger.info(
              `[LLMClient] Request completed: tag=${streamTag}, chars=${Array.from(response.text).length}, tokens=${response.usage?.totalTokens ?? "unknown"}`,
            );
          }
          return response.text;
        }
        return this._chatOpenai(messages, temperature);
      }

      if (this.provider === "anthropic") {
        const response = await this._chatAnthropic(messages, temperature, chunkHandler);
        if (emitMetadata) {
          this._emitStreamEvent(streamTag, "end", {
            responseChars: Array.from(response.text).length,
            ...response.usage,
          });
          this._logger.info(
            `[LLMClient] Request completed: tag=${streamTag}, chars=${Array.from(response.text).length}, tokens=${response.usage?.totalTokens ?? "unknown"}`,
          );
        }
        return response.text;
      }

      throw new Error(`[LLMClient] Unsupported provider: ${this.provider}`);
    } catch (error) {
      if (emitMetadata) {
        const message = error instanceof Error ? error.message : String(error);
        this._logger.error(`[LLMClient] Request failed: tag=${streamTag}, error=${message}`);
        this._emitStreamEvent(streamTag, "end", { text: `error: ${message}` });
      }
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // Public API — generate_json
  // -----------------------------------------------------------------------

  /**
   * Send a prompt and parse the response as JSON.
   *
   * Handles markdown code blocks, truncated JSON, trailing commas, and
   * single/double-quoted strings.
   *
   * @param prompt   - The user prompt.
   * @param system   - Optional system prompt.
   * @param onChunk  - Streaming callback (optional).
   * @returns Parsed JSON object.
   */
  async generateJson(
    prompt: string,
    system = "",
    onChunk?: OnChunk,
  ): Promise<Record<string, unknown>> {
    const messages = buildMessages(prompt, system);
    const raw = await this.chat(messages, undefined, onChunk);
    return parseJsonResponse(raw);
  }

  // -----------------------------------------------------------------------
  // Public API — generate_text
  // -----------------------------------------------------------------------

  /**
   * Send a prompt and return the raw text response.
   *
   * @param prompt   - The user prompt.
   * @param system   - Optional system prompt.
   * @param onChunk  - Streaming callback (optional).
   * @returns The assistant response text.
   */
  async generateText(
    prompt: string,
    system = "",
    onChunk?: OnChunk,
  ): Promise<string> {
    const messages = buildMessages(prompt, system);
    return this.chat(messages, undefined, onChunk);
  }

  // -----------------------------------------------------------------------
  // Private — client initialisation
  // -----------------------------------------------------------------------

  private _initClient(apiKey: string): OpenAI | Anthropic {
    if (OPENAI_COMPAT_PROVIDERS.has(this.provider)) {
      const baseUrl = this.config.getBaseUrl() || DEFAULT_BASE_URLS[this.provider] || undefined;
      const opts: OpenAIClientOptions = {
        apiKey,
        timeout: this.timeout * 1000,
      };
      if (baseUrl) {
        opts.baseURL = baseUrl;
      }
      this._logger.info(
        `LLMClient initialised: provider=${this.provider}, model=${this.model}` +
          (baseUrl ? `, baseUrl=${baseUrl}` : ""),
      );
      return new OpenAI(opts);
    }

    if (this.provider === "anthropic") {
      const baseUrl = this.config.getBaseUrl() || undefined;
      const opts: AnthropicClientOptions = {
        apiKey,
        timeout: this.timeout * 1000,
      };
      if (baseUrl) {
        opts.baseURL = baseUrl;
      }
      this._logger.info(
        `LLMClient initialised: provider=${this.provider}, model=${this.model}` +
          (baseUrl ? `, baseUrl=${baseUrl}` : ""),
      );
      return new Anthropic(opts);
    }

    throw new Error(`[LLMClient] Unsupported provider: ${this.provider}`);
  }

  // -----------------------------------------------------------------------
  // Private — OpenAI (non-streaming)
  // -----------------------------------------------------------------------

  private async _chatOpenai(
    messages: ChatMessage[],
    temperature?: number,
  ): Promise<string> {
    const client = this._client as OpenAI;

    const completion = await client.chat.completions.create(
      {
        model: this.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: temperature ?? this.temperature,
        max_tokens: this.maxTokens,
      },
      {
        // Let the OpenAI SDK handle retries internally
        maxRetries: this.config.retry.maxRetries,
      },
    );

    const content = completion.choices[0]?.message?.content ?? "";
    this._logUsage(completion.usage);
    return content;
  }

  private _buildChunkHandler(onChunk: OnChunk | undefined, streamTag: string): OnChunk | undefined {
    const hasListener = this._streamListener !== null && streamTag.trim().length > 0;
    if (!onChunk && !hasListener) {
      return undefined;
    }
    return (text: string) => {
      onChunk?.(text);
      if (hasListener && this._streamListener) {
        this._streamListener({
          kind: "chunk",
          tag: streamTag,
          text,
          provider: this.provider,
          model: this.model,
          timestamp: Date.now() / 1000,
        });
      }
    };
  }

  private _emitStreamEvent(
    streamTag: string,
    kind: "start" | "end",
    extras: Partial<Omit<LlmStreamEvent, "kind" | "tag" | "provider" | "model" | "timestamp">> = {},
  ): void {
    if (!this._streamListener || streamTag.trim().length === 0) return;
    this._streamListener({
      kind,
      tag: streamTag,
      provider: this.provider,
      model: this.model,
      timestamp: Date.now() / 1000,
      ...extras,
    });
  }

  // -----------------------------------------------------------------------
  // Private — OpenAI streaming
  // -----------------------------------------------------------------------

  private async _chatStreamOpenai(
    messages: ChatMessage[],
    temperature?: number,
    onChunk?: OnChunk,
  ): Promise<StreamResult> {
    const client = this._client as OpenAI;

    const stream = await client.chat.completions.create(
      {
        model: this.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: temperature ?? this.temperature,
        max_tokens: this.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      },
      {
        maxRetries: this.config.retry.maxRetries,
      },
    );

    let full = "";
    let usage: LlmTokenUsage | undefined;
    for await (const chunk of stream) {
      const rawUsage = (chunk as { usage?: OpenAI.Completions.CompletionUsage | null }).usage;
      if (rawUsage) {
        usage = {
          promptTokens: rawUsage.prompt_tokens,
          completionTokens: rawUsage.completion_tokens,
          totalTokens: rawUsage.total_tokens,
        };
      }
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        full += delta;
        onChunk?.(delta);
      }
    }

    this._logger.debug(`[LLMClient] Stream completed, ${full.length} chars`);
    return { text: full, usage };
  }

  // -----------------------------------------------------------------------
  // Private — Anthropic
  // -----------------------------------------------------------------------

  private async _chatAnthropic(
    messages: ChatMessage[],
    temperature?: number,
    onChunk?: OnChunk,
  ): Promise<StreamResult> {
    const client = this._client as Anthropic;

    // Anthropic expects system as a top-level parameter, not in messages
    const systemMessage = messages.find((m) => m.role === "system")?.content ?? "";
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    if (onChunk) {
      return this._chatStreamAnthropic(client, systemMessage, nonSystemMessages, temperature, onChunk);
    }

    // Non-streaming
    const msg = await client.messages.create(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system: systemMessage || undefined,
        messages: nonSystemMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        temperature: temperature ?? this.temperature,
      },
      {
        maxRetries: this.config.retry.maxRetries,
      },
    );

    const content = msg.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    this._logger.debug(
      `[LLMClient] Anthropic response: ${content.length} chars, ` +
        `input=${msg.usage.input_tokens}, output=${msg.usage.output_tokens}`,
    );
    return {
      text: content,
      usage: {
        promptTokens: msg.usage.input_tokens,
        completionTokens: msg.usage.output_tokens,
        totalTokens: msg.usage.input_tokens + msg.usage.output_tokens,
      },
    };
  }

  private async _chatStreamAnthropic(
    client: Anthropic,
    systemMessage: string,
    messages: ChatMessage[],
    temperature: number | undefined,
    onChunk: OnChunk,
  ): Promise<StreamResult> {
    const stream = client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemMessage || undefined,
      messages: messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      temperature: temperature ?? this.temperature,
    });

    let full = "";
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    for await (const event of stream) {
      const typedEvent = event as {
        type: string;
        message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (typedEvent.type === "message_start" && typedEvent.message?.usage) {
        promptTokens = typedEvent.message.usage.input_tokens ?? promptTokens;
        completionTokens = typedEvent.message.usage.output_tokens ?? completionTokens;
      }
      if (typedEvent.type === "message_delta" && typedEvent.usage) {
        completionTokens = typedEvent.usage.output_tokens ?? completionTokens;
      }
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        const text = event.delta.text;
        full += text;
        onChunk(text);
      }
    }

    this._logger.debug(`[LLMClient] Anthropic stream completed, ${full.length} chars`);
    return {
      text: full,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens !== undefined || completionTokens !== undefined
          ? (promptTokens ?? 0) + (completionTokens ?? 0)
          : undefined,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Private — logging
  // -----------------------------------------------------------------------

  private _logUsage(usage: OpenAI.Completions.CompletionUsage | undefined): void {
    if (!usage) return;
    this._logger.debug(
      `[LLMClient] Usage: prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}, total=${usage.total_tokens}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers — message building
// ---------------------------------------------------------------------------

function buildMessages(prompt: string, system: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (system) {
    messages.push({ role: "system", content: system });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

// ---------------------------------------------------------------------------
// Helpers — JSON extraction & repair
// ---------------------------------------------------------------------------

/**
 * Extract JSON text from a raw LLM response.
 *
 * Handles:
 * - Markdown code blocks (```json ... ``` or ``` ... ```)
 * - Bare JSON objects/arrays (brace/bracket matching)
 * - Truncated responses (best-effort extraction)
 */
function extractJsonText(raw: string): string {
  const trimmed = raw.trim();

  // 1. Try markdown code blocks first
  //    ```json\n{...}\n``` or ```\n{...}\n```
  const codeBlockMatches = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)];
  for (const match of codeBlockMatches) {
    const candidate = match[1].trim();
    if (canParseJsonCandidate(candidate)) return candidate;
  }
  if (codeBlockMatches.length > 0) {
    return codeBlockMatches[0][1].trim();
  }

  // 2. If the response starts with { or [, try brace matching
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const extracted = matchBraces(trimmed);
    if (extracted && canParseJsonCandidate(extracted)) return extracted;
    if (extracted) return extracted;
  }

  // 3. Scan for the first parseable balanced JSON candidate. Reasoning models
  // often emit prose or <think> blocks containing placeholders such as
  // `{requirement_json}` before the actual JSON object.
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== "{" && ch !== "[") continue;
    const extracted = matchBraces(trimmed.slice(i));
    if (extracted && canParseJsonCandidate(extracted)) return extracted;
  }

  // 4. Look for the first { or [ and return everything from there as a last
  // resort so truncation repair can still run.
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace !== -1) {
    const sub = trimmed.slice(firstBrace);
    const extracted = matchBraces(sub);
    if (extracted) return extracted;
    return sub;
  }

  // 5. Return as-is
  return trimmed;
}

/**
 * Match balanced braces/brackets and return the outermost JSON-like substring.
 */
function matchBraces(text: string): string | null {
  const openChar = text[0];
  const closeChar = openChar === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      if (inString) escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return text.slice(0, i + 1);
      }
    }
  }

  // No balanced match found
  return null;
}

/**
 * Robustly parse a JSON string, handling common LLM artefacts:
 * - JavaScript-style comments (// and /* *​/)
 * - Trailing commas before ] or }
 * - Truncated JSON (attempts completion)
 */
function parseJsonResponse(raw: string): Record<string, unknown> {
  const primary = extractJsonText(raw);
  const candidates = [
    primary,
    ...extractJsonCandidates(raw).filter((candidate) => candidate !== primary),
  ];
  let lastError: unknown = null;

  for (const jsonText of candidates) {
    try {
      return JSON.parse(jsonText) as Record<string, unknown>;
    } catch (err) {
      lastError = err;
    }

    const cleaned = stripCommentsAndTrailingCommas(jsonText);
    try {
      return JSON.parse(cleaned) as Record<string, unknown>;
    } catch (err) {
      lastError = err;
    }

    const completed = tryCompleteJson(cleaned);
    try {
      return JSON.parse(completed) as Record<string, unknown>;
    } catch (err) {
      lastError = err;
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError ?? "no JSON candidate found");
  throw new Error(
    `[LLMClient] Failed to parse JSON response after repair attempts: ${msg}\n` +
      `Raw (first 500 chars): ${raw.slice(0, 500)}`,
  );
}

function canParseJsonCandidate(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    try {
      JSON.parse(stripCommentsAndTrailingCommas(text));
      return true;
    } catch {
      return false;
    }
  }
}

function extractJsonCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | null | undefined) => {
    const candidate = value?.trim();
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  for (const match of trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)) {
    add(match[1]);
  }

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== "{" && ch !== "[") continue;
    add(matchBraces(trimmed.slice(i)));
  }

  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace !== -1) add(trimmed.slice(firstBrace));
  add(trimmed);
  return candidates;
}

/**
 * Remove JS-style comments and trailing commas from a JSON string.
 */
function stripCommentsAndTrailingCommas(text: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let escape = false;

  while (i < text.length) {
    const ch = text[i];

    if (escape) {
      result += ch;
      escape = false;
      i++;
      continue;
    }

    if (ch === "\\" && inString) {
      result += ch;
      escape = true;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      i++;
      continue;
    }

    if (inString) {
      result += ch;
      i++;
      continue;
    }

    // Single-line comment //
    if (ch === "/" && i + 1 < text.length && text[i + 1] === "/") {
      // Skip until end of line
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    // Multi-line comment /* ... */
    if (ch === "/" && i + 1 < text.length && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && i + 1 < text.length && text[i + 1] === "/")) i++;
      i += 2; // skip */
      continue;
    }

    result += ch;
    i++;
  }

  // Remove trailing commas before } or ]
  result = result.replace(/,\s*([}\]])/g, "$1");

  return result;
}

/**
 * Attempt to repair truncated JSON by closing open structures.
 *
 * Strategy:
 * 1. Track open braces/brackets (outside strings).
 * 2. If the last meaningful character suggests truncation mid-value, strip it.
 * 3. Close all open structures.
 */
function tryCompleteJson(text: string): string {
  let result = text.trimEnd();

  // Remove a trailing incomplete token (partial string, number, etc.)
  // Heuristic: if the text doesn't end with }, ], ", or a digit, trim back
  result = result.replace(/[,:\s]+$/, "");

  // Track nesting depth for braces and brackets
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < result.length; i++) {
    const ch = result[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth--;
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth--;
  }

  // Close unclosed string
  if (inString) {
    result += '"';
  }

  // Remove trailing comma that may precede closing brackets
  result = result.replace(/,\s*$/, "");

  // Close open structures in reverse order
  // Simple approach: close all brackets first, then all braces
  // (This is a heuristic — complex nested structures may not be perfectly repaired)
  for (let i = 0; i < bracketDepth; i++) {
    result += "]";
  }
  for (let i = 0; i < braceDepth; i++) {
    result += "}";
  }

  return result;
}
