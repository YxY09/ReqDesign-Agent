import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { APIUserAbortError, APIConnectionTimeoutError } from "openai";
import { LLMClient, type LlmStreamEvent } from "../src/llmClient.js";
import { AgentConfig } from "../src/config.js";
import { isAbortError } from "../src/utils/errors.js";

describe("LLMClient timeout", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("_chatOpenai 接收到 AbortSignal 参数", async () => {
    const config = new AgentConfig();
    const llm = new LLMClient(config);

    let receivedSignal: AbortSignal | undefined;
    (llm as any)._chatOpenai = vi
      .fn()
      .mockImplementation(
        async (_msgs: any, _temp: any, signal: AbortSignal | undefined) => {
          receivedSignal = signal;
          return "ok";
        },
      );

    await llm.chat([{ role: "user", content: "hello" }]);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it("流式调用超时后 AbortController 中止挂起的 stream", async () => {
    const config = new AgentConfig();
    config.llm.timeout = 0.05; // 50ms 超时
    const llm = new LLMClient(config);

    // 替换 OpenAI client 的 create 方法，返回一个永远不 yield 的 async iterator
    // 并捕获传入的 signal
    let capturedSignal: AbortSignal | undefined;
    const fakeStream = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            // 挂起，直到 signal 中止。中止时抛出真实 SDK 中止错误。
            return new Promise<IteratorResult<any, any>>((_, reject) => {
              const abort = () => reject(new APIUserAbortError());
              if (capturedSignal?.aborted) {
                abort();
                return;
              }
              capturedSignal?.addEventListener("abort", abort);
            });
          },
        };
      },
    };
    (llm as any)._client = {
      chat: {
        completions: {
          create: async (_params: any, opts: any) => {
            capturedSignal = opts?.signal;
            return fakeStream;
          },
        },
      },
    };
    // 传入 onChunk 触发 streaming 路径
    const start = Date.now();
    await expect(
      llm.chat([{ role: "user", content: "hello" }], undefined, () => {}),
    ).rejects.toThrow();
    // 应当在 ~50ms 内超时（宽松上限 2s）
    expect(Date.now() - start).toBeLessThan(2000);
    // 信号确实被 AbortController 中止了
    expect(capturedSignal?.aborted).toBe(true);
  });

  // 流式路径中止回归：确保 isAbortError 在 OpenAI 流式路径被应用 ——
  // APIUserAbortError 不被吞没/不被转换、不重试，原样向上抛出。
  it("流式 OpenAI 路径中止：APIUserAbortError 正确抛出不吞没/不转换", async () => {
    const config = new AgentConfig();
    const llm = new LLMClient(config);

    const abortError = new APIUserAbortError();
    // mock create 返回一个 next() 立即抛出真实中止错误的 async iterator
    const fakeStream = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return Promise.reject(abortError);
          },
        };
      },
    };
    let createCalls = 0;
    (llm as any)._client = {
      chat: {
        completions: {
          create: async (_params: any, _opts: any) => {
            createCalls++;
            return fakeStream;
          },
        },
      },
    };

    // 传入 onChunk 触发流式路径
    let thrown: unknown;
    try {
      await llm.chat([{ role: "user", content: "hello" }], undefined, () => {});
    } catch (e) {
      thrown = e;
    }
    // 必须抛出，且是同一个中止错误（不被吞没/转换）
    expect(thrown).toBe(abortError);
    expect(isAbortError(thrown)).toBe(true);
    // 流式路径无 withRetry，create 只被调用一次（不重试）
    expect(createCalls).toBe(1);
  });

  // 流式路径中止回归：确保 Anthropic 流式路径的 AbortController/超时保护与
  // isAbortError 识别与 OpenAI 路径对称。
  it("流式 Anthropic 路径：超时触发 abort 并经 isAbortError 识别抛出", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "test-key";
    const config = new AgentConfig();
    config.llm.provider = "anthropic";
    config.llm.apiKey = "test-api-key";
    config.llm.timeout = 0.05; // 50ms 超时
    const llm = new LLMClient(config);

    let capturedSignal: AbortSignal | undefined;
    // mock messages.stream 返回 MessageStream-like 对象：异步迭代挂起，
    // 超时 abort 后以 constructor.name === 'APIUserAbortError' 形式拒绝
    // （模拟 Anthropic 跨包中止错误的 constructor.name 兜底路径）。
    const fakeStream = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise<IteratorResult<any, any>>((_, reject) => {
              const abort = () => {
                const e: { constructor: { name: string }; message: string } = {
                  constructor: { name: "APIUserAbortError" },
                  message: "Request was aborted.",
                };
                reject(e);
              };
              if (capturedSignal?.aborted) {
                abort();
                return;
              }
              capturedSignal?.addEventListener("abort", abort);
            });
          },
        };
      },
    };
    (llm as any)._client = {
      messages: {
        stream: (_body: any, opts: any) => {
          capturedSignal = opts?.signal;
          return fakeStream;
        },
      },
    };

    const start = Date.now();
    let thrown: unknown;
    try {
      await llm.chat([{ role: "user", content: "hello" }], undefined, () => {});
    } catch (e) {
      thrown = e;
    }
    // 超时后应抛出中止错误，并在 ~50ms 内（宽松上限 2s）
    expect(thrown).toBeDefined();
    expect(isAbortError(thrown)).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
    // AbortController 的确被超时中止
    expect(capturedSignal?.aborted).toBe(true);
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  it("retryOnTimeout=false + _chatOpenai 抛 AbortError → 不重试直接 throw", async () => {
    const config = new AgentConfig();
    config.retry.retryOnTimeout = false;
    config.retry.maxRetries = 3;
    const llm = new LLMClient(config);

    let calls = 0;
    (llm as any)._chatOpenai = vi.fn().mockImplementation(
      async (_msgs: any, _temp: any, _signal: AbortSignal | undefined) => {
        calls++;
        // 真实 SDK 抛出的是 APIUserAbortError，不是 DOMException
        throw new APIUserAbortError();
      },
    );

    await expect(
      llm.chat([{ role: "user", content: "hello" }]),
    ).rejects.toThrow("aborted");
    expect(calls).toBe(1); // 不重试
  });

  it("Bug 1 回归：重试时每次使用独立的 AbortController，第二次信号不预先中止", async () => {
    const config = new AgentConfig();
    config.retry.retryOnTimeout = true;
    config.retry.maxRetries = 2;
    config.retry.retryDelayMs = 5;
    config.retry.maxDelayMs = 20;
    const llm = new LLMClient(config);

    const signals: AbortSignal[] = [];
    (llm as any)._chatOpenai = vi.fn().mockImplementation(
      async (_msgs: any, _temp: any, signal: AbortSignal | undefined) => {
        signals.push(signal!);
        if (signals.length === 1) {
          // 真实 SDK 中止错误
          throw new APIUserAbortError();
        }
        return "ok";
      },
    );

    const result = await llm.chat([{ role: "user", content: "hello" }]);
    expect(result).toBe("ok");
    expect(signals).toHaveLength(2);
    // Each attempt must receive a distinct AbortSignal object
    expect(signals[0]).not.toBe(signals[1]);
    // The retry's signal must not already be aborted
    expect(signals[1].aborted).toBe(false);
  });

  it("Bug 3 回归：runWithStreamTagContext 内 chat() 使用 scoped streamTag 而非空的 _streamTag", async () => {
    const config = new AgentConfig();
    const llm = new LLMClient(config);

    const events: LlmStreamEvent[] = [];
    llm.setStreamListener((e) => events.push(e));

    // Scoped tag enables streaming (hasListener=true); mock the streaming path
    (llm as any)._chatStreamOpenai = vi
      .fn()
      .mockResolvedValue({ text: "ok", usage: undefined });

    await llm.runWithStreamTagContext("scoped-tag", "", async () => {
      await llm.chat([{ role: "user", content: "hello" }]);
    });

    const startEvents = events.filter((e) => e.kind === "start");
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].tag).toBe("scoped-tag");
    const endEvents = events.filter((e) => e.kind === "end");
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0].tag).toBe("scoped-tag");
  });

  it("runWithStreamTagContext 并发隔离：两个 worker 互不污染 streamTag", async () => {
    const config = new AgentConfig();
    const llm = new LLMClient(config);

    const observedTags: string[] = [];
    llm.setStreamListener((e) => {
      if (e.kind === "start") observedTags.push(e.tag);
    });

    // Both paths use the streaming route (mocked).
    (llm as any)._chatStreamOpenai = vi
      .fn()
      .mockResolvedValue({ text: "ok", usage: undefined });

    // Run two contexts concurrently — their tags must not bleed into each other.
    await Promise.all([
      llm.runWithStreamTagContext("[Worker:A]", "", () =>
        llm.chat([{ role: "user", content: "a" }]),
      ),
      llm.runWithStreamTagContext("[Worker:B]", "", () =>
        llm.chat([{ role: "user", content: "b" }]),
      ),
    ]);

    expect(observedTags).toHaveLength(2);
    // Each chat call should have received its own scoped tag, not the other's.
    expect(observedTags).toContain("[Worker:A]");
    expect(observedTags).toContain("[Worker:B]");
  });

  it("retryOnTimeout=true + _chatOpenai 抛 AbortError → 重试", async () => {
    const config = new AgentConfig();
    config.retry.retryOnTimeout = true;
    config.retry.maxRetries = 2;
    config.retry.retryDelayMs = 5;
    config.retry.maxDelayMs = 20;
    const llm = new LLMClient(config);

    let calls = 0;
    (llm as any)._chatOpenai = vi.fn().mockImplementation(
      async (_msgs: any, _temp: any, _signal: AbortSignal | undefined) => {
        calls++;
        if (calls <= 2) {
          // 真实 SDK 中止错误
          throw new APIUserAbortError();
        }
        return "ok-on-retry";
      },
    );

    const result = await llm.chat([{ role: "user", content: "hello" }]);
    expect(result).toBe("ok-on-retry");
    expect(calls).toBe(3); // 1 initial + 2 retries
  });
});

