import { describe, it, expect } from "vitest";
import { parseAndValidate } from "../src/config.js";

describe("AgentConfigSchema", () => {
  it("空输入使用默认值", () => {
    const config = parseAndValidate({});
    expect(config.llm.provider).toBe("openai");
    expect(config.retry.maxRetries).toBe(3);
  });

  it("无效 provider 抛出 ZodError", () => {
    expect(() =>
      parseAndValidate({ llm: { provider: "invalid" } })
    ).toThrow();
  });

  it("负数 temperature 抛出 ZodError", () => {
    expect(() =>
      parseAndValidate({ llm: { temperature: -1 } })
    ).toThrow();
  });

  it("合法部分输入通过验证并使用默认值补全", () => {
    const config = parseAndValidate({
      llm: { provider: "deepseek", model: "deepseek-chat", temperature: 0.7 },
      retry: { maxRetries: 5 },
    });
    expect(config.llm.provider).toBe("deepseek");
    expect(config.retry.maxRetries).toBe(5);
    expect(config.llm.maxTokens).toBe(8192);
    expect(config.logging.level).toBe("INFO");
  });
});
