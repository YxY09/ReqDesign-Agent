import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LLMClient, type LlmStreamEvent } from "../src/llmClient.js";
import { AgentConfig } from "../src/config.js";

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
            // 挂起，直到 signal 中止
            return new Promise<IteratorResult<any, any>>((_, reject) => {
              if (capturedSignal?.aborted) {
                reject(new DOMException("Aborted", "AbortError"));
                return;
              }
              capturedSignal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
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

  it("retryOnTimeout=false + _chatOpenai 抛 AbortError → 不重试直接 throw", async () => {
    const config = new AgentConfig();
    config.retry.retryOnTimeout = false;
    config.retry.maxRetries = 3;
    const llm = new LLMClient(config);

    let calls = 0;
    (llm as any)._chatOpenai = vi.fn().mockImplementation(
      async (_msgs: any, _temp: any, _signal: AbortSignal | undefined) => {
        calls++;
        throw new DOMException("The operation was aborted", "AbortError");
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
          throw new DOMException("The operation was aborted", "AbortError");
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
          throw new DOMException("The operation was aborted", "AbortError");
        }
        return "ok-on-retry";
      },
    );

    const result = await llm.chat([{ role: "user", content: "hello" }]);
    expect(result).toBe("ok-on-retry");
    expect(calls).toBe(3); // 1 initial + 2 retries
  });
});
