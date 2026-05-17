import { describe, it, expect } from "vitest";
import { TestCaseGenerator } from "../src/generators/tests.js";

describe("TestCaseGenerator.validateTestCases", () => {
  it("should warn when table format is missing", () => {
    const testCases = "这是一段普通文本，没有表格。";
    const req = { functions: [] };
    const warnings = TestCaseGenerator.validateTestCases(testCases, req);
    expect(warnings.some((w) => w.includes("表格"))).toBe(true);
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
    const testCases = `| 编号 | 类型 |
|------|------|
| TC-N-001 | 正常 |
| TC-N-002 | 正常 |
| TC-N-003 | 正常 |
| TC-E-001 | 异常 |
| TC-E-002 | 异常 |
| TC-B-001 | 边界 |
| TC-B-002 | 边界 |`;
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
});

describe("TestCaseGenerator.countTestCases", () => {
  it("should count normal, exception, and boundary cases correctly", () => {
    const testCases = `
| TC-N-001 | 正常 |
| TC-N-002 | 正常 |
| TC-E-001 | 异常 |
| TC-B-001 | 边界 |
| TC-B-002 | 边界 |
| TC-B-003 | 边界 |
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