describe("isAbortError 检测真实 SDK 中止错误", () => {
  it("识别 OpenAI SDK 的 APIUserAbortError（真实类型，非 DOMException）", () => {
    const e = new APIUserAbortError();
    // 关键回归：旧的 DOMException 守卫对这个真实错误返回 false（失败）
    // isAbortError 必须返回 true
    expect(isAbortError(e)).toBe(true);
    // 确认这个错误确实不是 DOMException（正是旧守卫失败的原因）
    expect(e instanceof DOMException).toBe(false);
    expect(e.name).toBe("Error"); // APIUserAbortError.name === "Error"
  });

  it("识别通过 constructor.name 的中止错误（跨包兼容，如 Anthropic SDK）", () => {
    // 模拟 Anthropic SDK 的同名类实例（不同包，instanceof 不可靠）
    const fake = { constructor: { name: "APIUserAbortError" } };
    expect(isAbortError(fake)).toBe(true);
  });

  it("识别浏览器/Node 原生 DOMException AbortError", () => {
    const e = new DOMException("aborted", "AbortError");
    expect(isAbortError(e)).toBe(true);
  });

  it("识别 name === 'AbortError' 的通用中止错误（Node fetch abort）", () => {
    const e = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isAbortError(e)).toBe(true);
  });

  it("不误判 APIConnectionTimeoutError（保留超时重试语义）", () => {
    const e = new APIConnectionTimeoutError();
    expect(isAbortError(e)).toBe(false);
    expect(e.constructor.name).toBe("APIConnectionTimeoutError");
  });

  it("不误判普通网络错误", () => {
    expect(isAbortError(new Error("network error"))).toBe(false);
    expect(isAbortError(new Error("Request timed out."))).toBe(false);
  });

  it("对空值/非对象返回 false", () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError("error")).toBe(false);
    expect(isAbortError(42)).toBe(false);
  });
});
