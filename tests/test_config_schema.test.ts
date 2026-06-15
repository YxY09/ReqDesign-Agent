import { describe, it, expect } from "vitest";
import { parseAndValidate, resolveTraceFlags } from "../src/config.js";

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

describe("output.trace schema", () => {
  it("默认 {} 展开为全开对象, fullDump=false", () => {
    const config = parseAndValidate({});
    expect(config.output.trace).toEqual({
      runSummary: true,
      llmTrace: true,
      multiAgentTrace: true,
      traceabilityMatrix: true,
      multiAgentTraceFullDump: false,
    });
  });

  it("接受布尔形式 (kill switch)", () => {
    const config = parseAndValidate({ output: { trace: false } });
    expect(config.output.trace).toBe(false);
  });

  it("接受对象形式且补全缺省字段", () => {
    const config = parseAndValidate({ output: { trace: { llmTrace: false } } });
    expect(config.output.trace).toEqual({
      runSummary: true,
      llmTrace: false,
      multiAgentTrace: true,
      traceabilityMatrix: true,
      multiAgentTraceFullDump: false,
    });
  });

  it("接受 run_summary 配置项", () => {
    const config = parseAndValidate({ output: { trace: { runSummary: false } } });
    expect(config.output.trace).toMatchObject({ runSummary: false });
  });
});

describe("resolveTraceFlags", () => {
  it("trace: true → 全开且 fullDump=false", () => {
    const flags = resolveTraceFlags(true);
    expect(flags).toEqual({
      runSummary: true,
      llmTrace: true,
      multiAgentTrace: true,
      traceabilityMatrix: true,
      multiAgentTraceFullDump: false,
    });
  });

  it("trace: false → 全关 (run_summary 仍保持开启)", () => {
    const flags = resolveTraceFlags(false);
    expect(flags.runSummary).toBe(true);
    expect(flags.llmTrace).toBe(false);
    expect(flags.multiAgentTrace).toBe(false);
    expect(flags.traceabilityMatrix).toBe(false);
    expect(flags.multiAgentTraceFullDump).toBe(false);
  });

  it("对象形式部分覆盖: 只开 llm_trace", () => {
    const flags = resolveTraceFlags({
      runSummary: true,
      llmTrace: true,
      multiAgentTrace: false,
      traceabilityMatrix: false,
      multiAgentTraceFullDump: false,
    });
    expect(flags.llmTrace).toBe(true);
    expect(flags.multiAgentTrace).toBe(false);
    expect(flags.traceabilityMatrix).toBe(false);
  });

  it("默认对象 {} → 全开且 fullDump=false", () => {
    const config = parseAndValidate({});
    const flags = resolveTraceFlags(config.output.trace);
    expect(flags).toEqual({
      runSummary: true,
      llmTrace: true,
      multiAgentTrace: true,
      traceabilityMatrix: true,
      multiAgentTraceFullDump: false,
    });
  });

  it("multi_agent_trace_full_dump 可单独开启", () => {
    const flags = resolveTraceFlags({
      runSummary: true,
      llmTrace: false,
      multiAgentTrace: true,
      traceabilityMatrix: false,
      multiAgentTraceFullDump: true,
    });
    expect(flags.multiAgentTraceFullDump).toBe(true);
    expect(flags.multiAgentTrace).toBe(true);
    expect(flags.llmTrace).toBe(false);
  });

  it("run_summary 可在对象形式下设为 false", () => {
    const flags = resolveTraceFlags({
      runSummary: false,
      llmTrace: true,
      multiAgentTrace: true,
      traceabilityMatrix: true,
      multiAgentTraceFullDump: false,
    });
    expect(flags.runSummary).toBe(false);
  });
});
