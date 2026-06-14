import { describe, it, expect, vi } from "vitest";
import { SystemDesigner } from "../src/generators/design.js";
import { GenerationTool } from "../src/tools/generation.js";
import { createTask } from "../src/shared/types.js";
import * as promptLoader from "../src/promptLoader.js";
describe("SystemDesigner.validateDesign", () => {
  it("should warn on missing required sections", () => {
    const design = "这是一个设计方案，但缺少关键章节。";
    const req = { functions: [], entities: [] };
    const warnings = SystemDesigner.validateDesign(design, req);
    expect(warnings.some((w) => w.includes("模块划分"))).toBe(true);
    expect(warnings.some((w) => w.includes("核心类"))).toBe(true);
    expect(warnings.some((w) => w.includes("数据流"))).toBe(true);
  });

  it("should not warn when all sections are present", () => {
    const design =
      "## 模块划分\n\n| 模块名称 | 职责 |\n|----------|------|\n| 用户管理 | 管理用户 |\n\n## 核心类/接口设计\n\n| 类名 | 职责 |\n|------|------|\n| User | 用户 |\n\n## 数据流说明\n\n用户请求 -> 业务层 -> 数据层";
    const req = { functions: [], entities: [] };
    const warnings = SystemDesigner.validateDesign(design, req);
    const sectionWarnings = warnings.filter((w) => w.includes("章节"));
    expect(sectionWarnings.length).toBe(0);
  });

  it("should warn on uncovered functions", () => {
    const design = "## 模块划分\n\n## 核心类\n\n## 数据流\n\n包含F001功能。";
    const req = {
      functions: [
        { id: "F001", name: "用户登录" },
        { id: "F002", name: "用户注册" },
      ],
      entities: [],
    };
    const warnings = SystemDesigner.validateDesign(design, req);
    expect(warnings.some((w) => w.includes("F002"))).toBe(true);
  });

  it("should warn on self-invented requirement IDs in design", () => {
    const design = "## 模块划分\n\n帮助模块 F016。\n\n## 核心类\n\nHelpService。\n\n## 数据流\n\n支持 F013。";
    const req = {
      functions: [{ id: "FUN_HELP", displayId: "F001", name: "HelpService" }],
      entities: [],
      constraints: [],
      exceptions: [],
    };
    const warnings = SystemDesigner.validateDesign(design, req);
    expect(warnings.some((w) => w.includes("F013") && w.includes("F016"))).toBe(true);
  });

  it("should warn on uncovered entities", () => {
    const design = "## 模块划分\n\n## 核心类\n\n## 数据流\n\nUser类。";
    const req = {
      functions: [],
      entities: [
        { name: "User", description: "用户" },
        { name: "Order", description: "订单" },
      ],
    };
    const warnings = SystemDesigner.validateDesign(design, req);
    expect(warnings.some((w) => w.includes("Order"))).toBe(true);
  });

  it("should accept semantic aliases for entity names", () => {
    const design =
      "## 模块划分\n\n## 核心类\n\n```mermaid\nclassDiagram\nclass User {\n}\n```\n\n## 数据流\n\n请求处理流程。";
    const req = {
      functions: [],
      entities: [
        { name: "UserAccount", description: "用户账户" },
      ],
    };
    const warnings = SystemDesigner.validateDesign(design, req);
    expect(warnings.some((w) => w.includes("UserAccount"))).toBe(false);
  });

  it("should warn on extra core classes not in requirements", () => {
    const design =
      "## 模块划分\n\n## 核心类\n\n```mermaid\nclassDiagram\nclass User {\n}\nclass Coupon {\n}\n```\n\n## 数据流\n\n请求处理流程。";
    const req = {
      functions: [],
      entities: [
        { name: "UserAccount", description: "用户账户" },
      ],
    };
    const warnings = SystemDesigner.validateDesign(design, req);
    expect(warnings.some((w) => w.includes("Coupon"))).toBe(true);
  });

  it("should warn on extra core classes listed in the core class table", () => {
    const design =
      "## 模块划分\n\n包含F001。\n\n## 核心类/接口设计\n\n| 类名 | 职责 |\n|------|------|\n| `Order` | 订单 |\n| `OrderItem` | 订单明细 |\n\n## 数据流\n\n请求处理流程。";
    const req = {
      functions: [{ id: "F001", name: "CreateOrder" }],
      entities: [{ name: "Order", description: "订单" }],
    };
    const warnings = SystemDesigner.validateDesign(design, req);
    expect(warnings.some((w) => w.includes("OrderItem"))).toBe(true);
  });

  it("should warn when class diagrams reference undefined classes", () => {
    const design =
      "## 模块划分\n\n包含F001。\n\n## 核心类\n\n```mermaid\nclassDiagram\nclass Order {\n  +List~OrderItem~ items\n}\nOrder \"1\" --> \"*\" OrderItem : contains\n```\n\n## 数据流\n\n请求处理流程。";
    const req = {
      functions: [{ id: "F001", name: "CreateOrder" }],
      entities: [{ name: "Order", description: "订单" }],
    };
    const warnings = SystemDesigner.validateDesign(design, req);
    expect(warnings.some((w) => w.includes("OrderItem"))).toBe(true);
  });

  it("should have no coverage warnings when all covered", () => {
    const design =
      "## 模块划分\n\n包含F001用户登录功能。\n\n## 核心类\n\nUser类。\n\n## 数据流\n\n请求处理流程。";
    const req = {
      functions: [{ id: "F001", name: "用户登录" }],
      entities: [{ name: "User", description: "用户" }],
    };
    const warnings = SystemDesigner.validateDesign(design, req);
    const coverageWarnings = warnings.filter((w) => w.includes("未在设计中体现"));
    expect(coverageWarnings.length).toBe(0);
  });

  it("should treat function ID references as coverage even when English names are absent", () => {
    const design =
      "## 模块划分\n\n| 模块 | 对应功能 |\n|---|---|\n| 用户认证模块 | F001 |\n\n## 核心类\n\nUser类。\n\n## 数据流\n\n请求处理流程。";
    const req = {
      functions: [{ id: "F001", name: "UserRegistrationAndLogin" }],
      entities: [{ name: "User", description: "用户" }],
    };
    const warnings = SystemDesigner.validateDesign(design, req);
    expect(warnings.some((w) => w.includes("F001"))).toBe(false);
  });

  it("should not crash when functions/entities are non-array", () => {
    const design = "## 模块划分\n\n## 核心类\n\n## 数据流";
    const req = { functions: "not_a_list", entities: "also_not_a_list" };
    const warnings = SystemDesigner.validateDesign(design, req);
    const coverageWarnings = warnings.filter((w) => w.includes("未在设计中体现"));
    expect(coverageWarnings.length).toBe(0);
  });

  it("should require constraints and original exception IDs to be covered", () => {
    const design =
      "## 模块划分\n\n包含F001。\n\n## 核心类\n\nOrder类。\n\n## 数据流\n\n请求处理流程。\n\n## 约束与异常处理设计\n\nC001 已处理。E001 支付失败处理。";
    const req = {
      functions: [{ id: "F001", name: "CreateOrder" }],
      entities: [{ name: "Order", description: "订单" }],
      constraints: [{ id: "C001", description: "订单约束" }],
      exceptions: [{ id: "X001", description: "支付失败" }],
    };
    const warnings = SystemDesigner.validateDesign(design, req);
    // New merged format: "以下 N 个异常未在设计中体现: X001, ..."
    expect(warnings.some((w) => w.includes("X001") && w.includes("未在设计中体现"))).toBe(true);
    // "未定义异常 ID" 扫描已移除，不再检查设计中的 E 前缀 ID 是否在需求中定义
  });
});

