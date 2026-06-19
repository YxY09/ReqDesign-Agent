/**
 * Phase 4: Display ID adaptation tests.
 * 
 * After canonicalization, items have both `.id` (canonicalId like FUN_SEARCH_CASE)
 * and `.displayId` (like F001). Human-facing outputs (prompts, contracts, diagrams)
 * should prefer displayId; validation should accept both.
 */
import { describe, it, expect, vi } from "vitest";
import { SystemDesigner } from "../src/generators/design.js";
import { TestCaseGenerator } from "../src/generators/tests.js";
import { DiagramGenerator } from "../src/generators/diagrams.js";
import { RequirementIndex } from "../src/shared/requirementIndex.js";
import type { LLMClient } from "../src/llmClient.js";

// ═══════════════════════════════════════════════════════
//  design.ts — displayId adaptation
// ═══════════════════════════════════════════════════════

describe("SystemDesigner — displayId in contract", () => {
  it("buildDesignContract shows displayId when available", () => {
    const req = {
      functions: [
        { id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase", description: "搜索案件" },
      ],
      constraints: [
        { id: "CON_ORDER_LIMIT", displayId: "C001", description: "订单限制" },
      ],
      exceptions: [
        { id: "EXC_PAYMENT_FAIL", displayId: "X001", description: "支付失败", trigger: "余额不足", handling: "提示" },
      ],
      entities: [{ name: "Case", description: "案件" }],
    };
    const contract = SystemDesigner.buildDesignContract(req);

    // Contract should show displayId (F001) not just canonicalId (FUN_SEARCH_CASE)
    expect(contract).toContain("F001");
    // Should NOT show verbose canonicalId in the main listing
    // (or at minimum, displayId must be visible)
    expect(contract).toContain("C001");
    expect(contract).toContain("X001");
  });

  it("buildDesignContract falls back to id when displayId absent", () => {
    const req = {
      functions: [{ id: "F001", name: "Login", description: "登录" }],
      entities: [],
    };
    const contract = SystemDesigner.buildDesignContract(req);
    expect(contract).toContain("F001");
  });

  it("buildDesignContract sub-capabilities shows displayId", () => {
    const req = {
      functions: [{
        id: "FUN_SEARCH_CASE",
        displayId: "F001",
        name: "SearchCase",
        description: "搜索",
        sub_capabilities: ["关键字搜索", "高级筛选"],
        acceptance_criteria: ["返回结果 < 1s"],
      }],
      entities: [],
    };
    const contract = SystemDesigner.buildDesignContract(req);
    expect(contract).toContain("F001");
  });

  it("validateDesign recognizes design text using displayId", () => {
    const design =
      "## 模块划分\n\n包含F001搜索案件功能。\n\n## 核心类\n\nCase类。\n\n## 数据流\n\n请求处理流程。\n\nC001 已处理。X001 支付失败处理。";
    const req = {
      functions: [
        { id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase" },
      ],
      entities: [{ name: "Case", description: "案件" }],
      constraints: [{ id: "CON_ORDER_LIMIT", displayId: "C001", description: "订单限制" }],
      exceptions: [{ id: "EXC_PAYMENT_FAIL", displayId: "X001", description: "支付失败" }],
    };
    const warnings = SystemDesigner.validateDesign(design, req);
    const coverageWarnings = warnings.filter((w) => w.includes("未在设计中体现"));
    expect(coverageWarnings.length).toBe(0);
  });

  it("validateDesign also recognizes design text using canonicalId", () => {
    const design =
      "## 模块划分\n\n包含FUN_SEARCH_CASE功能。\n\n## 核心类\n\nCase类。\n\n## 数据流\n\n请求处理流程。\n\nCON_ORDER_LIMIT 已处理。EXC_PAYMENT_FAIL 支付失败处理。";
    const req = {
      functions: [
        { id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase" },
      ],
      entities: [{ name: "Case", description: "案件" }],
      constraints: [{ id: "CON_ORDER_LIMIT", displayId: "C001", description: "订单限制" }],
      exceptions: [{ id: "EXC_PAYMENT_FAIL", displayId: "X001", description: "支付失败" }],
    };
    const warnings = SystemDesigner.validateDesign(design, req);
    const coverageWarnings = warnings.filter((w) => w.includes("未在设计中体现"));
    expect(coverageWarnings.length).toBe(0);
  });

  it("generateDesign prompt contains displayId", async () => {
    const minimalModel = {
      modules: [{ id: "MOD_1", name: "M", responsibility: "r", functionIds: ["F001"] }],
      classes: [{ name: "Svc", kind: "helper", responsibility: "r" }],
      dataFlows: [{ name: "flow", steps: ["a"], relatedFunctionIds: ["F001"] }],
      coverageMatrix: [{ refId: "F001", refKind: "function", originalDescription: "搜索", designDecision: "d", affectedModuleIds: ["MOD_1"], affectedClassNames: ["Svc"], testImplication: "t" }],
    };
    const mockLLM = { generateJson: vi.fn().mockResolvedValue(minimalModel) };
    const designer = new SystemDesigner(mockLLM as any);
    const req = {
      functions: [{ id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase", description: "搜索" }],
      entities: [],
    };
    await designer.generateDesign(req);
    const prompt: string = mockLLM.generateJson.mock.calls[0][0];
    expect(prompt).toContain("F001");
  });
});

// ═══════════════════════════════════════════════════════
//  tests.ts — displayId adaptation
// ═══════════════════════════════════════════════════════

describe("TestCaseGenerator — displayId in contract", () => {
  it("buildTestContract shows displayId when available", () => {
    const req = {
      functions: [{ id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase", description: "搜索" }],
      exceptions: [{ id: "EXC_PAYMENT_FAIL", displayId: "X001", description: "支付失败", trigger: "余额不足" }],
      constraints: [{ id: "CON_ORDER_LIMIT", displayId: "C001", description: "限制" }],
    };
    const contract = TestCaseGenerator.buildTestContract(req);
    expect(contract).toContain("F001");
    expect(contract).toContain("X001");
    expect(contract).toContain("C001");
  });

  it("buildTestContract falls back to id when displayId absent", () => {
    const req = {
      functions: [{ id: "F001", name: "Login", description: "登录" }],
      exceptions: [],
      constraints: [],
    };
    const contract = TestCaseGenerator.buildTestContract(req);
    expect(contract).toContain("F001");
  });

  it("validateStructuredTestCases accepts displayId references", () => {
    const testCases = JSON.stringify({
      test_cases: [
        {
          id: "TC-N-001", title: "正常搜索", type: "正常",
          target: "F001 搜索案件",
          preconditions: "用户已登录",
          steps: ["输入关键字", "点击搜索"],
          expected_result: "返回结果",
          priority: "P0",
        },
        {
          id: "TC-E-001", title: "支付失败", type: "异常",
          target: "F001 搜索案件 X001 支付失败",
          preconditions: "订单待支付",
          steps: ["触发支付"],
          expected_result: "提示失败",
          priority: "P0",
        },
        {
          id: "TC-B-001", title: "数量边界", type: "边界",
          target: "F001 搜索 C001",
          preconditions: "有库存",
          steps: ["输入最大数量"],
          expected_result: "校验通过",
          priority: "P1",
        },
      ],
    });
    const req = {
      functions: [{ id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase" }],
      exceptions: [{ id: "EXC_PAYMENT_FAIL", displayId: "X001", description: "支付失败" }],
      constraints: [{ id: "CON_ORDER_LIMIT", displayId: "C001", description: "限制" }],
    };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    expect(warnings).toEqual([]);
  });

  it("validateStructuredTestCases does not flag canonicalId as unknown", () => {
    const testCases = JSON.stringify({
      test_cases: [
        {
          id: "TC-N-001", title: "正常搜索", type: "正常",
          target: "FUN_SEARCH_CASE",
          preconditions: "已登录",
          steps: ["搜索"],
          expected_result: "成功",
          priority: "P0",
        },
        {
          id: "TC-E-001", title: "异常", type: "异常",
          target: "EXC_PAYMENT_FAIL",
          preconditions: "待支付",
          steps: ["触发异常"],
          expected_result: "失败",
          priority: "P0",
        },
        {
          id: "TC-B-001", title: "边界", type: "边界",
          target: "CON_ORDER_LIMIT",
          preconditions: "有数据",
          steps: ["边界测试"],
          expected_result: "通过",
          priority: "P1",
        },
      ],
    });
    const req = {
      functions: [{ id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase" }],
      exceptions: [{ id: "EXC_PAYMENT_FAIL", displayId: "X001", description: "支付失败" }],
      constraints: [{ id: "CON_ORDER_LIMIT", displayId: "C001", description: "限制" }],
    };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    expect(warnings.some((w) => w.includes("未定义"))).toBe(false);
    expect(warnings.some((w) => w.includes("未被测试用例覆盖"))).toBe(false);
  });

  it("unstructured validation accepts displayId references", () => {
    const testCases = `## TC-N-001: 正常搜索
- **类型**: 正常
- **测试对象**: F001 SearchCase
- **优先级**: P0

## TC-E-001: 支付失败
- **类型**: 异常
- **测试对象**: X001
- **优先级**: P0

## TC-B-001: 边界测试
- **类型**: 边界
- **测试对象**: F001
- **优先级**: P1`;
    const req = {
      functions: [{ id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase" }],
      exceptions: [{ id: "EXC_PAYMENT_FAIL", displayId: "X001", description: "支付失败" }],
    };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    expect(warnings.some((w) => w.includes("F001") && w.includes("未被测试用例覆盖"))).toBe(false);
    expect(warnings.some((w) => w.includes("X001") && w.includes("未被测试用例覆盖"))).toBe(false);
  });

  it("generate prompt contains displayId", async () => {
    const llm = { generateText: vi.fn().mockResolvedValue("test result") };
    const generator = new TestCaseGenerator(llm as any);
    await generator.generate({
      requirementJson: {
        functions: [{ id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase", description: "搜索" }],
        exceptions: [{ id: "EXC_PAYMENT_FAIL", displayId: "X001", description: "支付失败", trigger: "余额不足" }],
        constraints: [{ id: "CON_ORDER_LIMIT", displayId: "C001", description: "限制" }],
      },
      designText: "## 设计",
    });
    const prompt = llm.generateText.mock.calls[0][0] as string;
    expect(prompt).toContain("F001");
    expect(prompt).toContain("X001");
    expect(prompt).toContain("C001");
  });
});

// ═══════════════════════════════════════════════════════
//  diagrams.ts — displayId in prompts
// ═══════════════════════════════════════════════════════

describe("DiagramGenerator — displayId in prompts", () => {
  function buildPrompt(
    template: string,
    reqJson: Record<string, unknown> | null,
    designText: string,
    diagramType: string,
  ): string {
    const gen = Object.create(DiagramGenerator.prototype);
    return (gen as any)._buildPrompt(template, reqJson, designText, "", diagramType);
  }

  it("activity_diagram prompt uses displayId for functions", () => {
    const req = {
      functions: [
        { id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase", description: "搜索案件" },
      ],
      exceptions: [
        { id: "EXC_PAYMENT_FAIL", displayId: "X001", description: "支付失败", trigger: "余额不足", handling: "提示" },
      ],
      constraints: [
        { id: "CON_ORDER_LIMIT", displayId: "C001", description: "订单限制" },
      ],
    };
    const result = buildPrompt(
      "需求：{requirement_json}\n设计：{design_text}",
      req,
      "设计内容",
      "activity_diagram",
    );
    // Should show displayId (F001), not just canonicalId (FUN_SEARCH_CASE)
    expect(result).toContain("F001");
    expect(result).toContain("X001");
    expect(result).toContain("C001");
  });

  it("state_diagram prompt uses displayId for constraints/exceptions", () => {
    const req = {
      entities: [{ name: "Order", description: "订单" }],
      constraints: [
        { id: "CON_ORDER_LIMIT", displayId: "C001", description: "订单限制" },
      ],
      exceptions: [
        { id: "EXC_PAYMENT_FAIL", displayId: "X001", description: "支付失败", trigger: "余额不足", handling: "提示" },
      ],
    };
    const result = buildPrompt(
      "需求：{requirement_json}\n设计：{design_text}",
      req,
      "设计内容",
      "state_diagram",
    );
    expect(result).toContain("C001");
    expect(result).toContain("X001");
  });

  it("falls back to id when displayId absent in activity_diagram", () => {
    const req = {
      functions: [
        { id: "F001", name: "SearchCase", description: "搜索案件" },
      ],
      constraints: [],
      exceptions: [],
    };
    const result = buildPrompt(
      "需求：{requirement_json}\n设计：{design_text}",
      req,
      "设计内容",
      "activity_diagram",
    );
    expect(result).toContain("F001");
  });
});

// ═══════════════════════════════════════════════════════
//  RequirementIndex.normalizeTargetReferences — bare canonicalId pre-rewrite
// ═══════════════════════════════════════════════════════

describe("RequirementIndex.normalizeTargetReferences — canonical pre-rewrite", () => {
  function makeIndex() {
    return RequirementIndex.fromRequirementJson({
      functions: [{ id: "FUN_LOGIN", displayId: "F001", name: "Login" }],
      constraints: [{ id: "CON_AUDIT", displayId: "C001", description: "审计" }],
      exceptions: [{ id: "EXC_DENY", displayId: "X001", description: "拒绝" }],
    });
  }

  it("rewrites a bare canonicalId into a displayId | canonicalId pair", () => {
    const idx = makeIndex();
    const tc = { type: "异常" };
    const out = idx.normalizeTargetReferences("CON_AUDIT 审计约束", tc);
    // Should now carry the displayId C001 paired with CON_AUDIT
    expect(out).toContain("C001");
    expect(out).toContain("CON_AUDIT");
  });

  it("does not double-rewrite a canonicalId already in a pair", () => {
    const idx = makeIndex();
    const tc = { type: "异常" };
    // Already a well-formed pair
    const out = idx.normalizeTargetReferences("C001 | CON_AUDIT", tc);
    expect(out).toBe("C001 | CON_AUDIT");
  });

  it("drops a fabricated canonicalId that maps to no displayId", () => {
    const idx = makeIndex();
    const tc = { type: "异常", title: "伪造", expected_result: "拦截" };
    // CON_FABRICATED has no mapping → removed by removeUnknownRefs → fallback
    const out = idx.normalizeTargetReferences("CON_FABRICATED_XYZ", tc);
    // Should not contain the fabricated canonicalId
    expect(out).not.toContain("CON_FABRICATED_XYZ");
  });

  it("uses target description to remap a stale bare canonicalId", () => {
    const idx = RequirementIndex.fromRequirementJson({
      functions: [],
      constraints: [
        { id: "CON_AUDIT", displayId: "C001", description: "病历修改留痕" },
        { id: "CON_ANTIBIOTIC", displayId: "C004", description: "抗生素需主任医师审核" },
      ],
      exceptions: [],
    });

    const out = idx.normalizeTargetReferences(
      "CON_AUDIT 抗生素需主任医师审核",
      { type: "边界" },
    );

    expect(out).toBe("C004 | CON_ANTIBIOTIC 抗生素需主任医师审核");
  });

  it("keeps a valid displayId even when target text resembles another constraint", () => {
    const idx = RequirementIndex.fromRequirementJson({
      functions: [],
      constraints: [
        { id: "CON_SINGLE_INSTANCE", displayId: "C004", description: "仅允许运行一个KeePass实例" },
        { id: "CON_PASSWORD_LENGTH", displayId: "C014", description: "主密码没有长度限制" },
      ],
      exceptions: [],
    });

    const out = idx.normalizeTargetReferences(
      "C004 | CON_SINGLE_INSTANCE 主密码没有长度限制",
      { type: "边界" },
    );

    expect(out).toBe("C004 | CON_SINGLE_INSTANCE 主密码没有长度限制");
  });

  it("does not rewrite a valid display-only target by semantic similarity", () => {
    const idx = RequirementIndex.fromRequirementJson({
      functions: [],
      constraints: [
        { id: "CON_TIMEOUT_A", displayId: "C003", description: "支付超时时间为30分钟" },
        { id: "CON_TIMEOUT_B", displayId: "C011", description: "订单支付超时自动取消（30分钟）" },
      ],
      exceptions: [],
    });

    const out = idx.normalizeTargetReferences(
      "C011 支付超时时间为30分钟",
      {
        type: "边界",
        title: "支付超时30分钟边界测试",
        steps: ["订单创建后等待30分钟", "系统执行超时取消"],
        expected_result: "订单因支付超时被取消",
      },
    );

    expect(out).toBe("C011 支付超时时间为30分钟");
  });
});
