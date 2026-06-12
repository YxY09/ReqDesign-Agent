/**
 * LLM 客户端抽象层 — 统一接口，支持 OpenAI 兼容 Provider 和 Anthropic。
 *
 * Ported from reqdesign/llm_client.py (Phase 4)。
 *
 * @module llmClient
 */

import OpenAI, { type ClientOptions as OpenAIClientOptions } from "openai";
import Anthropic, { type ClientOptions as AnthropicClientOptions } from "@anthropic-ai/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentConfig } from "./config.js";
import { setupLogger, type Logger } from "./logger.js";
import { withRetry } from "./utils/retry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 流式回调 — 每次从 LLM 收到文本片段时调用。 */
export type OnChunk = (text: string) => void;

/** 已完成的 LLM 调用记录，通过 trace sink 发出。 */
export interface LlmCallInfo {
  tag: string;
  provider: string;
  model: string;
  /** 总耗时（毫秒）。 */
  durationMs: number;
  /** 发送的消息数。 */
  inputMessageCount: number;
  /** 连接后的提示词字符数。 */
  inputChars: number;
  /** 最后一条用户消息的前 2000 个字符。 */
  promptPreview: string;
  /** 完整的助手响应文本。 */
  responseText: string;
  /** 响应的字符数。 */
  responseChars: number;
  /** Token 用量（某些 provider 可能为 undefined）。 */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

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
  /** 请求中每条消息的角色（如 ["system", "user"]）。 */
  messageRoles?: string[];
  /** 最后一条用户消息的第一段（实际的问题/提示）。 */
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

/** 单条聊天消息格式，两个 SDK 都接受。 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Provider 默认值
// ---------------------------------------------------------------------------

const OPENAI_COMPAT_PROVIDERS = new Set([
  "openai",
  "deepseek",
  "qwen",
  "minimax",
  "kimi-coding",
  "zhipu",
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
 * OpenAI 兼容和 Anthropic LLM Provider 的统一异步客户端。
 *
 * 支持非流式和流式聊天补全，以及 JSON 和纯文本生成的便捷辅助方法。
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

  /** 替换 Python 的 threading.local() stream tag。 */
  private _streamTag = "";
  private readonly _streamTagContext = new AsyncLocalStorage<{
    tag: string;
    suffix: string;
  }>();
  private _streamListener: ((event: LlmStreamEvent) => void) | null = null;

  /** Trace sink — 运行时设置，用于将每次 LLM 调用记录到 TraceLogger。 */
  private _traceSink: ((info: LlmCallInfo) => void) | null = null;

  private readonly _retryConfig: {
    maxRetries: number;
    retryDelayMs: number;
    maxDelayMs: number;
    retryOnTimeout: boolean;
  };

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