describe("SystemDesigner.generateDesign (mock LLM)", () => {
  it("should return design with expected sections on success", async () => {
    const mockLLM = {
      generateText: vi
        .fn()
        .mockResolvedValue(
          "## 模块划分\n\n用户管理模块\n\n## 核心类\n\nUser类\n\n## 数据流\n\n请求处理",
        ),
    };
    const designer = new SystemDesigner(mockLLM as any);
    const req = { functions: [{ id: "F001", name: "用户登录" }], entities: [] };
    const result = await designer.generateDesign(req);
    expect(result.includes("模块划分")).toBe(true);
    expect(result.includes("核心类")).toBe(true);
    expect(mockLLM.generateText).toHaveBeenCalled();
  });

  it("should propagate LLM errors", async () => {
    const mockLLM = {
      generateText: vi.fn().mockRejectedValue(new Error("API timeout")),
    };
    const designer = new SystemDesigner(mockLLM as any);
    const req = { functions: [], entities: [] };
    await expect(designer.generateDesign(req)).rejects.toThrow("API timeout");
  });

  it("should pass requirement JSON into the prompt", async () => {
    const mockLLM = { generateText: vi.fn().mockResolvedValue("设计结果") };
    const designer = new SystemDesigner(mockLLM as any);
    const req = {
      functions: [{ id: "F001", name: "登录" }],
      entities: [{ name: "User" }],
    };
    await designer.generateDesign(req);
    const prompt: string = mockLLM.generateText.mock.calls[0][0];
    expect(prompt.includes("F001")).toBe(true);
    expect(prompt.includes("User")).toBe(true);
  });

  it("should pass requirement text into the prompt", async () => {
    const mockLLM = { generateText: vi.fn().mockResolvedValue("设计结果") };
    const designer = new SystemDesigner(mockLLM as any);
    const req = { functions: [], entities: [] };
    await designer.generateDesign(req, "订单创建后需要触发支付");
    const prompt: string = mockLLM.generateText.mock.calls[0][0];
    expect(prompt.includes("订单创建后需要触发支付")).toBe(true);
  });

  it("should require per-ID constraint enumeration in the prompt template", async () => {
    const mockLLM = { generateText: vi.fn().mockResolvedValue("设计结果") };
    const designer = new SystemDesigner(mockLLM as any);
    const req = {
      functions: [],
      entities: [],
      constraints: [{ id: "C001", description: "约束1" }],
    };
    await designer.generateDesign(req);
    const prompt: string = mockLLM.generateText.mock.calls[0][0];
    // The prompt must instruct the LLM to enumerate ALL constraint IDs individually
    expect(prompt).toMatch(/逐条/);
    expect(prompt).toMatch(/约束.*ID.*一一对应|每条约束/);
  });

  it("should inject a hard design contract into the prompt", async () => {
    const mockLLM = { generateText: vi.fn().mockResolvedValue("设计结果") };
    const designer = new SystemDesigner(mockLLM as any);
    const req = {
      functions: [{ id: "F043", name: "LogsAndAudit", description: "操作日志记录" }],
      entities: [{ name: "Order" }],
      constraints: [{ id: "C001", description: "订单约束" }],
      exceptions: [{ id: "X001", description: "支付失败" }],
    };
    await designer.generateDesign(req);
    const prompt: string = mockLLM.generateText.mock.calls[0][0];
    expect(prompt).toContain("设计合同");
    expect(prompt).toContain("F043 | LogsAndAudit");
    expect(prompt).toContain("Order");
    expect(prompt).toContain("X001 | 支付失败");
    expect(prompt).toContain("不能改成 E001");
  });

  it("should include design contract in prompt when fallback template is used", async () => {
    // Regression: fallback template must contain {requirement_text} placeholder
    // so the design contract is not silently dropped when design_planner.md fails to load.
    const loadPromptSpy = vi.spyOn(promptLoader, "loadPrompt");
    loadPromptSpy.mockReturnValue(
      "请根据以下需求分析结果生成系统设计方案：\n\n结构化需求：\n{requirement_json}\n\n{requirement_text}",
    );
    promptLoader.clearCache();

    const mockLLM = { generateText: vi.fn().mockResolvedValue("设计结果") };
    const designer = new SystemDesigner(mockLLM as any);
    const req = {
      functions: [{ id: "F001", name: "Login" }],
      entities: [{ name: "User" }],
    };
    await designer.generateDesign(req, "system prompt here");
    const prompt: string = mockLLM.generateText.mock.calls[0][0];

    // The design contract and system prompt should be injected via {requirement_text}
    expect(prompt).toContain("设计合同");
    expect(prompt).toContain("F001 | Login");
    expect(prompt).toContain("system prompt here");
    expect(prompt).not.toContain("{requirement_text}");

    loadPromptSpy.mockRestore();
  });
});

describe("GenerationTool self-check (no auto-repair)", () => {
  it("records self-check issues without attempting auto-repair", async () => {
    const badDesign =
      "## 模块划分\n\n| 模块 | 对应功能 |\n|---|---|\n| 用户模块 | F001 |\n\n## 核心类\n\nOrder类。\n\n## 数据流\n\n请求处理流程。";
    const llm = {
      generateText: vi.fn()
        .mockResolvedValueOnce(badDesign),
      generateJson: vi.fn(),
      runWithStreamTagContext: (_t: string, _s: string, fn: () => Promise<unknown>) => fn(),
    };
    const tool = new GenerationTool(llm as any);
    const artifact = await tool.execute(
      createTask({ id: "design-1", type: "design", description: "生成设计" }),
      {
        requirement_json: {
          functions: [{ id: "F001", name: "Login" }],
          entities: [{ name: "User", description: "用户" }],
        },
      },
    );

    // Self-check finds issues but does NOT auto-repair
    expect(artifact.selfCheckPassed).toBe(false);
    expect(artifact.content).toBe(badDesign);
    // LLM called only once (generation), NOT twice (generation + repair)
    expect(llm.generateText).toHaveBeenCalledTimes(1);
  });
});
