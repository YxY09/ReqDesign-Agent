import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LLMClient } from "../src/llmClient.js";
import { AgentConfig } from "../src/config.js";

function createMockOpenAI(failCount: number) {
  let calls = 0;
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async () => {
          calls++;
          if (calls <= failCount) {
            throw new Error("API rate limit exceeded");
          }
          return {
            choices: [{ message: { content: "mock-response" } }],
            usage: { total_tokens: 42 },
          };
        }),
      },
    },
  };
}

describe("LLMClient retry", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("API 首次成功时不触发重试", async () => {
    const config = new AgentConfig({
      retry: { maxRetries: 3, retryDelayMs: 10, maxDelayMs: 100, retryOnTimeout: true },
    });
    const mockClient = createMockOpenAI(0);
    const llm = new LLMClient(config);
    (llm as any)._client = mockClient as any;

    const result = await llm.chat([{ role: "user", content: "hello" }]);
    expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(result).toContain("mock-response");
  });

  it("API 前 2 次失败、第 3 次成功时自动重试", async () => {
    const config = new AgentConfig({
      retry: { maxRetries: 3, retryDelayMs: 10, maxDelayMs: 100, retryOnTimeout: true },
    });
    const mockClient = createMockOpenAI(2);
    const llm = new LLMClient(config);
    (llm as any)._client = mockClient as any;

    const result = await llm.chat([{ role: "user", content: "hello" }]);
    expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(3);
    expect(result).toContain("mock-response");
  });

  it("重试耗尽后抛出错误", async () => {
    const config = new AgentConfig({
      retry: { maxRetries: 2, retryDelayMs: 10, maxDelayMs: 100, retryOnTimeout: true },
    });
    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("persistent API error")),
        },
      },
    };
    const llm = new LLMClient(config);
    (llm as any)._client = mockClient as any;

    await expect(llm.chat([{ role: "user", content: "hello" }]))
      .rejects.toThrow("persistent API error");
    expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(3);
  });
});
