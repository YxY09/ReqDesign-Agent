import { describe, it, expect } from "vitest";
import { canonicalizeAndLink } from "../src/shared/canonicalizer.js";

describe("canonicalizeAndLink", () => {
  // ----------------------------------------------------------------
  // 1. Functions canonicalization
  // ----------------------------------------------------------------
  it("assigns FUN_UPPER_SNAKE canonicalId and F001 displayId to functions sorted by name", () => {
    const merged: Record<string, unknown> = {
      functions: [
        { id: "temp_2", name: "SearchCase", description: "Search for cases" },
        { id: "temp_1", name: "RegisterComplaint", description: "Register a complaint" },
      ],
    };

    const maps = canonicalizeAndLink(merged);

    // Sorted by name: RegisterComplaint < SearchCase
    const fns = merged.functions as Array<Record<string, unknown>>;
    expect(fns[0].id).toBe("FUN_REGISTER_COMPLAINT");
    expect(fns[0].displayId).toBe("F001");
    expect(fns[1].id).toBe("FUN_SEARCH_CASE");
    expect(fns[1].displayId).toBe("F002");

    // Maps should have oldId → canonicalId and name → canonicalId
    expect(maps.functionMap.get("temp_1")).toBe("FUN_REGISTER_COMPLAINT");
    expect(maps.functionMap.get("temp_2")).toBe("FUN_SEARCH_CASE");
    expect(maps.functionMap.get("SearchCase")).toBe("FUN_SEARCH_CASE");
    expect(maps.functionMap.get("RegisterComplaint")).toBe("FUN_REGISTER_COMPLAINT");
  });

  // ----------------------------------------------------------------
  // 2. Constraints canonicalization
  // ----------------------------------------------------------------
  it("assigns CON_ prefixed canonicalId and C001 displayId to constraints", () => {
    const merged: Record<string, unknown> = {
      constraints: [
        { id: "c_old_1", description: "Audit trail data cannot be modified or deleted" },
        { id: "c_old_2", description: "Search response time should be under 8 seconds" },
      ],
    };

    const maps = canonicalizeAndLink(merged);

    const constraints = merged.constraints as Array<Record<string, unknown>>;
    // Sorted alphabetically by description
    expect(constraints.length).toBe(2);
    expect(constraints[0].id).toMatch(/^CON_/);
    expect(constraints[0].displayId).toBe("C001");
    expect(constraints[1].id).toMatch(/^CON_/);
    expect(constraints[1].displayId).toBe("C002");

    expect(maps.constraintMap.get("c_old_1")).toBe(constraints[0].id);
    expect(maps.constraintMap.get("c_old_2")).toBe(constraints[1].id);
  });

  // ----------------------------------------------------------------
  // 3. Exceptions canonicalization
  // ----------------------------------------------------------------
  it("assigns EXC_ prefixed canonicalId and X001 displayId to exceptions", () => {
    const merged: Record<string, unknown> = {
      exceptions: [
        { id: "x_old_1", description: "Case not found in database" },
        { id: "x_old_2", description: "Database connection timeout" },
      ],
    };

    const maps = canonicalizeAndLink(merged);

    const exceptions = merged.exceptions as Array<Record<string, unknown>>;
    expect(exceptions.length).toBe(2);
    expect(exceptions[0].id).toMatch(/^EXC_/);
    expect(exceptions[0].displayId).toBe("X001");
    expect(exceptions[1].id).toMatch(/^EXC_/);
    expect(exceptions[1].displayId).toBe("X002");

    expect(maps.exceptionMap.get("x_old_1")).toBe(exceptions[0].id);
    expect(maps.exceptionMap.get("x_old_2")).toBe(exceptions[1].id);
  });

  // ----------------------------------------------------------------
  // 4. Reference resolution: constraint.related_functions
  // ----------------------------------------------------------------
  it("resolves constraint related_functions from old IDs to canonical IDs", () => {
    const merged: Record<string, unknown> = {
      functions: [
        { id: "old_fn", name: "SearchCase", description: "Search" },
      ],
      constraints: [
        {
          id: "old_con",
          description: "Must be fast",
          related_functions: ["old_fn"],
        },
      ],
    };

    canonicalizeAndLink(merged);

    const constraints = merged.constraints as Array<Record<string, unknown>>;
    const relatedFns = constraints[0].related_functions as string[];
    expect(relatedFns[0]).toBe("FUN_SEARCH_CASE");
  });

  // ----------------------------------------------------------------
  // 5. Reference resolution: exception.related_functions and related_constraints
  // ----------------------------------------------------------------
  it("resolves exception related_functions and related_constraints", () => {
    const merged: Record<string, unknown> = {
      functions: [
        { id: "fn_a", name: "SearchCase", description: "Search" },
      ],
      constraints: [
        { id: "con_a", description: "Must be fast" },
      ],
      exceptions: [
        {
          id: "exc_a",
          description: "Timeout error",
          related_functions: ["fn_a"],
          related_constraints: ["con_a"],
        },
      ],
    };

    canonicalizeAndLink(merged);

    const exceptions = merged.exceptions as Array<Record<string, unknown>>;
    const exc = exceptions[0];
    expect((exc.related_functions as string[])[0]).toBe("FUN_SEARCH_CASE");
    // con_a's canonicalId will be CON_ + hash of "Must be fast"
    const resolvedCon = (exc.related_constraints as string[])[0];
    expect(resolvedCon).toMatch(/^CON_/);
  });

  // ----------------------------------------------------------------
  // 6. Reference resolution: NFR related_constraints
  // ----------------------------------------------------------------
  it("resolves NFR related_constraints from old IDs to canonical IDs", () => {
    const merged: Record<string, unknown> = {
      constraints: [
        { id: "c1", description: "Response time under 5 seconds" },
      ],
      non_functional_requirements: [
        {
          category: "Performance",
          related_constraints: ["c1"],
        },
      ],
    };

    canonicalizeAndLink(merged);

    const nfrs = merged.non_functional_requirements as Array<Record<string, unknown>>;
    const related = nfrs[0].related_constraints as string[];
    expect(related[0]).toMatch(/^CON_/);
  });

  // ----------------------------------------------------------------
  // 7. Empty / missing arrays
  // ----------------------------------------------------------------
  it("handles empty merged object gracefully", () => {
    const merged: Record<string, unknown> = {};

    const maps = canonicalizeAndLink(merged);

    expect(maps.functionMap.size).toBe(0);
    expect(maps.constraintMap.size).toBe(0);
    expect(maps.exceptionMap.size).toBe(0);
  });

  // ----------------------------------------------------------------
  // 8. Chinese text constraint IDs use hash
  // ----------------------------------------------------------------
  it("generates hash-based canonicalId for Chinese text constraints", () => {
    const merged: Record<string, unknown> = {
      constraints: [
        { id: "c1", description: "审计跟踪数据不可修改或删除" },
      ],
    };

    canonicalizeAndLink(merged);

    const constraints = merged.constraints as Array<Record<string, unknown>>;
    expect(constraints[0].id).toMatch(/^CON_[A-Z0-9]{8}$/);
  });

  // ----------------------------------------------------------------
  // 9. Unresolved references kept as-is
  // ----------------------------------------------------------------
  it("keeps unresolved references unchanged", () => {
    const merged: Record<string, unknown> = {
      constraints: [
        {
          id: "c1",
          description: "Some constraint",
          related_functions: ["nonexistent_fn"],
        },
      ],
    };

    canonicalizeAndLink(merged);

    const constraints = merged.constraints as Array<Record<string, unknown>>;
    expect((constraints[0].related_functions as string[])[0]).toBe("nonexistent_fn");
  });

  // ----------------------------------------------------------------
  // 10. Deterministic: same input produces same output
  // ----------------------------------------------------------------
  it("produces deterministic canonicalIds for same input", () => {
    const makeInput = () => ({
      functions: [
        { id: "a", name: "CreateUser", description: "Create a user" },
        { id: "b", name: "DeleteUser", description: "Delete a user" },
      ],
      constraints: [
        { id: "c1", description: "Users must have unique emails" },
      ],
    });

    const merged1: Record<string, unknown> = makeInput();
    const merged2: Record<string, unknown> = makeInput();

    const maps1 = canonicalizeAndLink(merged1);
    const maps2 = canonicalizeAndLink(merged2);

    const fns1 = merged1.functions as Array<Record<string, unknown>>;
    const fns2 = merged2.functions as Array<Record<string, unknown>>;

    expect(fns1[0].id).toBe(fns2[0].id);
    expect(fns1[1].id).toBe(fns2[1].id);
    expect(maps1.functionMap).toEqual(maps2.functionMap);
    expect(maps1.constraintMap).toEqual(maps2.constraintMap);
  });
});
