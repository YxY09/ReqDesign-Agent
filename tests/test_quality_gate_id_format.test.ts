import { describe, it, expect } from "vitest";
import { checkAnalysisQuality } from "../src/shared/analysisQualityGate.js";

// ---------------------------------------------------------------------------
// Regression test: id_format check should pass on canonical IDs
// (E001, F001, C001, X001) — the quality gate now runs AFTER assignCanonicalIds
// so it validates the final output, not pre-canonical IDs.
// ---------------------------------------------------------------------------

describe("checkAnalysisQuality id_format check", () => {
  it("passes when all IDs match E/F/C/X + digits pattern", () => {
    const analysis = {
      actors: [{ name: "Admin" }],
      entities: [
        { id: "E001", name: "User", attributes: [{ name: "id" }] },
      ],
      functions: [
        { id: "F001", name: "Login", description: "User login" },
        { id: "F002", name: "Logout", description: "User logout" },
      ],
      constraints: [
        { id: "C001", description: "Must authenticate", related_functions: ["F001"] },
      ],
      exceptions: [
        { id: "X001", description: "Auth failure", trigger: "bad creds", handling: "retry" },
      ],
    };

    const result = checkAnalysisQuality(analysis);
    const idCheck = result.checks.find((c) => c.name === "id_format");
    expect(idCheck).toBeDefined();
    expect(idCheck!.passed).toBe(true);
  });

  it("fails when IDs do NOT match canonical pattern", () => {
    const analysis = {
      actors: [{ name: "Admin" }],
      entities: [
        { id: "E_bad", name: "User", attributes: [] },
      ],
      functions: [
        { id: "F3", name: "Login", description: "Login" },
      ],
      constraints: [
        { id: "Cxxx", description: "Some constraint" },
      ],
      exceptions: [],
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
    // No items with id → passed (vacuously true per the code: itemsWithId.length === 0)
    expect(idCheck!.passed).toBe(true);
  });
});
