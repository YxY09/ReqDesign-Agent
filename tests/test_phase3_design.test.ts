import { describe, it, expect, vi } from "vitest";
import { SystemDesigner } from "../src/generators/design.js";
import { GenerationTool } from "../src/tools/generation.js";
import { createTask, isDesignModel } from "../src/shared/types.js";
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

  it("should warn when a constraint ID appears with mismatched semantics", () => {
    const design =
      "## 模块划分\n\n包含F001。\n\n## 核心类\n\nOrder类。\n\n## 数据流\n\n请求处理流程。\n\n## 约束与异常处理设计\n\nC011 支付超时30分钟自动取消订单。";
    const req = {
      functions: [{ id: "F001", name: "CreateOrder" }],
      entities: [{ name: "Order", description: "订单" }],
      constraints: [{ id: "C011", description: "同一商品30天内只能追加评价一次" }],
    };
    const warnings = SystemDesigner.validateDesign(design, req);
    expect(warnings.some((w) =>
      w.includes("C011") && w.includes("语义未匹配"),
    )).toBe(true);
  });

  it("should accept constraint coverage when the ID line preserves the original semantics", () => {
    const design =
      "## 模块划分\n\n包含F001。\n\n## 核心类\n\nOrder类。\n\n## 数据流\n\n请求处理流程。\n\n## 设计覆盖矩阵\n\n| 类型 | 原始ID | 原始描述 | 设计决策 |\n|---|---|---|---|\n| 约束 | C011 | 同一商品30天内只能追加评价一次 | Review 服务按用户、商品和30天窗口校验追加评价次数 |";
    const req = {
      functions: [{ id: "F001", name: "CreateOrder" }],
      entities: [{ name: "Order", description: "订单" }],
      constraints: [{ id: "C011", description: "同一商品30天内只能追加评价一次" }],
    };
    const warnings = SystemDesigner.validateDesign(design, req);
    expect(warnings.some((w) =>
      w.includes("C011") && w.includes("语义未匹配"),
    )).toBe(false);
  });
});

const MINIMAL_DESIGN_JSON = {
  modules: [{ id: "MOD_USER", name: "用户模块", responsibility: "用户管理", functionIds: ["F001"] }],
  classes: [{ name: "UserService", kind: "helper", responsibility: "用户服务" }],
  dataFlows: [{ name: "登录流程", steps: ["client → UserService"], relatedFunctionIds: ["F001"] }],
  coverageMatrix: [{ refId: "F001", refKind: "function", originalDescription: "用户登录", designDecision: "UserService.login()", affectedModuleIds: ["MOD_USER"], affectedClassNames: ["UserService"], testImplication: "正常/异常登录" }],
};

