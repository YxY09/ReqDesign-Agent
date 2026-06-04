import { describe, it, expect } from "vitest";
import { checkAnalysisQuality } from "../src/shared/analysisQualityGate.js";

// ---------------------------------------------------------------------------
// Regression test: id_format check should pass on valid ID formats.
// Tests the quality gate pattern directly with manually constructed data.
// ---------------------------------------------------------------------------

describe("checkAnalysisQuality id_format check", () => {
  it("passes when all IDs match per-type canonical prefixes", () => {
    const analysis = {
      actors: [{ id: "A_ADMIN", name: "Admin" }],
      entities: [
        { id: "E_USER", name: "User", attributes: [{ name: "id" }] },
      ],
      functions: [
        { id: "FUN_LOGIN", name: "Login", description: "User login" },
        { id: "FUN_LOGOUT", name: "Logout", description: "User logout" },
      ],
      constraints: [
        { id: "CON_MUST_AUTH", description: "Must authenticate", related_functions: ["FUN_LOGIN"] },
      ],
      exceptions: [
        { id: "EXC_AUTH_FAIL", description: "Auth failure", trigger: "bad creds", handling: "retry" },
      ],
    };

    const result = checkAnalysisQuality(analysis);
    const idCheck = result.checks.find((c) => c.name === "id_format");
    expect(idCheck).toBeDefined();
    expect(idCheck!.passed).toBe(true);
  });

  it("fails when IDs do NOT match per-type canonical prefixes", () => {
    const analysis = {
      actors: [{ id: "bad_actor", name: "Admin" }],
      entities: [
        { id: "bad_entity", name: "User", attributes: [] },
      ],
      functions: [
        { id: "123", name: "Login", description: "Login" },
      ],
      constraints: [
        { id: "_BAD", description: "Some constraint" },
      ],
      exceptions: [],
    };

    const result = checkAnalysisQuality(analysis);
    const idCheck = result.checks.find((c) => c.name === "id_format");
    expect(idCheck).toBeDefined();
    expect(idCheck!.passed).toBe(false);
  });

  it("rejects wrong-type prefix (e.g. entity with FUN_ prefix)", () => {
    const analysis = {
      actors: [],
      entities: [
        { id: "FUN_LOGIN", name: "User", attributes: [{ name: "id" }] },
      ],
      functions: [],
      constraints: [],
      exceptions: [],
    };

    const result = checkAnalysisQuality(analysis);
    const idCheck = result.checks.find((c) => c.name === "id_format");
    expect(idCheck).toBeDefined();
    expect(idCheck!.passed).toBe(false);
    expect(idCheck!.detail).toContain("FUN_LOGIN");
  });

  it("rejects old-format IDs (E001, F001, C001, X001)", () => {
    const analysis = {
      actors: [],
      entities: [{ id: "E001", name: "User", attributes: [] }],
      functions: [{ id: "F001", name: "Login", description: "Login" }],
      constraints: [{ id: "C001", description: "Constraint" }],
      exceptions: [{ id: "X001", description: "Exception" }],
    };

    const result = checkAnalysisQuality(analysis);
    const idCheck = result.checks.find((c) => c.name === "id_format");
    expect(idCheck).toBeDefined();
    expect(idCheck!.passed).toBe(false);
  });

  it("handles items with no id field gracefully", () => {
    const analysis = {
      actors: [{ name: "Admin" }],
      entities: [
        { name: "User", attributes: [] },
      ],
      functions: [],
      constraints: [],
      exceptions: [],
    };

    const result = checkAnalysisQuality(analysis);
    const idCheck = result.checks.find((c) => c.name === "id_format");
    expect(idCheck).toBeDefined();
    // No items with id → passed (vacuously true per the code: totalWithId === 0)
    expect(idCheck!.passed).toBe(true);
  });

  it("flags missing reified process entities", () => {
    const analysis = {
      actors: [{ id: "A_OFFICER", name: "Officer" }],
      entities: [
        {
          id: "E_CASE",
          name: "Case",
          attributes: [{ name: "caseId", type: "Long", description: "ID" }],
          relationships: [],
        },
      ],
      functions: [
        { id: "FUN_INVESTIGATE_CASE", name: "InvestigateCase", description: "调查案件" },
      ],
      constraints: [
        { id: "CON_CASE_STATUS", description: "Case status must be updated" },
      ],
      exceptions: [],
      business_processes: [
        {
          name: "CaseInvestigation",
          steps: ["Gather evidence", "Write investigation report", "Update status"],
        },
      ],
    };

    const result = checkAnalysisQuality(
      analysis,
      "CaseInvestigation stores evidence, investigation report, conclusion, and status.",
    );
    const check = result.checks.find((c) => c.name === "relationship_entity_coverage");
    expect(check).toBeDefined();
    expect(check!.passed).toBe(false);
    expect(check!.detail).toContain("CaseInvestigation");
  });

  it("passes reified process entity check when the process record exists", () => {
    const analysis = {
      actors: [{ id: "A_OFFICER", name: "Officer" }],
      entities: [
        {
          id: "E_CASE",
          name: "Case",
          attributes: [{ name: "caseId", type: "Long", description: "ID" }],
          relationships: [{ target: "CaseInvestigation", type: "one-to-many", description: "调查记录" }],
        },
        {
          id: "E_CASE_INVESTIGATION",
          name: "CaseInvestigation",
          entityKind: "process_record",
          attributes: [
            { name: "caseInvestigationId", type: "Long", description: "ID" },
            { name: "status", type: "String", description: "状态" },
          ],
          relationships: [{ target: "Case", type: "many-to-one", description: "关联案件" }],
          reifies: {
            source: "business_process",
            sourceName: "CaseInvestigation",
            endpoints: ["Case"],
            evidence: ["has_report_or_evidence", "has_status"],
          },
        },
      ],
      functions: [
        { id: "FUN_INVESTIGATE_CASE", name: "InvestigateCase", description: "调查案件" },
      ],
      constraints: [
        { id: "CON_CASE_STATUS", description: "Case status must be updated" },
      ],
      exceptions: [],
      business_processes: [
        {
          name: "CaseInvestigation",
          steps: ["Gather evidence", "Write investigation report", "Update status"],
        },
      ],
    };

    const result = checkAnalysisQuality(
      analysis,
      "CaseInvestigation stores evidence, investigation report, conclusion, and status.",
    );
    const check = result.checks.find((c) => c.name === "relationship_entity_coverage");
    expect(check).toBeDefined();
    expect(check!.passed).toBe(true);
  });
});
