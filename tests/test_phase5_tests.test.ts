import { describe, it, expect, vi } from "vitest";
import { TestCaseGenerator } from "../src/generators/tests.js";

describe("TestCaseGenerator.validateTestCases", () => {
  it("normalizes structured test case IDs generated from requirement IDs", () => {
    const testCases = JSON.stringify({
      test_cases: [
        {
          id: "TC-F010-001",
          title: "帮助功能正常测试",
          type: "正常",
          target: "F010 帮助功能",
          preconditions: "用户已登录",
          steps: ["打开帮助"],
          expected_result: "显示帮助内容",
          priority: "P1",
        },
        {
          id: "TC-X002-001",
          title: "权限异常测试",
          type: "异常",
          target: "X002 权限不足",
          preconditions: "用户权限不足",
          steps: ["访问受限资源"],
          expected_result: "触发 X002",
          priority: "P0",
        },
        {
          id: "TC-CON-001",
          title: "审计约束测试",
          type: "边界",
          target: "C001 审计约束",
          preconditions: "审计模块启用",
          steps: ["修改审计日志"],
          expected_result: "C001 阻止篡改",
          priority: "P0",
        },
      ],
    });

    const normalized = TestCaseGenerator.normalizeStructuredTestCaseIds(testCases);
    expect(normalized).not.toBeNull();
    const parsed = JSON.parse(normalized!);
    expect(parsed.test_cases.map((tc: Record<string, unknown>) => tc.id)).toEqual([
      "TC-N-001",
      "TC-E-001",
      "TC-B-001",
    ]);

    const warnings = TestCaseGenerator.validateTestCases(normalized!, {
      functions: [{ id: "F010", name: "Help" }],
      exceptions: [{ id: "X002", description: "Denied" }],
      constraints: [{ id: "C001", description: "Audit cannot be altered" }],
    });
    expect(warnings.some((warning) => warning.includes("编号不合法"))).toBe(false);
  });

  it("normalizes structured target display/canonical pairs to requirement IDs", () => {
    const req = {
      functions: [
        { id: "FUN_VIEW_REPORTS", displayId: "F010", name: "ViewReports" },
      ],
      exceptions: [
        { id: "EXC_UNAUTHORIZED_ACCESS_ATTEMPT", displayId: "X010", description: "Unauthorized access attempt" },
      ],
      constraints: [
        { id: "CON_FUNC_IMPLEMENT_SOA_MODULAR_DESIGN_P598", displayId: "C008", description: "Implement SOA with modular design" },
        { id: "CON_FUNC_SYSTEM_SCALABLE_5TAK", displayId: "C019", description: "System must be scalable" },
      ],
    };
    const testCases = JSON.stringify({
      test_cases: [
        {
          id: "TC-B-011",
          title: "SOA modular design verification",
          type: "边界",
          target: "C008 | CON_ARC_SOA_MODULAR_DESIGN_9J2F",
          preconditions: "System is deployed",
          steps: ["Verify modular service boundary"],
          expected_result: "C008 is satisfied",
          priority: "P1",
        },
        {
          id: "TC-E-011",
          title: "Context help unavailable for new feature",
          type: "异常",
          target: "X010 | EXC_CONTEXT_HELP_UNAVAILABLE, C019 | CON_FUNC_CONTEXT_SENSITIVE_HELP_AVAILABLE_3K7P",
          preconditions: "User is logged in",
          steps: ["Trigger X010"],
          expected_result: "System blocks unauthorized access",
          priority: "P1",
        },
        {
          id: "TC-N-012",
          title: "User successfully accesses context-sensitive help",
          type: "正常",
          target: "F011 | FUN_ACCESS_HELP",
          preconditions: "User is logged in",
          steps: ["Open help panel"],
          expected_result: "Help content is displayed",
          priority: "P2",
        },
      ],
    });

    const normalized = TestCaseGenerator.normalizeStructuredTestCases(testCases, req);
    expect(normalized).not.toBeNull();
    const parsed = JSON.parse(normalized!);
    expect(parsed.test_cases[0].target).toBe("C008 | CON_FUNC_IMPLEMENT_SOA_MODULAR_DESIGN_P598");
    expect(parsed.test_cases[1].target).toBe("X010 | EXC_UNAUTHORIZED_ACCESS_ATTEMPT, C019 | CON_FUNC_SYSTEM_SCALABLE_5TAK");
    expect(parsed.test_cases[2].target).toBe("F010 | FUN_VIEW_REPORTS");
    expect(TestCaseGenerator.validateTestCases(normalized!, req)).toEqual([]);
  });

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
      requirementJson: {
        functions: [{ id: "F001", name: "CreateOrder", description: "下单" }],
        exceptions: [{ id: "X001", description: "支付失败", trigger: "余额不足" }],
        constraints: [{ id: "C001", description: "订单金额限制" }],
      },
      designText: "## 设计",
    });

    const prompt = llm.generateText.mock.calls[0][0] as string;
    expect(prompt).toContain("测试生成合同");
    expect(prompt).toContain("F001 | CreateOrder");
    expect(prompt).toContain("X001 | 支付失败");
    expect(prompt).toContain("禁止改写为 E001");
  });
});

