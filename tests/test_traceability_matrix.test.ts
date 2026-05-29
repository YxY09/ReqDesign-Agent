import { describe, it, expect } from "vitest";
import { buildMatrix } from "../src/shared/traceabilityMatrix.js";
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
      Design for C001 audit constraint.
      Design also addresses C002 performance constraint.
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

    // functionToConstraints
    expect(matrix.functionToConstraints["FUN_USER_REGISTER"]).toContain("C001");
    expect(matrix.functionToConstraints["FUN_USER_LOGIN"]).toContain("C002");

    // constraintToFunctions (inverse)
    expect(matrix.constraintToFunctions["C001"]).toContain("FUN_USER_REGISTER");
    expect(matrix.constraintToFunctions["C002"]).toContain("FUN_USER_LOGIN");

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

    const designText = "Design for C001 only.";
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
    expect(matrix.constraintToEvidence["CON_SEC_AUDIT_ABC1"]).toEqual(["SEC_AUDIT_001"]);
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
    expect(matrix.functionToConstraints["FUN_USER_REGISTER"]).toContain("C001");
    expect(matrix.functionToConstraints["FUN_USER_LOGIN"]).toContain("C002");

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
});