    this._retryConfig = {
      maxRetries: config.retry.maxRetries,
      retryDelayMs: config.retry.retryDelayMs,
      maxDelayMs: config.retry.maxDelayMs,
      retryOnTimeout: config.retry.retryOnTimeout,
    };
  }

  // -----------------------------------------------------------------------
  // Stream tag (替换 thread-local storage)
  // -----------------------------------------------------------------------

  /** 用于自动启用流式传输的标签。设置了 streamTag 且没有提供 onChunk 时，自动启用流式传输。 */
  get streamTag(): string {
    const scoped = this._streamTagContext.getStore();
    return scoped ? LLMClient._formatScopedStreamTag(scoped.tag, scoped.suffix) : this._streamTag;
  }

  set streamTag(value: string) {
    const scoped = this._streamTagContext.getStore();
    if (scoped) {
      scoped.tag = value ?? "";
      return;
    }
    this._streamTag = value ?? "";
  }

  runWithStreamTagContext<T>(
    initialTag: string,
    suffix: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this._streamTagContext.run(
      {
        tag: initialTag,
        suffix,
      },
      fn,
    );
  }

  setStreamListener(listener?: (event: LlmStreamEvent) => void): void {
    this._streamListener = listener ?? null;
  }

  /** 设置 trace sink，用于记录每次完成的 LLM 调用。 */
  setTraceSink(sink: ((info: LlmCallInfo) => void) | null): void {
    this._traceSink = sink;
  }

  private static _formatScopedStreamTag(tag: string, suffix: string): string {
    const base = (tag || "").trim();
    const extra = suffix.trim();
    if (!base) return extra;
    if (!extra || base.includes(extra)) return base;
    return `${base} ${extra}`;
  }

  // -----------------------------------------------------------------------
  // Public API — chat
  // -----------------------------------------------------------------------

  /**
   * 发送聊天补全请求，返回完整的助手响应。
   *
   * 提供了 onChunk（或设置了 streamTag）时，响应会流式传输，
   * 回调函数会为每个文本片段调用。
   *
   * @param messages    - 对话消息列表。
   * @param temperature - 覆盖默认 temperature（可选）。
   * @param onChunk     - 流式回调（可选）。
   * @returns 完整的助手响应文本。
   */
  async chat(
    messages: ChatMessage[],
    temperature?: number,
    onChunk?: OnChunk,
  ): Promise<string> {
    const startTime = Date.now();
    const streamTag = this._streamTag;
    const chunkHandler = this._buildChunkHandler(onChunk, streamTag);
    const shouldStream = chunkHandler !== undefined;
    const emitMetadata = shouldStream && this._streamListener !== null && streamTag.trim().length > 0;
    if (emitMetadata) {
      // 提取提示词预览：最后一条用户消息，截断用于 TUI 显示。
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

    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const promptPreview = lastUserMsg
      ? lastUserMsg.content.slice(0, 2000)
      : "";
    const inputChars = messages.reduce((total, message) => total + Array.from(message.content).length, 0);

    // 为非流式调用创建 AbortController 超时控制
    const abortController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    if (!shouldStream) {
      const timeoutMs = (this.timeout ?? 120) * 1000;
      timeoutHandle = setTimeout(() => {
        abortController.abort();
        this._logger.warn(`[LLMClient] Request timed out after ${this.timeout}s`);
      }, timeoutMs);
    }

    try {
      let resultText: string;
      let usage: LlmTokenUsage | undefined;

      if (OPENAI_COMPAT_PROVIDERS.has(this.provider)) {
        if (shouldStream) {
          const response = await this._chatStreamOpenai(messages, temperature, chunkHandler);
          resultText = response.text;
          usage = response.usage;
        } else {
          resultText = await withRetry(
            async () => await this._chatOpenai(messages, temperature, abortController.signal),
            {
              maxRetries: this._retryConfig.maxRetries,
              baseDelayMs: this._retryConfig.retryDelayMs,
              maxDelayMs: this._retryConfig.maxDelayMs,
              shouldRetry: (error) => {
                if (error instanceof DOMException && error.name === "AbortError") {
                  return this._retryConfig.retryOnTimeout;
                }
                return true;
              },
              onRetry: (err, attempt) => {
                this._logger.warn(
                  `[LLMClient] Retry attempt ${attempt + 1}/${this._retryConfig.maxRetries}: ${err instanceof Error ? err.message : String(err)}`,
                );
              },
            },
          );
        }
      } else if (this.provider === "anthropic") {
        if (shouldStream) {
          const response = await this._chatAnthropic(messages, temperature, chunkHandler);
          resultText = response.text;
          usage = response.usage;
        } else {
          const result = await withRetry(
            async () => await this._chatAnthropic(messages, temperature, undefined),
            {
              maxRetries: this._retryConfig.maxRetries,
              baseDelayMs: this._retryConfig.retryDelayMs,
              maxDelayMs: this._retryConfig.maxDelayMs,
              onRetry: (err, attempt) => {
                this._logger.warn(
                  `[LLMClient] Retry attempt ${attempt + 1}/${this._retryConfig.maxRetries}: ${err instanceof Error ? err.message : String(err)}`,
                );
              },
            },
          );
          resultText = result.text;
          usage = result.usage;
        }
      } else {
        throw new Error(`[LLMClient] Unsupported provider: ${this.provider}`);
      }

      // 为 TUI / 运行时事件系统发出流元数据
      if (emitMetadata) {
        this._emitStreamEvent(streamTag, "end", {
          responseChars: Array.from(resultText).length,
          ...usage,
        });
        this._logger.info(
          `[LLMClient] Request completed: tag=${streamTag}, chars=${Array.from(resultText).length}, tokens=${usage?.totalTokens ?? "unknown"}`,
        );
      }

      // 发出结构化追踪记录
      this._emitTrace(streamTag, messages, inputChars, promptPreview, resultText, Date.now() - startTime, usage);

      return resultText;
    } catch (error) {
      if (emitMetadata) {
        const message = error instanceof Error ? error.message : String(error);
        this._logger.error(`[LLMClient] Request failed: tag=${streamTag}, error=${message}`);
        this._emitStreamEvent(streamTag, "end", { text: `error: ${message}` });
      }
      throw error;
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Public API — generate_json
  // -----------------------------------------------------------------------

  /**
   * 发送提示词并解析响应为 JSON。
   *
   * 处理 markdown 代码块、截断的 JSON、尾随逗号和单/双引号字符串。
   *
   * @param prompt   - 用户提示词。
   * @param system   - 可选的系统提示词。
   * @param onChunk  - 流式回调（可选）。
   * @returns 解析后的 JSON 对象。
   */
  async generateJson(
    prompt: string,
    system = "",
    onChunk?: OnChunk,
    temperature?: number,
  ): Promise<Record<string, unknown>> {
    const messages = buildMessages(prompt, system);
    const raw = await this.chat(messages, temperature, onChunk);
    return parseJsonResponse(raw);
  }

  // -----------------------------------------------------------------------
  // Public API — generate_text
  // -----------------------------------------------------------------------

  /**
   * 发送提示词并返回原始文本响应。
   *
   * @param prompt   - 用户提示词。
   * @param system   - 可选的系统提示词。
   * @param onChunk  - 流式回调（可选）。
   * @returns 助手响应文本。
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
  // Private — trace emission
  // -----------------------------------------------------------------------

  private _emitTrace(
    tag: string,
    messages: ChatMessage[],
    inputChars: number,
    promptPreview: string,
    responseText: string,
    durationMs: number,
    usage?: LlmTokenUsage,
  ): void {
    if (!this._traceSink) return;
    try {
      this._traceSink({
        tag,
        provider: this.provider,
        model: this.model,
        durationMs,
        inputMessageCount: messages.length,
        inputChars,
        promptPreview,
        responseText,
        responseChars: Array.from(responseText).length,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        totalTokens: usage?.totalTokens,
      });
    } catch {
      // 追踪发出绝不能导致主流程失败。
    }
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
      if (this.provider === "kimi-coding") {
        opts.defaultHeaders = { "User-Agent": "KimiCLI/1.5" };
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
    signal?: AbortSignal,
  ): Promise<string> {
    const client = this._client as OpenAI;

    const completion = await client.chat.completions.create(
      {
        model: this.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: temperature ?? this.temperature,
        max_tokens: this.maxTokens,
      },
      signal ? { signal } : undefined,
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

    // Anthropic 期望 system 作为顶级参数，而不是在 messages 中
    const systemMessage = messages.find((m) => m.role === "system")?.content ?? "";
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    if (onChunk) {
      return this._chatStreamAnthropic(client, systemMessage, nonSystemMessages, temperature, onChunk);
    }

    // 非流式
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
 * 从原始 LLM 响应中提取 JSON 文本。
 *
 * 处理：
 * - Markdown 代码块（```json ... ``` 或 ``` ... ```）
 * - 裸 JSON 对象/数组（括号匹配）
 * - 截断的响应（尽力提取）
 */
function extractJsonText(raw: string): string {
  const trimmed = raw.trim();

  // 1. 首先尝试 markdown 代码块
  //    ```json\n{...}\n``` 或 ```\n{...}\n```
  const codeBlockMatches = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)];
  for (const match of codeBlockMatches) {
    const candidate = match[1].trim();
    if (canParseJsonCandidate(candidate)) return candidate;
  }
  if (codeBlockMatches.length > 0) {
    return codeBlockMatches[0][1].trim();
  }

  // 2. 如果响应以 { 或 [ 开头，尝试括号匹配
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const extracted = matchBraces(trimmed);
    if (extracted && canParseJsonCandidate(extracted)) return extracted;
    if (extracted) return extracted;
  }

  // 3. 扫描第一个可解析的平衡 JSON 候选项。推理模型
  // 经常在实际的 JSON 对象前输出解释性文字或 <think> 块，
  // 其中可能包含 `{requirement_json}` 等占位符。
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== "{" && ch !== "[") continue;
    const extracted = matchBraces(trimmed.slice(i));
    if (extracted && canParseJsonCandidate(extracted)) return extracted;
  }

  // 4. 查找第一个 { 或 [，并返回从该位置开始的所有内容，
  // 作为最后的兜底方案，以便截断修复仍能运行。
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace !== -1) {
    const sub = trimmed.slice(firstBrace);
    const extracted = matchBraces(sub);
    if (extracted) return extracted;
    return sub;
  }

  // 5. 原样返回
  return trimmed;
}