describe("TestCaseGenerator.validateStructuredTestCases — Bug A: target triplet parsing", () => {
  it("does not flag function name (3rd field) as undefined ID in target triplet", () => {
    const testCases = JSON.stringify({
      test_cases: [
        {
          id: "TC-N-001",
          title: "Configure system",
          type: "正常",
          target: "F002 | FUN_CONFIGURE_SYSTEM | ConfigureSystem",
          preconditions: "Admin logged in",
          steps: ["Open settings"],
          expected_result: "System configured",
          priority: "P0",
        },
        {
          id: "TC-E-001",
          title: "Exception test",
          type: "异常",
          target: "F002 | FUN_CONFIGURE_SYSTEM | ConfigureSystem",
          preconditions: "None",
          steps: ["Trigger error"],
          expected_result: "Error handled",
          priority: "P1",
        },
        {
          id: "TC-B-001",
          title: "Boundary test",
          type: "边界",
          target: "F002 | FUN_CONFIGURE_SYSTEM | ConfigureSystem",
          preconditions: "None",
          steps: ["Test boundary"],
          expected_result: "Boundary handled",
          priority: "P2",
        },
      ],
    });
    const req = {
      functions: [{ displayId: "F002", id: "FUN_CONFIGURE_SYSTEM", name: "ConfigureSystem" }],
      exceptions: [],
      constraints: [],
    };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    // ConfigureSystem should NOT be flagged as undefined
    expect(warnings.some((w) => w.includes("ConfigureSystem"))).toBe(false);
  });

  it("correctly parses multi-target with commas in description text", () => {
    const testCases = JSON.stringify({
      test_cases: [
        {
          id: "TC-E-001",
          title: "Security exception",
          type: "异常",
          target: "C008 | CON_CHANGES_SECURITY_ATTRIBUTES | Changes to security attributes, X012 | EXC_UNAUTHORIZED_ACCESS | Unauthorized access attempt",
          preconditions: "User logged in",
          steps: ["Attempt unauthorized change"],
          expected_result: "Access denied",
          priority: "P0",
        },
        {
          id: "TC-N-001",
          title: "Normal operation",
          type: "正常",
          target: "C008 | CON_CHANGES_SECURITY_ATTRIBUTES | Changes to security attributes",
          preconditions: "Super-user",
          steps: ["Make change"],
          expected_result: "Change applied",
          priority: "P1",
        },
        {
          id: "TC-B-001",
          title: "Boundary test",
          type: "边界",
          target: "C008 | CON_CHANGES_SECURITY_ATTRIBUTES | Changes to security attributes",
          preconditions: "None",
          steps: ["Test boundary"],
          expected_result: "Boundary checked",
          priority: "P2",
        },
      ],
    });
    const req = {
      functions: [],
      exceptions: [{ displayId: "X012", id: "EXC_UNAUTHORIZED_ACCESS", description: "Unauthorized" }],
      constraints: [{ displayId: "C008", id: "CON_CHANGES_SECURITY_ATTRIBUTES", description: "Security attrs" }],
    };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    // Words from description text should not be flagged
    expect(warnings.some((w) => w.includes("Changes") || w.includes("Unauthorized"))).toBe(false);
    // X012 and EXC_UNAUTHORIZED_ACCESS must be recognized as referenced IDs
    // (not flagged as undefined because they were extracted from the target)
    expect(warnings.some((w) => w.includes("X012"))).toBe(false);
    expect(warnings.some((w) => w.includes("EXC_UNAUTHORIZED_ACCESS"))).toBe(false);
  });

  it("detects unknown ID in second triplet of multi-target", () => {
    const testCases = JSON.stringify({
      test_cases: [
        {
          id: "TC-E-001",
          title: "Security exception",
          type: "异常",
          target: "C008 | CON_CHANGES_SECURITY_ATTRIBUTES | Changes to security attributes, X999 | EXC_NONEXISTENT | Unknown exception",
          preconditions: "User logged in",
          steps: ["Attempt unauthorized change"],
          expected_result: "Access denied",
          priority: "P0",
        },
      ],
    });
    const req = {
      functions: [],
      exceptions: [{ displayId: "X012", id: "EXC_UNAUTHORIZED_ACCESS", description: "Unauthorized" }],
      constraints: [{ displayId: "C008", id: "CON_CHANGES_SECURITY_ATTRIBUTES", description: "Security attrs" }],
    };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    // X999 and EXC_NONEXISTENT are not defined in req — they must be flagged as unknown
    expect(warnings.some((w) => w.includes("X999"))).toBe(true);
    expect(warnings.some((w) => w.includes("EXC_NONEXISTENT"))).toBe(true);
  });

  it("does not treat browser names or XSS text as IDs", () => {
    const testCases = JSON.stringify({
      test_cases: [
        {
          id: "TC-N-001",
          title: "Normal browser use",
          type: "正常",
          target: "C001 | CON_BROWSER_COMPAT",
          preconditions: "Chrome, Firefox, and Edge are installed",
          steps: ["Open the app in Chrome", "Repeat in Firefox and Edge", "Try an XSS payload as text"],
          expected_result: "All browsers work and XSS text is escaped",
          priority: "P1",
        },
        {
          id: "TC-E-001",
          title: "Browser failure",
          type: "异常",
          target: "C001 | CON_BROWSER_COMPAT",
          preconditions: "Unsupported browser",
          steps: ["Open the app"],
          expected_result: "A supported-browser message is shown",
          priority: "P2",
        },
        {
          id: "TC-B-001",
          title: "Browser boundary",
          type: "边界",
          target: "C001 | CON_BROWSER_COMPAT",
          preconditions: "Multiple browser versions",
          steps: ["Test oldest supported version"],
          expected_result: "Layout remains usable",
          priority: "P1",
        },
      ],
    });
    const req = {
      functions: [],
      exceptions: [],
      constraints: [{ displayId: "C001", id: "CON_BROWSER_COMPAT", description: "Browser compatibility" }],
    };

    const warnings = TestCaseGenerator.validateTestCases(testCases, req);

    expect(warnings.some((w) => /Chrome|Firefox|Edge|XSS/.test(w))).toBe(false);
  });

  it("detects duplicate structured test case IDs", () => {
    const testCases = JSON.stringify({
      test_cases: [
        {
          id: "TC-N-001",
          title: "First",
          type: "正常",
          target: "C001 | CON_BROWSER_COMPAT",
          preconditions: "Ready",
          steps: ["Run"],
          expected_result: "Pass",
          priority: "P1",
        },
        {
          id: "TC-N-001",
          title: "Duplicate",
          type: "异常",
          target: "C001 | CON_BROWSER_COMPAT",
          preconditions: "Ready",
          steps: ["Run"],
          expected_result: "Pass",
          priority: "P1",
        },
        {
          id: "TC-B-001",
          title: "Boundary",
          type: "边界",
          target: "C001 | CON_BROWSER_COMPAT",
          preconditions: "Ready",
          steps: ["Run"],
          expected_result: "Pass",
          priority: "P1",
        },
      ],
    });
    const req = {
      functions: [],
      exceptions: [],
      constraints: [{ displayId: "C001", id: "CON_BROWSER_COMPAT", description: "Browser compatibility" }],
    };

    const warnings = TestCaseGenerator.validateTestCases(testCases, req);

    expect(warnings).toContain("测试用例编号重复: TC-N-001");
  });

  it("detects mismatched display/canonical target ID pairs", () => {
    const testCases = JSON.stringify({
      test_cases: [
        {
          id: "TC-N-001",
          title: "Normal",
          type: "正常",
          target: "X001 | EXC_B",
          preconditions: "Ready",
          steps: ["Run"],
          expected_result: "Pass",
          priority: "P1",
        },
        {
          id: "TC-E-001",
          title: "Exception",
          type: "异常",
          target: "X001 | EXC_B",
          preconditions: "Ready",
          steps: ["Run"],
          expected_result: "Pass",
          priority: "P1",
        },
        {
          id: "TC-B-001",
          title: "Boundary",
          type: "边界",
          target: "X002 | EXC_B",
          preconditions: "Ready",
          steps: ["Run"],
          expected_result: "Pass",
          priority: "P1",
        },
      ],
    });
    const req = {
      functions: [],
      constraints: [],
      exceptions: [
        { displayId: "X001", id: "EXC_A", description: "A" },
        { displayId: "X002", id: "EXC_B", description: "B" },
      ],
    };

    const warnings = TestCaseGenerator.validateTestCases(testCases, req);

    expect(warnings.some((w) => w.includes("target ID 配对不一致") && w.includes("X001"))).toBe(true);
  });
});
