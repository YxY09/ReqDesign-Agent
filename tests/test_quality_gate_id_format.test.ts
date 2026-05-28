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
});