describe("SystemDesigner.generateDesign (mock LLM)", () => {
  it("should return design with expected sections on success", async () => {
    const mockLLM = {
      generateJson: vi.fn().mockResolvedValue(MINIMAL_DESIGN_JSON),
    };
    const designer = new SystemDesigner(mockLLM as any);
    const req = { functions: [{ id: "F001", name: "用户登录" }], entities: [] };
    const result = await designer.generateDesign(req);
    expect(result.modules.length).toBeGreaterThan(0);
    expect(result.classes.length).toBeGreaterThan(0);
    expect(mockLLM.generateJson).toHaveBeenCalled();
  });

  it("should propagate LLM errors", async () => {
    const mockLLM = {
      generateJson: vi.fn().mockRejectedValue(new Error("API timeout")),
    };
    const designer = new SystemDesigner(mockLLM as any);
    const req = { functions: [], entities: [] };
    await expect(designer.generateDesign(req)).rejects.toThrow("API timeout");
  });

  it("should pass requirement JSON into the prompt", async () => {
    const mockLLM = { generateJson: vi.fn().mockResolvedValue(MINIMAL_DESIGN_JSON) };
    const designer = new SystemDesigner(mockLLM as any);
    const req = {
      functions: [{ id: "F001", name: "登录" }],
      entities: [{ name: "User" }],
    };
    await designer.generateDesign(req);
    const prompt: string = mockLLM.generateJson.mock.calls[0][0];
    expect(prompt.includes("F001")).toBe(true);
    expect(prompt.includes("User")).toBe(true);
  });

  it("should pass requirement text into the prompt", async () => {
    const mockLLM = { generateJson: vi.fn().mockResolvedValue(MINIMAL_DESIGN_JSON) };
    const designer = new SystemDesigner(mockLLM as any);
    const req = { functions: [], entities: [] };
    await designer.generateDesign(req, "订单创建后需要触发支付");
    const prompt: string = mockLLM.generateJson.mock.calls[0][0];
    expect(prompt.includes("订单创建后需要触发支付")).toBe(true);
  });

  it("should require per-ID constraint enumeration in the prompt template", async () => {
    const mockLLM = { generateJson: vi.fn().mockResolvedValue(MINIMAL_DESIGN_JSON) };
    const designer = new SystemDesigner(mockLLM as any);
    const req = {
      functions: [],
      entities: [],
      constraints: [{ id: "C001", description: "约束1" }],
    };
    await designer.generateDesign(req);
    const prompt: string = mockLLM.generateJson.mock.calls[0][0];
    // The prompt must instruct the LLM to enumerate ALL constraint IDs individually
    expect(prompt).toMatch(/逐条/);
    expect(prompt).toMatch(/约束.*ID|各写一条/);
  });

  it("should inject a hard design contract into the prompt", async () => {
    const mockLLM = { generateJson: vi.fn().mockResolvedValue(MINIMAL_DESIGN_JSON) };
    const designer = new SystemDesigner(mockLLM as any);
    const req = {
      functions: [{ id: "F043", name: "LogsAndAudit", description: "操作日志记录" }],
      entities: [{ name: "Order" }],
      constraints: [{ id: "C001", description: "订单约束" }],
      exceptions: [{ id: "X001", description: "支付失败" }],
    };
    await designer.generateDesign(req);
    const prompt: string = mockLLM.generateJson.mock.calls[0][0];
    expect(prompt).toContain("设计合同");
    expect(prompt).toContain("F043 | LogsAndAudit");
    expect(prompt).toContain("Order");
    expect(prompt).toContain("X001 | 支付失败");
    expect(prompt).toContain("设计覆盖矩阵");
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

    const mockLLM = { generateJson: vi.fn().mockResolvedValue(MINIMAL_DESIGN_JSON) };
    const designer = new SystemDesigner(mockLLM as any);
    const req = {
      functions: [{ id: "F001", name: "Login" }],
      entities: [{ name: "User" }],
    };
    await designer.generateDesign(req, "system prompt here");
    const prompt: string = mockLLM.generateJson.mock.calls[0][0];

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
    // DesignModel that has no functions covered in modules (missing F001 in functionIds)
    // so self-check will fail, but content should still be the DesignModel object
    const badDesignModel = {
      modules: [{ id: "MOD_USER", name: "用户模块", responsibility: "用户管理", functionIds: [] }],
      classes: [{ name: "Order", kind: "entity", responsibility: "订单" }],
      dataFlows: [{ name: "请求处理流程", steps: ["client → server"], relatedFunctionIds: [] }],
      coverageMatrix: [],
    };
    const llm = {
      generateJson: vi.fn().mockResolvedValueOnce(badDesignModel),
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
    expect(artifact.content).toMatchObject(badDesignModel);
    // LLM called only once (generation), NOT twice (generation + repair)
    expect(llm.generateJson).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// DesignModel tests (Phase A)
// ---------------------------------------------------------------------------

const MINIMAL_MODEL = {
  modules: [{ id: "MOD_USER", name: "用户模块", responsibility: "用户管理", functionIds: ["F001"] }],
  classes: [{ name: "UserService", kind: "helper" as const, responsibility: "用户服务" }],
  dataFlows: [{ name: "登录流程", steps: ["client → UserService", "UserService → DB"], relatedFunctionIds: ["F001"] }],
  coverageMatrix: [{ refId: "F001", refKind: "function" as const, originalDescription: "用户登录", designDecision: "UserService.login()", affectedModuleIds: ["MOD_USER"], affectedClassNames: ["UserService"], testImplication: "正常/异常登录场景" }],
};

describe("renderDesignMarkdown", () => {
  it("includes module section and function ID", () => {
    const md = SystemDesigner.renderDesignMarkdown(MINIMAL_MODEL);
    expect(md).toContain("## 模块划分");
    expect(md).toContain("F001");
    expect(md).toContain("用户模块");
  });

  it("includes class section with class name", () => {
    const md = SystemDesigner.renderDesignMarkdown(MINIMAL_MODEL);
    expect(md).toContain("## 核心类/接口设计");
    expect(md).toContain("UserService");
  });

  it("includes data flow section", () => {
    const md = SystemDesigner.renderDesignMarkdown(MINIMAL_MODEL);
    expect(md).toContain("## 数据流说明");
    expect(md).toContain("登录流程");
  });

  it("includes coverage matrix with refId", () => {
    const md = SystemDesigner.renderDesignMarkdown(MINIMAL_MODEL);
    expect(md).toContain("## 设计覆盖矩阵");
    expect(md).toContain("F001");
    expect(md).toContain("用户登录");
  });

  it("escapes pipe characters in LLM-supplied strings", () => {
    const modelWithPipe = {
      ...MINIMAL_MODEL,
      coverageMatrix: [{
        refId: "F001",
        refKind: "function" as const,
        originalDescription: "A | B",
        designDecision: "use C",
        affectedModuleIds: ["MOD_USER"],
        affectedClassNames: ["UserService"],
        testImplication: "test D",
      }],
    };
    const md = SystemDesigner.renderDesignMarkdown(modelWithPipe);
    expect(md).toContain("A \\| B");
    expect(md).not.toContain("| A | B |");
  });

  it("omits supplementaryClasses section when empty", () => {
    const md = SystemDesigner.renderDesignMarkdown(MINIMAL_MODEL);
    expect(md).not.toContain("补充核心类依据");
  });

  it("includes supplementaryClasses section when present", () => {
    const modelWithSupp = {
      ...MINIMAL_MODEL,
      supplementaryClasses: [{ name: "TokenHelper", justification: "需要生成JWT" }],
    };
    const md = SystemDesigner.renderDesignMarkdown(modelWithSupp);
    expect(md).toContain("## 补充核心类依据");
    expect(md).toContain("TokenHelper");
  });
});

describe("validateDesignModel", () => {
  it("warns when function not in any module functionIds", () => {
    const reqJson = { functions: [{ id: "F001", displayId: "F001" }, { id: "F002", displayId: "F002" }], constraints: [], exceptions: [] };
    const warnings = SystemDesigner.validateDesignModel(MINIMAL_MODEL, reqJson);
    expect(warnings.some((w) => w.includes("F002"))).toBe(true);
    expect(warnings.some((w) => w.includes("F001"))).toBe(false);
  });

  it("warns when constraint missing from coverageMatrix (by displayId)", () => {
    const reqJson = { functions: [], constraints: [{ id: "CON_PASS", displayId: "C001", description: "密码强度" }], exceptions: [] };
    const warnings = SystemDesigner.validateDesignModel(MINIMAL_MODEL, reqJson);
    expect(warnings.some((w) => w.includes("C001"))).toBe(true);
  });

  it("does not warn when constraint covered by canonical id form", () => {
    const modelWithConstraint = {
      ...MINIMAL_MODEL,
      coverageMatrix: [
        ...MINIMAL_MODEL.coverageMatrix,
        { refId: "CON_PASS", refKind: "constraint" as const, originalDescription: "密码", designDecision: "validate", affectedModuleIds: ["MOD_USER"], affectedClassNames: ["UserService"], testImplication: "边界" },
      ],
    };
    const reqJson = { functions: [], constraints: [{ id: "CON_PASS", displayId: "C001" }], exceptions: [] };
    const warnings = SystemDesigner.validateDesignModel(modelWithConstraint, reqJson);
    expect(warnings.some((w) => w.includes("C001") || w.includes("CON_PASS"))).toBe(false);
  });

  it("warns when exception missing from coverageMatrix", () => {
    const reqJson = { functions: [], constraints: [], exceptions: [{ id: "EXC_LOGIN", displayId: "X001", description: "登录失败" }] };
    const warnings = SystemDesigner.validateDesignModel(MINIMAL_MODEL, reqJson);
    expect(warnings.some((w) => w.includes("X001"))).toBe(true);
  });

  it("passes when all requirements covered", () => {
    const reqJson = { functions: [{ id: "F001", displayId: "F001" }], constraints: [], exceptions: [] };
    const warnings = SystemDesigner.validateDesignModel(MINIMAL_MODEL, reqJson);
    const uncoveredWarnings = warnings.filter((w) => w.includes("F001") && w.includes("未"));
    expect(uncoveredWarnings.length).toBe(0);
  });
});

describe("isDesignModel", () => {
  it("returns false for string", () => {
    expect(isDesignModel("hello")).toBe(false);
  });
  it("returns false for null", () => {
    expect(isDesignModel(null)).toBe(false);
  });
  it("returns false for object missing coverageMatrix array", () => {
    expect(isDesignModel({ modules: [], classes: [], dataFlows: [] })).toBe(false);
  });
  it("returns true for valid minimal model", () => {
    expect(isDesignModel(MINIMAL_MODEL)).toBe(true);
  });
});
