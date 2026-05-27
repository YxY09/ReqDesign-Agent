import { describe, it, expect } from "vitest";
import {
  assignCanonicalIds,
  fixCrossReferences,
  type IdMap,
} from "../src/shared/idAssigner.js";

// ---------------------------------------------------------------------------
// assignCanonicalIds
// ---------------------------------------------------------------------------
describe("assignCanonicalIds", () => {
  it("assigns E001 format IDs to entities sorted by name", () => {
    const merged = {
      entities: [
        { name: "Order", attributes: [] },
        { name: "Customer", attributes: [] },
      ],
      functions: [],
      constraints: [],
      exceptions: [],
    };
    const { result, idMap } = assignCanonicalIds(merged);

    const entities = result.entities as Array<Record<string, unknown>>;
    const sorted = [...entities].sort(
      (a, b) => String(a.name).localeCompare(String(b.name)),
    );
    expect(sorted[0].name).toBe("Customer");
    expect(sorted[0].id).toBe("E001");
    expect(sorted[1].name).toBe("Order");
    expect(sorted[1].id).toBe("E002");
  });

  it("assigns F001 format IDs to functions sorted by name", () => {
    const merged = {
      entities: [],
      functions: [
        { name: "DeleteOrder" },
        { name: "CreateOrder" },
      ],
      constraints: [],
      exceptions: [],
    };
    const { result, idMap } = assignCanonicalIds(merged);

    const functions = result.functions as Array<Record<string, unknown>>;
    const sorted = [...functions].sort(
      (a, b) => String(a.name).localeCompare(String(b.name)),
    );
    expect(sorted[0].id).toBe("F001");
    expect(sorted[1].id).toBe("F002");
  });

  it("assigns C001 format IDs to constraints sorted by id", () => {
    const merged = {
      entities: [],
      functions: [],
      constraints: [
        { id: "C005", description: "Fifth constraint here" },
        { id: "C001", description: "First constraint here" },
      ],
      exceptions: [],
    };
    const { result, idMap } = assignCanonicalIds(merged);

    const constraints = result.constraints as Array<Record<string, unknown>>;
    expect(constraints[0].id).toBe("C001");
    expect(constraints[1].id).toBe("C002");
  });

  it("assigns X001 format IDs to exceptions sorted by id", () => {
    const merged = {
      entities: [],
      functions: [],
      constraints: [],
      exceptions: [
        { id: "X010", description: "d", trigger: "t", handling: "h" },
        { id: "X002", description: "d", trigger: "t", handling: "h" },
      ],
    };
    const { result, idMap } = assignCanonicalIds(merged);

    const exceptions = result.exceptions as Array<Record<string, unknown>>;
    expect(exceptions[0].id).toBe("X001");
    expect(exceptions[1].id).toBe("X002");
  });

  it("maps old IDs and names to new canonical IDs", () => {
    const merged = {
      entities: [{ name: "User" }],
      functions: [{ name: "Login", id: "F_old" }],
      constraints: [{ id: "C_old", description: "Some constraint text" }],
      exceptions: [{ id: "X_old", description: "d", trigger: "t", handling: "h" }],
    };
    const { idMap } = assignCanonicalIds(merged);

    expect(idMap.entityMap.get("User")).toBe("E001");
    expect(idMap.functionMap.get("F_old")).toBe("F001");
    expect(idMap.functionMap.get("Login")).toBe("F001");
    expect(idMap.constraintMap.get("C_old")).toBe("C001");
    expect(idMap.exceptionMap.get("X_old")).toBe("X001");
  });

  it("returns a deep copy, not mutating original", () => {
    const merged = {
      entities: [{ name: "User" }],
      functions: [],
      constraints: [],
      exceptions: [],
    };
    const { result } = assignCanonicalIds(merged);

    const origEntities = merged.entities as Array<Record<string, unknown>>;
    expect(origEntities[0].id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fixCrossReferences
// ---------------------------------------------------------------------------
describe("fixCrossReferences", () => {
  it("fixes entity relationship targets using entity map", () => {
    const merged = {
      entities: [
        {
          name: "User",
          id: "E001",
          relationships: [{ target: "Order", type: "has_many" }],
        },
        { name: "Order", id: "E002", relationships: [] },
      ],
      functions: [],
      constraints: [],
      exceptions: [],
    };
    const idMap: IdMap = {
      entityMap: new Map([
        ["User", "E001"],
        ["Order", "E002"],
      ]),
      functionMap: new Map(),
      constraintMap: new Map(),
      exceptionMap: new Map(),
    };

    fixCrossReferences(merged, idMap);

    const user = (merged.entities as Array<Record<string, unknown>>)[0];
    const rels = user.relationships as Array<Record<string, unknown>>;
    expect(rels[0].target).toBe("E002");
  });

  it("fixes constraint related_functions using function map", () => {
    const merged = {
      entities: [],
      functions: [],
      constraints: [
        {
          id: "C001",
          related_functions: ["F_old_1", "F_old_2"],
        },
      ],
      exceptions: [],
    };
    const idMap: IdMap = {
      entityMap: new Map(),
      functionMap: new Map([
        ["F_old_1", "F001"],
        ["F_old_2", "F002"],
      ]),
      constraintMap: new Map(),
      exceptionMap: new Map(),
    };

    fixCrossReferences(merged, idMap);

    const c = (merged.constraints as Array<Record<string, unknown>>)[0];
    expect(c.related_functions).toEqual(["F001", "F002"]);
  });

  it("fixes constraint related_entities using entity map", () => {
    const merged = {
      entities: [],
      functions: [],
      constraints: [
        {
          id: "C001",
          related_entities: ["User", "Order"],
        },
      ],
      exceptions: [],
    };
    const idMap: IdMap = {
      entityMap: new Map([
        ["User", "E001"],
        ["Order", "E002"],
      ]),
      functionMap: new Map(),
      constraintMap: new Map(),
      exceptionMap: new Map(),
    };

    fixCrossReferences(merged, idMap);

    const c = (merged.constraints as Array<Record<string, unknown>>)[0];
    expect(c.related_entities).toEqual(["E001", "E002"]);
  });

  it("fixes exception related_constraints using constraint map", () => {
    const merged = {
      entities: [],
      functions: [],
      constraints: [],
      exceptions: [
        {
          id: "X001",
          related_constraints: ["C_old_1", "C_old_2"],
        },
      ],
    };
    const idMap: IdMap = {
      entityMap: new Map(),
      functionMap: new Map(),
      constraintMap: new Map([
        ["C_old_1", "C001"],
        ["C_old_2", "C002"],
      ]),
      exceptionMap: new Map(),
    };

    fixCrossReferences(merged, idMap);

    const ex = (merged.exceptions as Array<Record<string, unknown>>)[0];
    expect(ex.related_constraints).toEqual(["C001", "C002"]);
  });

  it("leaves unrecognized references unchanged", () => {
    const merged = {
      entities: [],
      functions: [],
      constraints: [
        {
          id: "C001",
          related_functions: ["UNKNOWN"],
          related_entities: ["MISSING"],
        },
      ],
      exceptions: [
        {
          id: "X001",
          related_constraints: ["NOPE"],
        },
      ],
    };
    const idMap: IdMap = {
      entityMap: new Map(),
      functionMap: new Map(),
      constraintMap: new Map(),
      exceptionMap: new Map(),
    };

    fixCrossReferences(merged, idMap);

    const c = (merged.constraints as Array<Record<string, unknown>>)[0];
    expect(c.related_functions).toEqual(["UNKNOWN"]);
    expect(c.related_entities).toEqual(["MISSING"]);

    const ex = (merged.exceptions as Array<Record<string, unknown>>)[0];
    expect(ex.related_constraints).toEqual(["NOPE"]);
  });
});
