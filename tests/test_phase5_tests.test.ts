import { describe, it, expect, vi } from "vitest";
import { TestCaseGenerator } from "../src/generators/tests.js";

describe("TestCaseGenerator.validateTestCases", () => {
  it("accepts structured JSON test_cases arrays", () => {
    const testCases = JSON.stringify({
      test_cases: [
        {
          id: "TC-N-001",
          title: "正常下单",
          type: "正常",
          target: "F001 下单",
          preconditions: "用户已登录",
          steps: ["选择商品", "提交订单"],
          expected_result: "订单创建成功",
          priority: "P0",
        },
        {
          id: "TC-E-001",
          title: "支付失败",
          type: "异常",
          target: "F001 下单 X001 支付失败",
          preconditions: "订单待支付",
          steps: ["触发 X001"],
          expected_result: "提示支付失败",
          priority: "P0",
        },
        {
          id: "TC-B-001",
          title: "数量边界",
          type: "边界",
          target: "F001 下单 C001",
          preconditions: "商品有库存",
          steps: ["输入最大允许数量"],
          expected_result: "边界校验通过",
          priority: "P1",
        },
      ],
    });
    const req = {
      functions: [{ id: "F001", name: "CreateOrder" }],
      exceptions: [{ id: "X001", name: "PaymentFailed" }],
      constraints: [{ id: "C001", description: "数量限制" }],
    };
    expect(TestCaseGenerator.validateTestCases(testCases, req)).toEqual([]);
  });

  it("should warn when constitution title format is missing", () => {
    const testCases = "这是一段普通文本，没有表格。";
    const req = { functions: [] };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    expect(warnings.some((w) => w.includes("标题格式"))).toBe(true);
  });

  it("should warn when missing exception and boundary types", () => {
    const testCases =
      "| 编号 | 类型 |\n|------|------|\n| TC-N-001 | 正常 |";
    const req = { functions: [] };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    expect(warnings.some((w) => w.includes("异常"))).toBe(true);
    expect(warnings.some((w) => w.includes("边界"))).toBe(true);
  });

  it("should not warn on types when all are present", () => {
    const testCases = `## TC-N-001: 正常登录
- **类型**: 正常
- **优先级**: P0
## TC-N-002: 正常注册
- **类型**: 正常
- **优先级**: P1
## TC-N-003: 正常查询
- **类型**: 正常
- **优先级**: P1
## TC-E-001: 异常登录
- **类型**: 异常
- **优先级**: P0
## TC-E-002: 异常注册
- **类型**: 异常
- **优先级**: P1
## TC-B-001: 边界用户名
- **类型**: 边界
- **优先级**: P2
## TC-B-002: 边界密码
- **类型**: 边界
- **优先级**: P2`;
    const req = { functions: [] };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    const typeWarnings = warnings.filter((w) => w.includes("场景"));
    expect(typeWarnings.length).toBe(0);
  });

  it("should warn on uncovered functions by name", () => {
    const testCases =
      "| 编号 | 测试对象 |\n|------|----------|\n| TC-N-001 | 用户登录 |";
    const req = { functions: [{ name: "用户登录" }, { name: "用户注册" }] };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    expect(warnings.some((w) => w.includes("用户注册"))).toBe(true);
  });

  it("should warn on uncovered function IDs", () => {
    const testCases =
      "| 编号 | 测试对象 |\n|------|----------|\n| TC-N-001 | 用户登录 (F001) |";
    const req = {
      functions: [
        { id: "F001", name: "UserLogin" },
        { id: "F002", name: "UserRegistration" },
      ],
    };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    expect(warnings.some((w) => w.includes("F002"))).toBe(true);
    expect(warnings.some((w) => w.includes("F001"))).toBe(false);
  });

  it("should handle string function entries and warn on uncovered", () => {
    const testCases =
      "| 编号 | 测试对象 |\n|------|----------|\n| TC-N-001 | 用户登录 |";
    const req = { functions: ["用户登录", "用户注册"] };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    expect(warnings.some((w) => w.includes("用户注册"))).toBe(true);
    expect(warnings.some((w) => w.includes("用户登录"))).toBe(false);
  });

  it("should have no function warnings when all string functions covered", () => {
    const testCases =
      "| 编号 | 测试对象 |\n|------|----------|\n| TC-N-001 | 用户登录 |\n| TC-N-002 | 用户注册 |";
    const req = { functions: ["用户登录", "用户注册"] };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    const funcWarnings = warnings.filter((w) => w.includes("未被测试用例覆盖"));
    expect(funcWarnings.length).toBe(0);
  });

  it("should warn when exception IDs are not referenced", () => {
    const testCases =
      "| 编号 | 类型 | 测试对象 |\n|------|------|----------|\n| TC-N-001 | 正常 | 借阅图书 |";
    const req = {
      functions: ["借阅图书"],
      exceptions: [
        { id: "E001", name: "BorrowFail" },
        { id: "E002", name: "OverdueReturn" },
      ],
    };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    expect(warnings.some((w) => w.includes("E001"))).toBe(true);
    expect(warnings.some((w) => w.includes("E002"))).toBe(true);
  });

  it("should warn on unknown function and exception IDs", () => {
    const testCases =
      "| 编号 | 类型 | 测试对象 |\n|------|------|----------|\n| TC-E-001 | 异常 | 借阅图书 (F999, E999) |";
    const req = {
      functions: [{ id: "F001", name: "BorrowBook" }],
      exceptions: [{ id: "E001", name: "BorrowFail" }],
    };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    expect(warnings.some((w) => w.includes("F999"))).toBe(true);
    expect(warnings.some((w) => w.includes("E999"))).toBe(true);
  });

  it("should accept exception IDs with non-E prefixes when defined by requirements", () => {
    const testCases =
      "## TC-N-001: 正常下单\n- **类型**: 正常\n- **测试对象**: F001 下单\n- **测试步骤**: 正常下单\n- **预期结果**: 成功\n- **优先级**: P0\n\n## TC-E-001: 支付失败\n- **类型**: 异常\n- **测试对象**: X001 支付失败\n- **测试步骤**: 触发 X001 后提示重试\n- **预期结果**: 提示重试\n- **优先级**: P0\n\n## TC-B-001: 数量边界\n- **类型**: 边界\n- **测试对象**: F001 下单\n- **测试步骤**: 边界数量\n- **预期结果**: 校验通过\n- **优先级**: P1";
    const req = {
      functions: [{ id: "F001", name: "CreateOrder" }],
      exceptions: [{ id: "X001", name: "PaymentFailed" }],
    };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    expect(warnings.some((w) => w.includes("X001") && w.includes("未被测试用例覆盖"))).toBe(false);
    expect(warnings.some((w) => w.includes("未定义的异常 ID: X001"))).toBe(false);
  });
});

