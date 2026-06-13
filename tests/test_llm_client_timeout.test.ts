import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LLMClient } from "../src/llmClient.js";
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
