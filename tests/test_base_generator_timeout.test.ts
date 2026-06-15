import { describe, it, expect, vi } from "vitest";
import { APIUserAbortError } from "openai";
import { BaseGenerator } from "../src/generators/base.js";
import type { LLMClient } from "../src/llmClient.js";

class ConcreteGenerator extends BaseGenerator<void> {
  async generate(): Promise<void> {}

  async testWithRetry(maxRetries: number) {
    return this.generateJsonWithRetry("prompt", "system", maxRetries);
  }
}

describe("BaseGenerator timeout handling", () => {
  it("Bug 2 回归：generateJsonWithRetry 在 AbortError 时不重试", async () => {
    let calls = 0;
    const mockLlm = {
      generateJson: vi.fn().mockImplementation(async () => {
        calls++;
        // 真实 SDK 抛出的是 APIUserAbortError（不是 DOMException）
        throw new APIUserAbortError();
      }),
    } as unknown as LLMClient;

    const gen = new ConcreteGenerator(mockLlm);
    // APIUserAbortError 必须被识别为中止错误并立即抛出，不重试
    await expect(gen.testWithRetry(3)).rejects.toBeInstanceOf(APIUserAbortError);
    // 必须不重试 —— 仅一次尝试
    expect(calls).toBe(1);
  });

  it("generateJsonWithRetry 仍然对非超时错误正常重试", async () => {
    let calls = 0;
    const mockLlm = {
      generateJson: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls < 3) throw new Error("network error");
        return { result: "ok" };
      }),
    } as unknown as LLMClient;

    const gen = new ConcreteGenerator(mockLlm);
    const result = await gen.testWithRetry(3);
    expect(result).toEqual({ result: "ok" });
    expect(calls).toBe(3);
  });
});
