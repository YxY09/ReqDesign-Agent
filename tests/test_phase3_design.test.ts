import { describe, it, expect, vi } from "vitest";
import { SystemDesigner } from "../src/generators/design.js";

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

  it("should not crash when functions/entities are non-array", () => {
    const design = "## 模块划分\n\n## 核心类\n\n## 数据流";
    const req = { functions: "not_a_list", entities: "also_not_a_list" };
    const warnings = SystemDesigner.validateDesign(design, req);
    const coverageWarnings = warnings.filter((w) => w.includes("未在设计中体现"));
    expect(coverageWarnings.length).toBe(0);
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
});