describe("TestCaseGenerator.countTestCases", () => {
  it("should count normal, exception, and boundary cases correctly", () => {
    const testCases = `
## TC-N-001: 正常1
## TC-N-002: 正常2
## TC-E-001: 异常1
## TC-B-001: 边界1
## TC-B-002: 边界2
## TC-B-003: 边界3
`;
    const counts = TestCaseGenerator.countTestCases(testCases);
    expect(counts["正常场景"]).toBe(2);
    expect(counts["异常场景"]).toBe(1);
    expect(counts["边界场景"]).toBe(3);
    expect(counts["总计"]).toBe(6);
  });

  it("should return zero counts for non-table text", () => {
    const counts = TestCaseGenerator.countTestCases("没有测试用例");
    expect(counts["总计"]).toBe(0);
  });

  it("should exclude separator rows from counts", () => {
    const testCases = `
| 编号 | 测试对象 | 测试步骤 |
|------|----------|----------|
| TC-N-001 | 登录 | 输入用户名密码 |
| TC-N-002 | 注册 | 填写注册信息 |
`;
    const counts = TestCaseGenerator.countTestCases(testCases);
    expect(counts["总计"]).toBe(2);
  });
});

describe("TestCaseGenerator.generate", () => {
  it("injects a hard test contract with original exception IDs", async () => {
    const llm = { generateText: vi.fn().mockResolvedValue("| 编号 | 类型 |") };
    const generator = new TestCaseGenerator(llm as any);
    await generator.generate({
      functions: [{ id: "F001", name: "CreateOrder", description: "下单" }],
      exceptions: [{ id: "X001", description: "支付失败", trigger: "余额不足" }],
      constraints: [{ id: "C001", description: "订单金额限制" }],
    }, "## 设计");

    const prompt = llm.generateText.mock.calls[0][0] as string;
    expect(prompt).toContain("测试生成合同");
    expect(prompt).toContain("F001 | CreateOrder");
    expect(prompt).toContain("X001 | 支付失败");
    expect(prompt).toContain("禁止改写为 E001");
  });
});