/**
 * 匹配平衡的大括号/方括号，返回最外层的类 JSON 子串。
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

  // 未找到平衡匹配
  return null;
}

/**
 * 鲁棒地解析 JSON 字符串，处理常见的 LLM 工件：
 * - JavaScript 风格注释（// 和 /* *​/）
 * - ] 或 } 前的尾随逗号
 * - 截断的 JSON（尝试补全）
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
 * 从 JSON 字符串中移除 JS 风格注释和尾随逗号。
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

    // 单行注释 //
    if (ch === "/" && i + 1 < text.length && text[i + 1] === "/") {
      // 跳过直到行尾
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    // 多行注释 /* ... */
    if (ch === "/" && i + 1 < text.length && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && i + 1 < text.length && text[i + 1] === "/")) i++;
      i += 2; // 跳过 */
      continue;
    }

    result += ch;
    i++;
  }

  // 移除 } 或 ] 前的尾随逗号
  result = result.replace(/,\s*([}\]])/g, "$1");

  return result;
}

/**
 * 尝试通过关闭未完成的结构来修复截断的 JSON。
 *
 * 策略：
 * 1. 追踪未关闭的大括号/方括号（在字符串外）。
 * 2. 如果最后一个有意义的字符暗示截断在值中间，则剥离它。
 * 3. 关闭所有未完成的结构。
 */
function tryCompleteJson(text: string): string {
  let result = text.trimEnd();

  // 移除末尾不完整的 token（截断的字符串、数字等）
  // 启发式：如果文本不以 }、]、" 或数字结尾，则回退修剪
  result = result.replace(/[,:\s]+$/, "");

  // 追踪大括号和方括号的嵌套深度
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

  // 关闭未结束的字符串
  if (inString) {
    result += '"';
  }

  // 移除可能位于闭括号前的尾随逗号
  result = result.replace(/,\s*$/, "");

  // 按逆序关闭未完成的结构
  // 简单方法：先关闭所有方括号，再关闭所有大括号
  // （这是一个启发式方法——复杂嵌套结构可能无法完美修复）
  for (let i = 0; i < bracketDepth; i++) {
    result += "]";
  }
  for (let i = 0; i < braceDepth; i++) {
    result += "}";
  }

  return result;
}
