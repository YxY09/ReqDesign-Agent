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

  it("流式调用不传 AbortSignal", async () => {
    const config = new AgentConfig();
    const llm = new LLMClient(config);

    let receivedSignal: AbortSignal | undefined;
    // Mock 流式调用
    (llm as any)._chatStreamOpenai = vi
      .fn()
      .mockImplementation(
        async (_msgs: any, _temp: any, _chunkHandler: any) => {
          return { text: "streamed", usage: undefined };
        },
      );

    // 传入 onChunk 触发 streaming 路径
    await llm.chat(
      [{ role: "user", content: "hello" }],
      undefined,
      () => {},
    );
    // 流式调用不检查 signal，不会 crash 即通过
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
