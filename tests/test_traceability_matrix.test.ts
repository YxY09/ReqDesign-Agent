import { describe, it, expect } from "vitest";
import { buildMatrix, parseDesignModuleTable } from "../src/shared/traceabilityMatrix.js";
import type { TraceabilityMatrix } from "../src/shared/traceabilityMatrix.js";

describe("buildMatrix", () => {
  // ---------------------------------------------------------------------------
  // Helper: build a representative analysis.json-shaped object
  // ---------------------------------------------------------------------------
  function makeRequirementJson(overrides: Record<string, unknown> = {}) {
    return {
      functions: [
        { id: "FUN_USER_REGISTER", displayId: "F001", name: "UserRegister" },
        { id: "FUN_USER_LOGIN", displayId: "F002", name: "UserLogin" },
      ],
      constraints: [
        {
          id: "CON_SEC_AUDIT_ABC1",
          displayId: "C001",
          description: "Audit trail data cannot be modified or deleted",
          sourceText: "审计跟踪数据不可修改",
          related_functions: ["FUN_USER_REGISTER"],
          evidence: [{ sentenceId: "SEC_HELP_001", sourceText: "审计跟踪数据不可修改" }],
        },
        {
          id: "CON_PERF_RESP_ABC2",
          displayId: "C002",
          description: "Response time must be under 2 seconds",
          sourceText: "响应时间低于2秒",
          related_functions: ["FUN_USER_LOGIN"],
          evidence: [{ sentenceId: "SEC_PERF_001", sourceText: "响应时间低于2秒" }],
        },
      ],
      exceptions: [
        { id: "EXC_USER_EXISTS", displayId: "X001", description: "User already exists" },
        { id: "EXC_INVALID_PWD", displayId: "X002", description: "Invalid password" },
      ],
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // Test 1: Full coverage — all items referenced in design and tests
  // ---------------------------------------------------------------------------
  it("builds full coverage matrix when all items are referenced in design and tests", () => {
    const json = makeRequirementJson();

    const designText = `
      Design for C001 audit trail data cannot be modified or deleted.
      Design also addresses C002 response time under 2 seconds.
    `;
    const testCasesText = `
      Test F001 UserRegister.
      Test F002 UserLogin.
      Test C001 audit constraint.
      Test C002 performance constraint.
      Test X001 user exists exception.
      Test X002 invalid password exception.
    `;

    const matrix = buildMatrix(json, designText, testCasesText);

    // functionToConstraints (keyed by displayId F001/F002; related_functions
    // carry canonicalIds FUN_USER_REGISTER which resolve to displayIds)
    expect(matrix.functionToConstraints["F001"]).toContain("C001");
    expect(matrix.functionToConstraints["F002"]).toContain("C002");

    // constraintToFunctions (inverse, displayId only)
    expect(matrix.constraintToFunctions["C001"]).toContain("F001");
    expect(matrix.constraintToFunctions["C002"]).toContain("F002");

    // constraintToDesign
    expect(matrix.constraintToDesign["C001"]).toBeDefined();
    expect(matrix.constraintToDesign["C002"]).toBeDefined();

    // constraintToTests
    expect(matrix.constraintToTests["C001"]).toBeDefined();
    expect(matrix.constraintToTests["C002"]).toBeDefined();

    // functionToTests
    expect(matrix.functionToTests["F001"]).toBeDefined();
    expect(matrix.functionToTests["F002"]).toBeDefined();

    // exceptionToTests
    expect(matrix.exceptionToTests["X001"]).toBeDefined();
    expect(matrix.exceptionToTests["X002"]).toBeDefined();

    // uncovered arrays all empty
    expect(matrix.uncoveredConstraints).toHaveLength(0);
    expect(matrix.uncoveredFunctions).toHaveLength(0);
    expect(matrix.uncoveredExceptions).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Partial coverage — some items unreferenced
  // ---------------------------------------------------------------------------
  it("populates uncovered arrays for items not referenced in design or tests", () => {
    const json = makeRequirementJson();

    const designText = "Design for C001 audit trail data cannot be modified or deleted only.";
    const testCasesText = "Test F001 and X001 only.";

    const matrix = buildMatrix(json, designText, testCasesText);

    // uncovered constraints: C002 not in design AND not in tests
    expect(matrix.uncoveredConstraints).toContain("C002");
    expect(matrix.uncoveredConstraints).not.toContain("C001");

    // uncovered functions: F002 not in tests
    expect(matrix.uncoveredFunctions).toContain("F002");
    expect(matrix.uncoveredFunctions).not.toContain("F001");

    // uncovered exceptions: X002 not in tests
    expect(matrix.uncoveredExceptions).toContain("X002");
    expect(matrix.uncoveredExceptions).not.toContain("X001");
  });

  // ---------------------------------------------------------------------------
  // Test 3: Bidirectional mapping correctness
  // ---------------------------------------------------------------------------
  it("ensures functionToConstraints and constraintToFunctions are inverses", () => {
    const json = makeRequirementJson();

    const matrix = buildMatrix(json);

    // Every entry in functionToConstraints must have a reverse in constraintToFunctions
    for (const [funcId, constraintIds] of Object.entries(matrix.functionToConstraints)) {
      for (const cid of constraintIds) {
        expect(matrix.constraintToFunctions[cid]).toBeDefined();
        expect(matrix.constraintToFunctions[cid]).toContain(funcId);
      }
    }

    // Every entry in constraintToFunctions must have a reverse in functionToConstraints
    for (const [cid, funcIds] of Object.entries(matrix.constraintToFunctions)) {
      for (const fid of funcIds) {
        expect(matrix.functionToConstraints[fid]).toBeDefined();
        expect(matrix.functionToConstraints[fid]).toContain(cid);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Test 4: Evidence extraction from constraint evidence array
  // ---------------------------------------------------------------------------
  it("extracts sentenceIds from constraint evidence array into constraintToEvidence", () => {
    const json = makeRequirementJson();

    const matrix = buildMatrix(json);

    // C001 has evidence with sentenceId
    expect(matrix.constraintToEvidence["C001"]).toBeDefined();
    expect(matrix.constraintToEvidence["C001"]).toContain("SEC_HELP_001");

    // C002 has evidence with sentenceId
    expect(matrix.constraintToEvidence["C002"]).toBeDefined();
    expect(matrix.constraintToEvidence["C002"]).toContain("SEC_PERF_001");
  });

  it("resolves constraint evidence sentenceIds from spanMap when canonical evidence only has sourceText", () => {
    const json = makeRequirementJson({
      constraints: [
        {
          id: "CON_SEC_AUDIT_ABC1",
          displayId: "C001",
          description: "Audit trail data cannot be modified or deleted",
          sourceText: "审计跟踪数据不可修改",
          related_functions: ["FUN_USER_REGISTER"],
          evidence: [{ sourceText: "审计跟踪数据不可修改", sectionId: "SEC_AUDIT" }],
        },
      ],
    });

    const matrix = buildMatrix(json, undefined, undefined, {
      SEC_AUDIT_001: {
        sentenceId: "SEC_AUDIT_001",
        sectionId: "SEC_AUDIT",
        sourceText: "审计跟踪数据不可修改",
      },
    });

    expect(matrix.constraintToEvidence["C001"]).toEqual(["SEC_AUDIT_001"]);
    // displayId-only keys: canonicalId key must not be present
    expect(matrix.constraintToEvidence["CON_SEC_AUDIT_ABC1"]).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 5: Empty inputs — all arrays empty, all maps empty
  // ---------------------------------------------------------------------------
  it("handles completely empty inputs gracefully", () => {
    const json = {};

    const matrix = buildMatrix(json);

    expect(Object.keys(matrix.functionToConstraints)).toHaveLength(0);
    expect(Object.keys(matrix.constraintToFunctions)).toHaveLength(0);
    expect(Object.keys(matrix.constraintToDesign)).toHaveLength(0);
    expect(Object.keys(matrix.constraintToTests)).toHaveLength(0);
    expect(Object.keys(matrix.constraintToEvidence)).toHaveLength(0);
    expect(Object.keys(matrix.functionToTests)).toHaveLength(0);
    expect(Object.keys(matrix.exceptionToTests)).toHaveLength(0);
    expect(matrix.uncoveredConstraints).toHaveLength(0);
    expect(matrix.uncoveredFunctions).toHaveLength(0);
    expect(matrix.uncoveredExceptions).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 6: Missing optional args — designText and testCasesText undefined
  // ---------------------------------------------------------------------------
  it("builds matrix with empty design/test maps when optional args are omitted", () => {
    const json = makeRequirementJson();

    const matrix = buildMatrix(json); // no designText, no testCasesText

    // functionToConstraints should still be populated from related_functions
    // (related_functions carry canonicalId FUN_USER_REGISTER → resolved to F001)
    expect(matrix.functionToConstraints["F001"]).toContain("C001");
    expect(matrix.functionToConstraints["F002"]).toContain("C002");
    // canonicalId keys must not be present
    expect(matrix.functionToConstraints["FUN_USER_REGISTER"]).toBeUndefined();
    expect(matrix.functionToConstraints["FUN_USER_LOGIN"]).toBeUndefined();

    // constraintToEvidence should still be populated
    expect(matrix.constraintToEvidence["C001"]).toBeDefined();

    // But design/test maps should be empty
    expect(Object.keys(matrix.constraintToDesign)).toHaveLength(0);
    expect(Object.keys(matrix.constraintToTests)).toHaveLength(0);
    expect(Object.keys(matrix.functionToTests)).toHaveLength(0);
    expect(Object.keys(matrix.exceptionToTests)).toHaveLength(0);

    // Everything should be uncovered since no design/tests
    expect(matrix.uncoveredConstraints.length).toBeGreaterThan(0);
    expect(matrix.uncoveredFunctions.length).toBeGreaterThan(0);
    expect(matrix.uncoveredExceptions.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Test 7: designModel.coverageMatrix drives constraintToDesign with real
  // module/class names (displayId keys, canonical refIds normalized).
  // ---------------------------------------------------------------------------
  it("builds constraintToDesign from designModel.coverageMatrix with module/class names", () => {
    const json = makeRequirementJson();
    const designModel = {
      modules: [],
      classes: [],
      dataFlows: [],
      coverageMatrix: [
        {
          refId: "C001",
          refKind: "constraint",
          originalDescription: "audit",
          designDecision: "audit module",
          affectedModuleIds: ["MOD_AUDIT"],
          affectedClassNames: ["AuditService"],
          testImplication: "t",
        },
        {
          refId: "CON_PERF_RESP_ABC2",
          refKind: "constraint",
          originalDescription: "perf",
          designDecision: "cache",
          affectedModuleIds: ["MOD_CACHE"],
          affectedClassNames: [],
          testImplication: "t",
        },
        {
          refId: "F001",
          refKind: "function",
          originalDescription: "register",
          designDecision: "register module",
          affectedModuleIds: ["MOD_USER"],
          affectedClassNames: ["UserService"],
          testImplication: "t",
        },
        {
          refId: "X001",
          refKind: "exception",
          originalDescription: "exists",
          designDecision: "handle",
          affectedModuleIds: [],
          affectedClassNames: [],
          testImplication: "t",
        },
      ],
    };

    const matrix = buildMatrix(json, undefined, undefined, undefined, designModel);

    // constraintToDesign keyed by displayId, with real module/class names
    expect(matrix.constraintToDesign["C001"]).toEqual(
      expect.arrayContaining(["MOD_AUDIT", "AuditService"]),
    );
    // canonicalId refId normalized to displayId C002
    expect(matrix.constraintToDesign["C002"]).toEqual(
      expect.arrayContaining(["MOD_CACHE"]),
    );
    // functionToDesign / exceptionToDesign populated
    expect(matrix.functionToDesign["F001"]).toEqual(
      expect.arrayContaining(["MOD_USER", "UserService"]),
    );
    // exception with no module/class still marked designed (non-empty)
    expect(matrix.exceptionToDesign["X001"]).toBeDefined();
    expect(matrix.exceptionToDesign["X001"].length).toBeGreaterThan(0);

    // No canonicalId keys leak into the maps
    expect(matrix.constraintToDesign["CON_SEC_AUDIT_ABC1"]).toBeUndefined();
    expect(matrix.constraintToDesign["CON_PERF_RESP_ABC2"]).toBeUndefined();

    // Both constraints designed → not uncovered (no tests, but design covers them)
    expect(matrix.uncoveredConstraints).not.toContain("C001");
    expect(matrix.uncoveredConstraints).not.toContain("C002");
  });

  // ---------------------------------------------------------------------------
  // Test 8: *ToTests maps must hold real test-case IDs (TC-xxx), not
  // self-referential constraint/function/exception displayIds.
  // ---------------------------------------------------------------------------
  it("maps structured JSON test cases to TC-xxx ids (no self-reference)", () => {
    const json = makeRequirementJson();
    const testCasesText = JSON.stringify({
      test_cases: [
        { id: "TC-N-001", title: "Audit", type: "正常", target: "C001", steps: [], expected_result: "ok" },
        { id: "TC-N-002", title: "Perf", type: "正常", target: "C002", steps: [], expected_result: "ok" },
        { id: "TC-N-003", title: "Reg", type: "正常", target: "F001", steps: [], expected_result: "ok" },
        { id: "TC-N-004", title: "Log", type: "正常", target: "F002", steps: [], expected_result: "ok" },
        { id: "TC-E-001", title: "Exists", type: "异常", target: "X001", steps: [], expected_result: "ok" },
        { id: "TC-E-002", title: "Pwd", type: "异常", target: "X002", steps: [], expected_result: "ok" },
      ],
    });

    const matrix = buildMatrix(json, undefined, testCasesText);

    // Values are TC-xxx ids, not the constraint/function/exception id itself.
    expect(matrix.constraintToTests["C001"]).toEqual(["TC-N-001"]);
    expect(matrix.constraintToTests["C001"]).not.toContain("C001");
    expect(matrix.constraintToTests["C002"]).toEqual(["TC-N-002"]);
    expect(matrix.functionToTests["F001"]).toEqual(["TC-N-003"]);
    expect(matrix.functionToTests["F002"]).toEqual(["TC-N-004"]);
    expect(matrix.exceptionToTests["X001"]).toEqual(["TC-E-001"]);
    expect(matrix.exceptionToTests["X002"]).toEqual(["TC-E-002"]);

    // Coverage booleans still work (everything covered).
    expect(matrix.uncoveredConstraints).toHaveLength(0);
    expect(matrix.uncoveredFunctions).toHaveLength(0);
    expect(matrix.uncoveredExceptions).toHaveLength(0);
  });

  it("maps markdown test cases to TC-xxx ids via the 测试对象 field", () => {
    const json = makeRequirementJson();
    const testCasesText = [
      "## TC-N-001: Audit",
      "- **类型**: 正常",
      "- **测试对象**: C001",
      "- **测试步骤**: check audit",
      "- **预期结果**: ok",
      "",
      "## TC-E-001: Exists",
      "- **类型**: 异常",
      "- **测试对象**: X001",
      "- **测试步骤**: register existing",
      "- **预期结果**: error",
      "",
    ].join("\n");

    const matrix = buildMatrix(json, undefined, testCasesText);

    expect(matrix.constraintToTests["C001"]).toEqual(["TC-N-001"]);
    expect(matrix.exceptionToTests["X001"]).toEqual(["TC-E-001"]);
    // A single TC can target multiple refs when listed together.
  });

  it("collects multiple TC ids per target and dedupes", () => {
    const json = makeRequirementJson();
    const testCasesText = JSON.stringify({
      test_cases: [
        { id: "TC-N-001", title: "A", type: "正常", target: "C001", steps: [], expected_result: "" },
        { id: "TC-N-002", title: "B", type: "正常", target: "C001", steps: [], expected_result: "" },
        // duplicate id for the same target should not appear twice
        { id: "TC-N-002", title: "B2", type: "正常", target: "C001", steps: [], expected_result: "" },
      ],
    });

    const matrix = buildMatrix(json, undefined, testCasesText);

    expect(matrix.constraintToTests["C001"]).toEqual(["TC-N-001", "TC-N-002"]);
  });

  it("falls back to presence detection for plain-text test cases without TC ids", () => {
    const json = makeRequirementJson();
    const testCasesText = "Test C001 audit constraint. Test F001 register.";

    const matrix = buildMatrix(json, undefined, testCasesText);

    // No TC id available → key presence still drives coverage.
    expect(matrix.constraintToTests["C001"]).toBeDefined();
    expect(matrix.functionToTests["F001"]).toBeDefined();
    // C002 is not mentioned → uncovered.
    expect(matrix.uncoveredConstraints).toContain("C002");
  });

  // ---------------------------------------------------------------------------
  // Test 9: parseDesignModuleTable — tolerates varying header languages/orders
  // ---------------------------------------------------------------------------
  describe("parseDesignModuleTable — markdown module table parsing", () => {
    it("parses an agent-style table (模块ID/模块名称/职责/包含功能ID)", () => {
      const md = [
        "## 模块划分",
        "",
        "| 模块ID | 模块名称 | 职责 | 包含功能ID |",
        "|--------|----------|------|------------|",
        "| M1 | AuthService | 认证 | F001, F002 |",
        "| M2 | AuditService | 审计 | F003 |",
        "",
      ].join("\n");
      const map = parseDesignModuleTable(md);
      expect(map.get("F001")).toEqual(["AuthService"]);
      expect(map.get("F002")).toEqual(["AuthService"]);
      expect(map.get("F003")).toEqual(["AuditService"]);
    });

    it("parses a renderDesignMarkdown-style table (模块名称/职责描述/对应功能)", () => {
      const md = [
        "| 模块名称 | 职责描述 | 对应功能 |",
        "|----------|----------|----------|",
        "| UserService | 用户 | F001 |",
      ].join("\n");
      const map = parseDesignModuleTable(md);
      expect(map.get("F001")).toEqual(["UserService"]);
    });

    it("returns an empty map when there is no module table", () => {
      const md = "# Design\nSome prose about F001 with no table.";
      expect(parseDesignModuleTable(md).size).toBe(0);
      expect(parseDesignModuleTable("").size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 10: markdown fallback populates constraintToDesign/functionToDesign
  // when NO designModel is supplied (the agent's markdown-persisted-design case
  // and the baseline case). Mirrors the root cause of fix 2: designModel=null
  // used to yield an all-empty constraintToDesign because the only fallback was
  // a \bC\d{3}\b presence check the markdown did not satisfy.
  // ---------------------------------------------------------------------------
  it("derives constraintToDesign/functionToDesign from a markdown module table when no designModel is given", () => {
    const json = makeRequirementJson();
    const designMd = [
      "## 模块划分",
      "",
      "| 模块ID | 模块名称 | 职责 | 包含功能ID |",
      "|--------|----------|------|------------|",
      "| M1 | UserModule | 用户 | F001 |",
      "| M2 | LoginModule | 登录 | F002 |",
      "",
    ].join("\n");

    // No designModel (5th arg) — exercises tier 2 (markdown table).
    const matrix = buildMatrix(json, designMd, undefined);

    // functionToDesign carries real module names parsed from the table.
    expect(matrix.functionToDesign["F001"]).toEqual(["UserModule"]);
    expect(matrix.functionToDesign["F002"]).toEqual(["LoginModule"]);

    // constraintToDesign derived via constraint → related_functions → modules.
    // C001 relates to FUN_USER_REGISTER (→F001) → UserModule.
    expect(matrix.constraintToDesign["C001"]).toEqual(["UserModule"]);
    // C002 relates to FUN_USER_LOGIN (→F002) → LoginModule.
    expect(matrix.constraintToDesign["C002"]).toEqual(["LoginModule"]);

    // Both constraints are now designed → not uncovered.
    expect(matrix.uncoveredConstraints).not.toContain("C001");
    expect(matrix.uncoveredConstraints).not.toContain("C002");
  });

  // ---------------------------------------------------------------------------
  // Test 11: coverageMatrix + markdown table are additive (tier 1 not
  // clobbered, tier 2 contributes new functions).
  // ---------------------------------------------------------------------------
  it("merges coverageMatrix and markdown module table results additively", () => {
    const json = makeRequirementJson();
    const designModel = {
      modules: [],
      classes: [],
      dataFlows: [],
      coverageMatrix: [
        {
          refId: "C001",
          refKind: "constraint",
          originalDescription: "audit",
          designDecision: "audit module",
          affectedModuleIds: ["MOD_AUDIT"],
          affectedClassNames: ["AuditService"],
          testImplication: "t",
        },
      ],
    };
    const designMd = [
      "| 模块名称 | 职责描述 | 对应功能 |",
      "|----------|----------|----------|",
      "| LoginModule | 登录 | F002 |",
    ].join("\n");

    const matrix = buildMatrix(json, designMd, undefined, undefined, designModel);

    // Tier 1 result preserved (not overwritten).
    expect(matrix.constraintToDesign["C001"]).toEqual(
      expect.arrayContaining(["MOD_AUDIT", "AuditService"]),
    );
    // Tier 2 contributes functionToDesign from the markdown table.
    expect(matrix.functionToDesign["F002"]).toEqual(["LoginModule"]);
    // C002 (related to F002) now also designed via the table.
    expect(matrix.constraintToDesign["C002"]).toEqual(["LoginModule"]);
  });
});
