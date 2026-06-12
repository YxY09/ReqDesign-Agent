import { describe, it, expect } from "vitest";
import { AgentConfig } from "../src/config.js";

describe("RetryConfig defaults", () => {
  it("默认 maxRetries = 3", () => {
    const config = new AgentConfig();
    expect(config.retry.maxRetries).toBe(3);
  });

  it("默认 retryDelayMs = 1000", () => {
    const config = new AgentConfig();
    expect(config.retry.retryDelayMs).toBe(1000);
  });

  it("默认 maxDelayMs = 30000", () => {
    const config = new AgentConfig();
    expect(config.retry.maxDelayMs).toBe(30_000);
  });

  it("默认 timeout = 120", () => {
    const config = new AgentConfig();
    expect(config.llm.timeout).toBe(120);
  });

  it("默认 retryOnTimeout = true", () => {
    const config = new AgentConfig();
    expect(config.retry.retryOnTimeout).toBe(true);
  });
});

describe("RetryConfig validation", () => {
  it("maxRetries 为负数时验证报错", () => {
    const config = new AgentConfig();
    config.retry.maxRetries = -1;
    const errors = config.validate();
    expect(errors.some((e) => e.includes("maxRetries"))).toBe(true);
  });

  it("retryDelayMs 为 0 时验证报错", () => {
    const config = new AgentConfig();
    config.retry.retryDelayMs = 0;
    const errors = config.validate();
    expect(errors.some((e) => e.includes("retryDelayMs"))).toBe(true);
  });
});
