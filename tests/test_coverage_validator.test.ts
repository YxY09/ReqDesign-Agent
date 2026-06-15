import { describe, it, expect } from "vitest";
import { validateCoverage } from "../src/shared/coverageValidator.js";
import type { CoverageReport } from "../src/shared/coverageValidator.js";

describe("validateCoverage", () => {
  it("returns 100% when all functions, constraints, and exceptions are covered in tests and design", () => {
    const requirementJson = {
      functions: [
        { id: "FUN_001", displayId: "F001", name: "用户注册" },
        { id: "FUN_002", displayId: "F002", name: "用户登录" },
      ],
      constraints: [
        { id: "CON_001", displayId: "C001", description: "密码长度至少8位", source_text: "source" },
      ],
      exceptions: [
        { id: "EXC_001", displayId: "X001", description: "用户已存在" },
      ],
    };

    const designText = "设计方案中需要处理 C001 约束，即密码长度至少8位。";
    const testCasesText = `
      测试用例覆盖 F001 用户注册功能。
      测试用例覆盖 F002 用户登录功能。
      边界测试验证 C001 密码长度约束。
      异常测试验证 X001 用户已存在异常。
    `;

    const report = validateCoverage(requirementJson, designText, testCasesText);

    expect(report.functionCoverage.total).toBe(2);
    expect(report.functionCoverage.covered).toBe(2);
    expect(report.functionCoverage.uncovered).toHaveLength(0);

    expect(report.constraintTestCoverage.total).toBe(1);
    expect(report.constraintTestCoverage.covered).toBe(1);
    expect(report.constraintTestCoverage.uncovered).toHaveLength(0);

    expect(report.constraintDesignCoverage.total).toBe(1);
    expect(report.constraintDesignCoverage.covered).toBe(1);
    expect(report.constraintDesignCoverage.uncovered).toHaveLength(0);

    expect(report.exceptionCoverage.total).toBe(1);
    expect(report.exceptionCoverage.covered).toBe(1);
    expect(report.exceptionCoverage.uncovered).toHaveLength(0);

    expect(report.invalidReferences).toHaveLength(0);
    expect(report.overall).toBe(100);
  });

  it("reports uncovered items when some functions, constraints, or exceptions are missing", () => {
    const requirementJson = {
      functions: [
        { id: "FUN_001", displayId: "F001", name: "用户注册" },
        { id: "FUN_002", displayId: "F002", name: "用户登录" },
      ],
      constraints: [
        { id: "CON_001", displayId: "C001", description: "密码长度至少8位" },
        { id: "CON_002", displayId: "C002", description: "用户名唯一" },
      ],
      exceptions: [
        { id: "EXC_001", displayId: "X001", description: "用户已存在" },
        { id: "EXC_002", displayId: "X002", description: "密码错误" },
      ],
    };

    const designText = "设计中提到了 C001，密码长度至少8位。"; // C002 missing in design
    const testCasesText = "测试 F001 功能。"; // F002, C001, C002, X001, X002 all missing in tests

    const report = validateCoverage(requirementJson, designText, testCasesText);

    expect(report.functionCoverage.uncovered).toHaveLength(1);
    expect(report.functionCoverage.uncovered[0].displayId).toBe("F002");

    expect(report.constraintTestCoverage.uncovered).toHaveLength(2);
    expect(report.constraintDesignCoverage.uncovered).toHaveLength(1);
    expect(report.constraintDesignCoverage.uncovered[0].displayId).toBe("C002");

    expect(report.exceptionCoverage.uncovered).toHaveLength(2);

    expect(report.overall).toBeLessThan(100);
  });

  it("does not count a constraint ID as design coverage when the nearby semantics drift", () => {
    const requirementJson = {
      functions: [],
      constraints: [
        { id: "CON_REVIEW", displayId: "C011", description: "同一商品30天内只能追加评价一次" },
      ],
      exceptions: [],
    };
    const designText = "C011 支付超时30分钟自动取消订单。";

    const report = validateCoverage(requirementJson, designText, "");

    expect(report.constraintDesignCoverage.uncovered).toHaveLength(1);
    expect(report.constraintDesignCoverage.uncovered[0].displayId).toBe("C011");
  });

  it("detects invalid references to IDs that are not defined", () => {
    const requirementJson = {
      functions: [
        { id: "FUN_001", displayId: "F001", name: "用户注册" },
      ],
      constraints: [],
      exceptions: [],
    };

    const designText = "设计中出现了 C999 不存在的约束。";
    const testCasesText = "测试 F001 功能。异常测试 X999。还有 F888 不存在的功能。";

    const report = validateCoverage(requirementJson, designText, testCasesText);

    expect(report.invalidReferences).toContain("F888");
    expect(report.invalidReferences).toContain("X999");
    expect(report.invalidReferences).toContain("C999");
  });

  it("handles empty inputs gracefully", () => {
    const requirementJson = {};
    const designText = "";
    const testCasesText = "";

    const report = validateCoverage(requirementJson, designText, testCasesText);

    expect(report.functionCoverage.total).toBe(0);
    expect(report.constraintTestCoverage.total).toBe(0);
    expect(report.constraintDesignCoverage.total).toBe(0);
    expect(report.exceptionCoverage.total).toBe(0);
    expect(report.invalidReferences).toHaveLength(0);
    expect(report.overall).toBe(100); // nothing to cover
  });
});
