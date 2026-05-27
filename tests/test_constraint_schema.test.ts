import { describe, it, expect } from "vitest";
import {
  type ConstraintCategory,
  type ConstraintSeverity,
  validateConstraint,
  validateException,
  normalizeConstraint,
  validateConstraintList,
  validateExceptionList,
  validateConstraintAnalysisResult,
} from "../src/shared/constraintSchema.js";

// ---------------------------------------------------------------------------
// validateConstraint
// ---------------------------------------------------------------------------
describe("validateConstraint", () => {
  it("rejects constraint without id", () => {
    const result = validateConstraint({ description: "some constraint text" });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("id")]),
    );
  });

  it("rejects constraint with description shorter than 5 chars", () => {
    const result = validateConstraint({ id: "C001", description: "abc" });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("description")]),
    );
  });

  it("rejects invalid category", () => {
    const result = validateConstraint({
      id: "C001",
      description: "a valid description",
      category: "invalid_category",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("category")]),
    );
  });

  it("rejects invalid severity", () => {
    const result = validateConstraint({
      id: "C001",
      description: "a valid description",
      severity: "critical",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("severity")]),
    );
  });

  it("accepts valid constraint", () => {
    const result = validateConstraint({
      id: "C001",
      description: "All data must be validated",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts constraint with all fields", () => {
    const result = validateConstraint({
      id: "C002",
      description: "Access control constraint",
      category: "access_control",
      severity: "high",
      related_functions: ["F001"],
      related_entities: ["User"],
    });
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateException
// ---------------------------------------------------------------------------
describe("validateException", () => {
  it("rejects exception without id", () => {
    const result = validateException({
      description: "some exception",
      trigger: "when X happens",
      handling: "do Y",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("id")]),
    );
  });

  it("rejects exception without description", () => {
    const result = validateException({
      id: "X001",
      trigger: "when X happens",
      handling: "do Y",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("description")]),
    );
  });

  it("rejects exception without trigger", () => {
    const result = validateException({
      id: "X001",
      description: "some exception",
      handling: "do Y",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("trigger")]),
    );
  });

  it("rejects exception without handling", () => {
    const result = validateException({
      id: "X001",
      description: "some exception",
      trigger: "when X happens",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("handling")]),
    );
  });

  it("accepts valid exception", () => {
    const result = validateException({
      id: "X001",
      description: "Payment timeout exception",
      trigger: "payment gateway timeout",
      handling: "Retry 3 times then notify user",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeConstraint
// ---------------------------------------------------------------------------
describe("normalizeConstraint", () => {
  it("fills default category and severity", () => {
    const c = normalizeConstraint({
      id: "C001",
      description: "Some constraint text",
    });
    expect(c.category).toBe("business_rule");
    expect(c.severity).toBe("medium");
  });

  it("preserves existing category and severity", () => {
    const c = normalizeConstraint({
      id: "C002",
      description: "Some constraint text",
      category: "access_control",
      severity: "high",
    });
    expect(c.category).toBe("access_control");
    expect(c.severity).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// validateConstraintList / validateExceptionList
// ---------------------------------------------------------------------------
describe("validateConstraintList", () => {
  it("returns errors for each invalid item", () => {
    const constraints = [
      { id: "C001", description: "abc" }, // too short
      { description: "valid description" }, // no id
    ];
    const result = validateConstraintList(constraints);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
  });

  it("passes for all valid constraints", () => {
    const constraints = [
      { id: "C001", description: "First constraint text" },
      { id: "C002", description: "Second constraint text" },
    ];
    const result = validateConstraintList(constraints);
    expect(result.valid).toBe(true);
  });
});

describe("validateExceptionList", () => {
  it("returns errors for each invalid item", () => {
    const exceptions = [
      { id: "X001" }, // missing description, trigger, handling
      { id: "X002", description: "valid desc", trigger: "t", handling: "h" },
    ];
    const result = validateExceptionList(exceptions);
    expect(result.valid).toBe(false);
  });

  it("passes for all valid exceptions", () => {
    const exceptions = [
      { id: "X001", description: "desc", trigger: "t", handling: "h" },
    ];
    const result = validateExceptionList(exceptions);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateConstraintAnalysisResult
// ---------------------------------------------------------------------------
describe("validateConstraintAnalysisResult", () => {
  it("rejects when both constraints and exceptions are empty", () => {
    const result = validateConstraintAnalysisResult({
      constraints: [],
      exceptions: [],
      actors: [],
      entities: [],
      functions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("constraints")]),
    );
  });

  it("accepts when constraints is non-empty even with empty exceptions", () => {
    const result = validateConstraintAnalysisResult({
      constraints: [{ id: "C001", description: "Must enforce rules" }],
      exceptions: [],
      actors: [],
      entities: [],
      functions: [],
    });
    expect(result.valid).toBe(true);
  });

  it("accepts when exceptions is non-empty even with empty constraints", () => {
    const result = validateConstraintAnalysisResult({
      constraints: [],
      exceptions: [
        { id: "X001", description: "d", trigger: "t", handling: "h" },
      ],
      actors: [],
      entities: [],
      functions: [],
    });
    expect(result.valid).toBe(true);
  });

  it("accepts when actors/entities/functions are missing", () => {
    const result = validateConstraintAnalysisResult({
      constraints: [{ id: "C001", description: "Must enforce rules" }],
      exceptions: [],
    });
    expect(result.valid).toBe(true);
  });

  it("validates individual constraints in the result", () => {
    const result = validateConstraintAnalysisResult({
      constraints: [{ description: "bad" }], // no id, short desc
      exceptions: [],
    });
    expect(result.valid).toBe(false);
  });
});
