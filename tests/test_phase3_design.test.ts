import { describe, it, expect, vi } from "vitest";
import { SystemDesigner, extractSalientAnchors, textIncludesAnchor } from "../src/generators/design.js";
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

  it("should pass system prompt separately instead of duplicating it in the user prompt", async () => {
    const mockLLM = { generateJson: vi.fn().mockResolvedValue(MINIMAL_DESIGN_JSON) };
    const designer = new SystemDesigner(mockLLM as any);
    const req = { functions: [], entities: [] };
    await designer.generateDesign(req, "订单创建后需要触发支付");
    const prompt: string = mockLLM.generateJson.mock.calls[0][0];
    const systemPrompt: string = mockLLM.generateJson.mock.calls[0][1];
    expect(prompt.includes("订单创建后需要触发支付")).toBe(false);
    expect(systemPrompt).toBe("订单创建后需要触发支付");
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

  it("should inject a DesignBrief contract into the prompt", async () => {
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
    expect(prompt).toContain("DesignBrief");
    expect(prompt).toContain("designContract");
    expect(prompt).toContain("allowedFunctionIds");
    expect(prompt).toContain("coverageSkeleton");
    expect(prompt).toContain("F043");
    expect(prompt).toContain("LogsAndAudit");
    expect(prompt).toContain("Order");
    expect(prompt).toContain("X001");
    expect(prompt).toContain("支付失败");
    expect(prompt).toContain("coverageMatrix");
    expect(prompt).toContain("禁止输出 `FUN_*`、`CON_*`、`EXC_*`");
    expect(prompt).not.toContain("F043 | LogsAndAudit");
  });

  it("should include DesignBrief in prompt when fallback template is used", async () => {
    // Regression: fallback template must still receive the compact DesignBrief
    // even though {requirement_text} no longer carries a duplicated contract.
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
    const systemPrompt: string = mockLLM.generateJson.mock.calls[0][1];

    expect(prompt).toContain("designContract");
    expect(prompt).toContain("\"id\":\"F001\"");
    expect(prompt).toContain("\"name\":\"Login\"");
    expect(systemPrompt).toBe("system prompt here");
    expect(prompt).not.toContain("system prompt here");
    expect(prompt).not.toContain("{requirement_text}");

    loadPromptSpy.mockRestore();
  });
});

describe("GenerationTool self-check (no auto-repair)", () => {
  it("records self-check issues without attempting auto-repair", async () => {
    // DesignModel with NO coverage gap (F001 is mapped into a module, so the
    // derived coverageMatrix covers it) but a self-check failure that survives
    // reconciliation and is not a coverage gap: a class entityRef not in the
    // allowed entity list. This keeps the loop to a single LLM call (gaps==0 →
    // returns attempt 1) while still failing self-check.
    const badDesignModel = {
      modules: [{ id: "MOD_USER", name: "用户模块", responsibility: "用户管理", functionIds: ["F001"] }],
      classes: [{ name: "Order", kind: "domain", responsibility: "订单", entityRef: "NonExistent" }],
      dataFlows: [{ name: "请求处理流程", steps: ["client → server"], relatedFunctionIds: [] }],
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
          functions: [{ id: "F001", displayId: "F001", name: "Login" }],
          entities: [{ name: "User", description: "用户" }],
        },
      },
    );

    // Self-check finds issues but does NOT auto-repair
    expect(artifact.selfCheckPassed).toBe(false);
    // Content is still the generated DesignModel (assert the stable, LLM-authored
    // parts; coverageMatrix is now derived so it is intentionally not asserted).
    expect(artifact.content).toMatchObject({
      modules: badDesignModel.modules,
      classes: badDesignModel.classes,
    });
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
  constraintImplementations: [],
  exceptionImplementations: [],
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

  it("renders constraintImplementations as a first-class section with verbatim parameters", () => {
    const modelWithCI = {
      ...MINIMAL_MODEL,
      constraintImplementations: [
        {
          constraintId: "C001",
          sourceTextVerbatim: "The database is encrypted using AES/Rijndael (128-bit block, 256-bit key) and Twofish.",
          implementationMechanism: "EncryptionEngine 在 save() 中使用 AES/Rijndael (128-bit block, 256-bit key) 或 Twofish 加密数据库",
          parametersPreserved: ["AES/Rijndael", "Twofish", "128-bit block", "256-bit key"],
          trigger: "Database.save() 被调用时",
          handling: "用算法+随机 IV 加密整个数据库字节流",
          affectedModuleIds: ["MOD_SECURITY"],
          affectedClassNames: ["EncryptionEngine"],
        },
      ],
    };
    const md = SystemDesigner.renderDesignMarkdown(modelWithCI);
    expect(md).toContain("## 约束实现");
    expect(md).toContain("C001 约束实现");
    expect(md).toContain("256-bit key");
    expect(md).toContain("AES/Rijndael");
    expect(md).toContain("Twofish");
    // 约束实现章节必须出现在模块划分之前——judge 读 verbatim 证据时优先看到
    expect(md.indexOf("## 约束实现")).toBeLessThan(md.indexOf("## 模块划分"));
  });

  it("renders exceptionImplementations as a first-class section", () => {
    const modelWithEI = {
      ...MINIMAL_MODEL,
      exceptionImplementations: [
        {
          exceptionId: "X001",
          sourceTextVerbatim: "If the Master Password is lost, the database cannot be opened.",
          trigger: "Master Password 解密失败",
          handling: "Database.open 返回错误，禁止任何 recovery 路径",
          parametersPreserved: ["Master Password"],
          affectedModuleIds: ["MOD_DATABASE"],
          affectedClassNames: ["Database"],
        },
      ],
    };
    const md = SystemDesigner.renderDesignMarkdown(modelWithEI);
    expect(md).toContain("## 异常实现");
    expect(md).toContain("X001 异常实现");
    expect(md).toContain("Master Password");
  });

  it("does not crash when a dataFlow lacks relatedFunctionIds/steps", () => {
    // Simulates a repaired LLM payload that omits relatedFunctionIds/steps —
    // the fields are optional at runtime even though the type declares them.
    const modelWithSparseFlow = {
      ...MINIMAL_MODEL,
      dataFlows: [{ name: "稀疏流程" }],
    } as unknown as Parameters<typeof SystemDesigner.renderDesignMarkdown>[0];
    const md = SystemDesigner.renderDesignMarkdown(modelWithSparseFlow);
    expect(md).toContain("## 数据流说明");
    expect(md).toContain("稀疏流程");
  });
});

