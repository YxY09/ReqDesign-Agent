import { describe, it, expect } from "vitest";
import { validateReview } from "../src/shared/reviewValidator.js";
import type { ReviewValidationResult } from "../src/shared/reviewValidator.js";

describe("validateReview", () => {
  it("passes when all IDs are unique, referenced, and properly covered", () => {
    const requirementJson = {
      entities: [
        { id: "E_CASE", canonicalName: "Case", displayName: "案件", entityRef: "E_CASE" },
        { id: "E_USER", canonicalName: "User", displayName: "用户", entityRef: "E_USER" },
      ],
      functions: [
        { id: "FUN_REGISTER_CASE", displayId: "F001", name: "注册案件" },
        { id: "FUN_SEARCH_CASE", displayId: "F002", name: "搜索案件" },
      ],
      constraints: [
        { id: "CON_001", displayId: "C001", description: "案件编号格式", source_text: "案件编号必须是CASE-前缀" },
      ],
      exceptions: [
        { id: "EXC_001", displayId: "X001", description: "案件不存在" },
      ],
    };

    const designText = "设计中引用功能 F001（注册案件）和 F002（搜索案件）。设计需要处理约束 C001：案件编号格式。";
    const testCasesText = "测试功能 F001 注册案件。测试 F002 搜索案件。边界测试 C001 案件编号格式。异常测试 X001 案件不存在。";

    const result = validateReview(requirementJson, designText, testCasesText);

    expect(result.passed).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("detects duplicate canonical IDs across entities", () => {
    const requirementJson = {
      entities: [
        { id: "E_CASE", canonicalName: "Case", displayName: "案件" },
        { id: "E_DUP", canonicalName: "Case", displayName: "重复" },
      ],
      functions: [],
      constraints: [],
      exceptions: [],
    };

    const result = validateReview(requirementJson, "", "");

    const idCheck = result.checks.find((c) => c.name === "ID 唯一性");
    expect(idCheck).toBeDefined();
    expect(idCheck!.passed).toBe(false);
    expect(idCheck!.detail).toContain("Case");
    expect(result.passed).toBe(false);
  });

  it("detects missing function IDs referenced in design but not in requirement", () => {
    const requirementJson = {
      entities: [],
      functions: [
        { id: "FUN_001", displayId: "F001", name: "注册" },
      ],
      constraints: [],
      exceptions: [],
    };

    const designText = "设计中引用了 F001 和 F999 功能。";
    const testCasesText = "";

    const result = validateReview(requirementJson, designText, testCasesText);

    const refCheck = result.checks.find((c) => c.name === "引用完整性");
    expect(refCheck).toBeDefined();
    expect(refCheck!.passed).toBe(false);
    expect(refCheck!.detail).toContain("F999");
    expect(result.passed).toBe(false);
  });

  it("detects self-invented IDs (C001, F001 patterns not in requirement)", () => {
    const requirementJson = {
      entities: [],
      functions: [
        { id: "FUN_001", displayId: "F001", name: "注册" },
      ],
      constraints: [],
      exceptions: [],
    };

    const designText = "设计中出现了 C005 这不应该被发明。"; // C005 not in requirement
    const testCasesText = "测试中出现了 F999。";

    const result = validateReview(requirementJson, designText, testCasesText);

    const inventedCheck = result.checks.find((c) => c.name === "自编 ID 检测");
    expect(inventedCheck).toBeDefined();
    expect(inventedCheck!.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("detects when constraint is not referenced in design", () => {
    const requirementJson = {
      entities: [],
      functions: [],
      constraints: [
        { id: "CON_001", displayId: "C001", description: "密码约束" },
        { id: "CON_002", displayId: "C002", description: "用户名约束" },
      ],
      exceptions: [],
    };

    const designText = "设计中只提到了 C001 约束。"; // C002 missing
    const testCasesText = "测试 C001 和 C002。";

    const result = validateReview(requirementJson, designText, testCasesText);

    const designCheck = result.checks.find((c) => c.name === "约束设计覆盖");
    expect(designCheck).toBeDefined();
    expect(designCheck!.passed).toBe(false);
    expect(designCheck!.detail).toContain("C002");
    expect(result.passed).toBe(false);
  });

  it("detects when constraint is not referenced in tests", () => {
    const requirementJson = {
      entities: [],
      functions: [],
      constraints: [
        { id: "CON_001", displayId: "C001", description: "密码约束" },
      ],
      exceptions: [],
    };

    const designText = "设计引用 C001。";
    const testCasesText = "测试没有提到任何约束。"; // C001 missing

    const result = validateReview(requirementJson, designText, testCasesText);

    const testCheck = result.checks.find((c) => c.name === "约束测试覆盖");
    expect(testCheck).toBeDefined();
    expect(testCheck!.passed).toBe(false);
    expect(testCheck!.detail).toContain("C001");
    expect(result.passed).toBe(false);
  });

  it("detects empty steps or expected results in test cases", () => {
    const requirementJson = {
      entities: [],
      functions: [
        { id: "FUN_001", displayId: "F001", name: "注册" },
      ],
      constraints: [],
      exceptions: [],
    };

    // Test cases with empty steps - using structured-ish text
    const testCasesText = `
## TC001 注册案件
步骤：
预期结果：
    `.trim();

    const result = validateReview(requirementJson, "", testCasesText);

    const emptyCheck = result.checks.find((c) => c.name === "空步骤/空预期检测");
    expect(emptyCheck).toBeDefined();
    expect(emptyCheck!.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("calulates coverage percentages correctly", () => {
    const requirementJson = {
      entities: [],
      functions: [
        { id: "FUN_001", displayId: "F001", name: "功能1" },
        { id: "FUN_002", displayId: "F002", name: "功能2" },
        { id: "FUN_003", displayId: "F003", name: "功能3" },
        { id: "FUN_004", displayId: "F004", name: "功能4" },
      ],
      constraints: [
        { id: "CON_001", displayId: "C001", description: "约束1" },
        { id: "CON_002", displayId: "C002", description: "约束2" },
      ],
      exceptions: [
        { id: "EXC_001", displayId: "X001", description: "异常1" },
        { id: "EXC_002", displayId: "X002", description: "异常2" },
      ],
    };

    // Only half covered
    const testCasesText = "测试 F001 和 F002。验证 C001。异常 X001。";

    const result = validateReview(requirementJson, "", testCasesText);

    const covCheck = result.checks.find((c) => c.name === "覆盖率");
    expect(covCheck).toBeDefined();
    // 2/4 functions + 1/2 constraints(test) + 0/2 constraints(design) + 1/2 exceptions
    // Everything is partial, so passed should be false
    expect(covCheck!.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("handles empty inputs gracefully (all checks pass)", () => {
    const requirementJson = {};
    const designText = "";
    const testCasesText = "";

    const result = validateReview(requirementJson, designText, testCasesText);

    expect(result.passed).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("returns all 7 check items in the result", () => {
    const requirementJson = { entities: [], functions: [], constraints: [], exceptions: [] };

    const result = validateReview(requirementJson, "", "");

    const checkNames = result.checks.map((c) => c.name);
    expect(checkNames).toContain("ID 唯一性");
    expect(checkNames).toContain("引用完整性");
    expect(checkNames).toContain("覆盖率");
    expect(checkNames).toContain("自编 ID 检测");
    expect(checkNames).toContain("约束设计覆盖");
    expect(checkNames).toContain("约束测试覆盖");
    expect(checkNames).toContain("空步骤/空预期检测");
    expect(result.checks).toHaveLength(7);
  });
});