describe("parseDesignModel dataFlow coercion", () => {
  it("normalizes dataFlows missing relatedFunctionIds/steps to empty arrays", () => {
    const raw = {
      modules: MINIMAL_MODEL.modules,
      classes: MINIMAL_MODEL.classes,
      dataFlows: [{ name: "登录流程" }], // missing steps + relatedFunctionIds
      coverageMatrix: [],
      constraintImplementations: [],
      exceptionImplementations: [],
    };
    const parsed = SystemDesigner.parseDesignModel(raw);
    expect(parsed).not.toBeNull();
    const flow = parsed!.dataFlows[0];
    expect(Array.isArray(flow.steps)).toBe(true);
    expect(flow.steps).toEqual([]);
    expect(Array.isArray(flow.relatedFunctionIds)).toBe(true);
    expect(flow.relatedFunctionIds).toEqual([]);
    // Rendering the parsed model must not throw.
    expect(() => SystemDesigner.renderDesignMarkdown(parsed!)).not.toThrow();
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

  it("accepts canonical id coverage but warns that display id should be used", () => {
    const modelWithConstraint = {
      ...MINIMAL_MODEL,
      coverageMatrix: [
        ...MINIMAL_MODEL.coverageMatrix,
        { refId: "CON_PASS", refKind: "constraint" as const, originalDescription: "密码", designDecision: "validate", affectedModuleIds: ["MOD_USER"], affectedClassNames: ["UserService"], testImplication: "边界" },
      ],
    };
    const reqJson = { functions: [], constraints: [{ id: "CON_PASS", displayId: "C001" }], exceptions: [] };
    const warnings = SystemDesigner.validateDesignModel(modelWithConstraint, reqJson);
    expect(warnings.some((w) => w.includes("约束 C001 未在 coverageMatrix 中体现"))).toBe(false);
    expect(warnings.some((w) => w.includes("内部 ID CON_PASS") && w.includes("display ID C001"))).toBe(true);
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


// ---------------------------------------------------------------------------
// SystemDesigner.reconcileDesignModel — deterministic dangling-ref repair
// ---------------------------------------------------------------------------

describe("SystemDesigner.reconcileDesignModel", () => {
  const reqJson = {
    functions: [{ id: "F001", displayId: "F001", name: "登录" }],
    constraints: [{ id: "CON_a", displayId: "C001", description: "密码强度" }],
    exceptions: [],
    entities: [],
  };
  // Dangling class/module refs live in the constraintImplementation blocks the
  // LLM still authors (coverageMatrix is derived, not LLM-authored, so reconcile
  // no longer touches it).
  const baseModel = () => ({
    modules: [{ id: "MOD_USER", name: "用户", responsibility: "r", functionIds: ["F001", "F999"] }],
    classes: [{ name: "UserService", kind: "helper" as const, responsibility: "r" }],
    dataFlows: [],
    constraintImplementations: [
      {
        constraintId: "C001",
        sourceTextVerbatim: "",
        implementationMechanism: "校验密码强度规则，长度与复杂度检查",
        parametersPreserved: [],
        trigger: "",
        handling: "",
        affectedModuleIds: ["MOD_USER", "MOD_GHOST"],
        affectedClassNames: ["PrescriptionApprovalService", "user_service"],
      },
    ],
    exceptionImplementations: [],
    coverageMatrix: [],
  });

  it("promotes an undefined class referenced in an impl block into supplementaryClasses", () => {
    const result = SystemDesigner.reconcileDesignModel(baseModel(), reqJson);
    const suppNames = (result.supplementaryClasses ?? []).map((s) => s.name);
    expect(suppNames).toContain("PrescriptionApprovalService");
    expect(result.constraintImplementations[0].affectedClassNames).toContain("PrescriptionApprovalService");
  });

  it("remaps a normalized class-name variant to the canonical defined class (no promotion)", () => {
    const result = SystemDesigner.reconcileDesignModel(baseModel(), reqJson);
    expect(result.constraintImplementations[0].affectedClassNames).toContain("UserService");
    expect(result.constraintImplementations[0].affectedClassNames).not.toContain("user_service");
    const suppNames = (result.supplementaryClasses ?? []).map((s) => s.name);
    expect(suppNames).not.toContain("user_service");
  });

  it("drops affectedModuleIds referencing an undefined module", () => {
    const result = SystemDesigner.reconcileDesignModel(baseModel(), reqJson);
    expect(result.constraintImplementations[0].affectedModuleIds).toEqual(["MOD_USER"]);
  });

  it("drops module.functionIds referencing a non-existent requirement id", () => {
    const result = SystemDesigner.reconcileDesignModel(baseModel(), reqJson);
    expect(result.modules[0].functionIds).toEqual(["F001"]);
  });

  it("does not mutate the input model (returns a deep clone)", () => {
    const input = baseModel();
    SystemDesigner.reconcileDesignModel(input, reqJson);
    expect(input.modules[0].functionIds).toEqual(["F001", "F999"]);
    expect(input.constraintImplementations[0].affectedClassNames).toEqual([
      "PrescriptionApprovalService",
      "user_service",
    ]);
    expect(input.constraintImplementations[0].affectedModuleIds).toEqual(["MOD_USER", "MOD_GHOST"]);
  });

  it("clears the 未定义的类 self-check warning after reconciliation", () => {
    const before = SystemDesigner.validateDesignModel(baseModel(), reqJson);
    expect(before.some((w) => w.includes("引用了未定义的类"))).toBe(true);
    const result = SystemDesigner.reconcileDesignModel(baseModel(), reqJson);
    const after = SystemDesigner.validateDesignModel(result, reqJson);
    expect(after.some((w) => w.includes("引用了未定义的类"))).toBe(false);
    expect(after.some((w) => w.includes("未定义的需求 ID"))).toBe(false);
    expect(after.some((w) => w.includes("引用了未定义的模块"))).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// SystemDesigner.buildCoverageMatrix — deterministic traceability index
// ---------------------------------------------------------------------------

describe("SystemDesigner.buildCoverageMatrix", () => {
  const req = {
    functions: [
      { id: "F001", displayId: "F001", name: "登录" },
      { id: "F002", displayId: "F002", name: "登出" }, // unmapped → no row
    ],
    constraints: [{ id: "CON_a", displayId: "C001", description: "密码强度" }],
    exceptions: [{ id: "EXC_a", displayId: "X001", description: "登录失败" }],
    entities: [],
  };
  const model = () => ({
    modules: [{ id: "MOD_USER", name: "用户", responsibility: "r", functionIds: ["F001"] }],
    classes: [{ name: "UserService", kind: "helper" as const, responsibility: "r" }],
    dataFlows: [],
    constraintImplementations: [
      { constraintId: "C001", sourceTextVerbatim: "", implementationMechanism: "校验密码长度≥8", parametersPreserved: [], trigger: "", handling: "", affectedModuleIds: ["MOD_USER"], affectedClassNames: ["UserService"] },
    ],
    exceptionImplementations: [
      { exceptionId: "X001", sourceTextVerbatim: "", trigger: "", handling: "拒绝登录", parametersPreserved: [], affectedModuleIds: ["MOD_USER"], affectedClassNames: ["UserService"] },
    ],
    coverageMatrix: [],
  });

  it("derives one row per covered item, copying refs from impl blocks / module mapping", () => {
    const cm = SystemDesigner.buildCoverageMatrix(model(), req);
    const byId = Object.fromEntries(cm.map((r) => [r.refId, r]));
    expect(byId["F001"].refKind).toBe("function");
    expect(byId["F001"].affectedModuleIds).toEqual(["MOD_USER"]);
    expect(byId["C001"].designDecision).toBe("见 constraintImplementations[C001]");
    expect(byId["C001"].affectedClassNames).toEqual(["UserService"]);
    expect(byId["X001"].designDecision).toBe("见 exceptionImplementations[X001]");
  });

  it("omits uncovered items (unmapped function / missing impl block)", () => {
    const cm = SystemDesigner.buildCoverageMatrix(model(), req);
    expect(cm.some((r) => r.refId === "F002")).toBe(false);
  });

  it("references only classes that exist in the impl blocks (fabrication impossible)", () => {
    const cm = SystemDesigner.buildCoverageMatrix(model(), req);
    for (const r of cm) {
      for (const c of r.affectedClassNames) {
        expect(c).toBe("UserService");
      }
    }
  });
});


// ---------------------------------------------------------------------------
// SystemDesigner.checkCoverageGaps — coverage matrix gap detection
// ---------------------------------------------------------------------------

describe("SystemDesigner.checkCoverageGaps", () => {
  it("returns empty when all items covered", () => {
    const model = {
      modules: [{ id: "MOD_USER", name: "User", responsibility: "r", functionIds: ["F001"] }],
      classes: [],
      dataFlows: [],
      constraintImplementations: [
        {
          constraintId: "C001",
          sourceTextVerbatim: "用户密码长度必须不少于8位",
          implementationMechanism: "UserService 在 register 时强制校验密码长度不少于8位",
          parametersPreserved: ["8位"],
          trigger: "用户提交注册请求时",
          handling: "若密码长度低于8位则拒绝注册",
          affectedModuleIds: ["MOD_USER"],
          affectedClassNames: ["UserService"],
        },
      ],
      exceptionImplementations: [
        {
          exceptionId: "X001",
          sourceTextVerbatim: "密码错误时拒绝登录",
          trigger: "用户输入错误密码",
          handling: "返回 401，提示密码错误",
          parametersPreserved: [],
          affectedModuleIds: ["MOD_USER"],
          affectedClassNames: ["UserService"],
        },
      ],
      coverageMatrix: [
        { refId: "F001", refKind: "function" as const, originalDescription: "d", designDecision: "d", affectedModuleIds: [], affectedClassNames: [], testImplication: "t" },
        { refId: "C001", refKind: "constraint" as const, originalDescription: "d", designDecision: "见 constraintImplementations[C001]", affectedModuleIds: [], affectedClassNames: [], testImplication: "t" },
        { refId: "X001", refKind: "exception" as const, originalDescription: "d", designDecision: "见 exceptionImplementations[X001]", affectedModuleIds: [], affectedClassNames: [], testImplication: "t" },
      ],
    };
    const req = {
      functions: [{ displayId: "F001", id: "FUN_abc", name: "Login" }],
      constraints: [{ displayId: "C001", id: "CON_def", description: "c", source_text: "用户密码长度必须不少于8位" }],
      exceptions: [{ displayId: "X001", id: "EXC_ghi", description: "e", source_text: "密码错误时拒绝登录" }],
    };
    const gaps = SystemDesigner.checkCoverageGaps(model, req);
    expect(gaps).toHaveLength(0);
  });

  it("detects uncovered functions, constraints, and exceptions", () => {
    const model = {
      modules: [{ id: "MOD_USER", name: "User", responsibility: "r", functionIds: ["F001"] }],
      classes: [],
      dataFlows: [],
      constraintImplementations: [],
      exceptionImplementations: [],
      coverageMatrix: [
        { refId: "F001", refKind: "function" as const, originalDescription: "d", designDecision: "d", affectedModuleIds: [], affectedClassNames: [], testImplication: "t" },
      ],
    };
    const req = {
      functions: [{ displayId: "F001", id: "FUN_abc", name: "Login" }, { displayId: "F002", id: "FUN_def", name: "Register" }],
      constraints: [{ displayId: "C001", id: "CON_ghi", description: "c" }],
      exceptions: [{ displayId: "X001", id: "EXC_jkl", description: "e" }],
    };
    const gaps = SystemDesigner.checkCoverageGaps(model, req);
    expect(gaps).toHaveLength(3); // F002 (no coverage), C001 (no impl block), X001 (no impl block)
    expect(gaps.map((g) => g.id).sort()).toEqual(["C001", "F002", "X001"]);
  });

  it("matches a constraint by canonical id when displayId absent", () => {
    const model = {
      modules: [],
      classes: [],
      dataFlows: [],
      constraintImplementations: [
        {
          constraintId: "CON_abc",
          sourceTextVerbatim: "用户必须先完成实名认证",
          implementationMechanism: "UserService.register 在创建账户前调用 KycService 完成实名认证流程",
          parametersPreserved: [],
          trigger: "用户注册请求",
          handling: "未通过认证则注册失败",
          affectedModuleIds: ["MOD_USER"],
          affectedClassNames: ["UserService", "KycService"],
        },
      ],
      exceptionImplementations: [],
      coverageMatrix: [],
    };
    const req = {
      functions: [],
      constraints: [{ displayId: "", id: "CON_abc", description: "c", source_text: "用户必须先完成实名认证" }],
      exceptions: [],
    };
    const gaps = SystemDesigner.checkCoverageGaps(model, req);
    expect(gaps).toHaveLength(0);
  });

  it("handles empty requirement gracefully", () => {
    const model = {
      modules: [],
      classes: [],
      dataFlows: [],
      constraintImplementations: [],
      exceptionImplementations: [],
      coverageMatrix: [],
    };
    const req: Record<string, unknown> = { functions: [], constraints: [], exceptions: [] };
    const gaps = SystemDesigner.checkCoverageGaps(model, req);
    expect(gaps).toHaveLength(0);
  });

  it("flags constraints with NO constraintImplementation block as gaps", () => {
    // Listed in coverageMatrix but missing from the first-class
    // constraintImplementations block → fail-closed gap. This is the new
    // primary check: the coverageMatrix one-liner is no longer enough to
    // claim a constraint is implemented.
    const model = {
      modules: [],
      classes: [],
      dataFlows: [],
      constraintImplementations: [
        {
          constraintId: "C003",
          sourceTextVerbatim: "抗生素处方必须由主任医师审核",
          implementationMechanism: "RxService 在处方提交时检查抗生素标记并强制主任医师审核流程",
          parametersPreserved: ["抗生素", "主任医师"],
          trigger: "处方提交且包含抗生素",
          handling: "若未经过主任医师审核则拒绝处方",
          affectedModuleIds: ["MOD_RX"],
          affectedClassNames: ["RxService"],
        },
      ],
      exceptionImplementations: [],
      coverageMatrix: [
        { refId: "C001", refKind: "constraint" as const, originalDescription: "", designDecision: "见 constraintImplementations[C001]", affectedModuleIds: [], affectedClassNames: [], testImplication: "t" },
        { refId: "C002", refKind: "constraint" as const, originalDescription: "", designDecision: "ok", affectedModuleIds: [], affectedClassNames: [], testImplication: "t" },
        { refId: "C003", refKind: "constraint" as const, originalDescription: "抗生素", designDecision: "见 constraintImplementations[C003]", affectedModuleIds: ["MOD_RX"], affectedClassNames: ["RxService"], testImplication: "t" },
      ],
    };
    const req = {
      functions: [],
      constraints: [
        { displayId: "C001", id: "CON_a", source_text: "审计跟踪数据不可修改与删除" },
        { displayId: "C002", id: "CON_b", source_text: "系统响应时间必须低于两秒钟以内" },
        { displayId: "C003", id: "CON_c", source_text: "抗生素处方必须由主任医师审核" },
      ],
      exceptions: [],
    };
    const gaps = SystemDesigner.checkCoverageGaps(model, req);
    // C001 and C002 lack constraintImplementations entries; C003 has one
    // with a passing param check.
    expect(gaps.map((g) => g.id).sort()).toEqual(["C001", "C002"]);
    expect(gaps.map((g) => g.id)).not.toContain("C003");
  });

  it("flags a constraint as a gap when its implementationMechanism omits a source anchor", () => {
    // Has a constraintImplementation entry but the mechanism does NOT mention
    // the source anchor "256-bit" → fail because the parameter is lost.
    const model = {
      modules: [],
      classes: [],
      dataFlows: [],
      constraintImplementations: [
        {
          constraintId: "C001",
          sourceTextVerbatim: "数据库使用 AES (256-bit key) 加密",
          implementationMechanism: "EncryptionEngine 使用 AES 算法加密数据库",
          parametersPreserved: ["AES"],
          trigger: "save() 时",
          handling: "加密整个数据库",
          affectedModuleIds: ["MOD_SEC"],
          affectedClassNames: ["EncryptionEngine"],
        },
      ],
      exceptionImplementations: [],
      coverageMatrix: [],
    };
    const req = {
      functions: [],
      constraints: [
        { displayId: "C001", id: "CON_a", source_text: "数据库使用 AES (256-bit key) 加密" },
      ],
      exceptions: [],
    };
    const gaps = SystemDesigner.checkCoverageGaps(model, req);
    expect(gaps.map((g) => g.id)).toContain("C001");
    // The gap reason should call out the missing 256-bit anchor.
    expect(gaps[0].reason ?? "").toMatch(/256-bit|anchor/);
  });
});

// ---------------------------------------------------------------------------
// extractSalientAnchors — verbatim parameter extraction
// ---------------------------------------------------------------------------

describe("extractSalientAnchors", () => {
  it("extracts numeric+unit anchors (256-bit, 128-bit, 10 seconds)", () => {
    const t = "AES (128-bit block, 256-bit key) and Twofish; clipboard cleared after 10 seconds.";
    const anchors = extractSalientAnchors(t);
    expect(anchors).toContain("128-bit");
    expect(anchors).toContain("256-bit");
    expect(anchors).toContain("10 seconds");
  });

  it("extracts algorithm names", () => {
    const t = "Encrypted with AES/Rijndael, Twofish, and PBKDF2 for key derivation; in-memory uses ARC4.";
    const anchors = extractSalientAnchors(t);
    expect(anchors).toContain("AES/Rijndael");
    expect(anchors).toContain("Twofish");
    expect(anchors).toContain("PBKDF2");
    expect(anchors).toContain("ARC4");
  });

  it("extracts file extensions and product-level key phrases", () => {
    const t = "Database files use the .kdb extension. The user must set a Master Password. No recovery is supported and only single instance allowed.";
    const anchors = extractSalientAnchors(t);
    expect(anchors).toContain(".kdb");
    expect(anchors.some((a) => /Master Password/i.test(a))).toBe(true);
    expect(anchors.some((a) => /no recovery/i.test(a))).toBe(true);
    expect(anchors.some((a) => /single[ -]instance/i.test(a))).toBe(true);
  });

  it("extracts CJK numeric units (10秒)", () => {
    const t = "复制的密码 10 秒后自动从剪贴板清除。";
    const anchors = extractSalientAnchors(t);
    expect(anchors.some((a) => /10\s*秒/.test(a))).toBe(true);
  });

  it("returns empty for empty input", () => {
    expect(extractSalientAnchors("")).toEqual([]);
  });

  it("does NOT false-positive on plain TLD-shaped tokens (.com)", () => {
    const t = "See https://example.com for details.";
    const anchors = extractSalientAnchors(t);
    expect(anchors).not.toContain(".com");
  });
});

describe("textIncludesAnchor", () => {
  it("matches case-insensitively for ASCII", () => {
    expect(textIncludesAnchor("Uses aes-256 encryption", "AES-256")).toBe(true);
  });

  it("treats hyphen and space as interchangeable for ASCII", () => {
    expect(textIncludesAnchor("Uses 256 bit key", "256-bit")).toBe(true);
    expect(textIncludesAnchor("Uses 256-bit key", "256 bit")).toBe(true);
  });

  it("matches CJK exact substring", () => {
    expect(textIncludesAnchor("剪贴板会在10秒后清除", "10秒")).toBe(true);
    expect(textIncludesAnchor("剪贴板清除", "10秒")).toBe(false);
  });

  it("returns true for empty anchor (degenerate case)", () => {
    expect(textIncludesAnchor("anything", "")).toBe(true);
  });

  it("returns false when haystack is empty", () => {
    expect(textIncludesAnchor("", "AES")).toBe(false);
  });
});
