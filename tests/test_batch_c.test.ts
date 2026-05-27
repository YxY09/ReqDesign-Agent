/**
 * Batch C tests: Lossless preMerge + analysis quality gate.
 *
 * Covers:
 *   1. preMerge lossless invariant: total items never decrease
 *   2. Entity merge: same-name union with longer description, attributes union
 *   3. Entity merge: Jaccard < 0.3 keeps both with suffix
 *   4. Function merge: same-name keeps longer desc, unions sub_capabilities
 *   5. Function merge: different name but similar desc keeps both
 *   6. Constraint merge: by description Jaccard >= 0.7 merges, otherwise keeps all
 *   7. Constraint merge: does NOT use ID dedup (the bug fix)
 *   8. Entity attribute cap at 20
 *   9. Relationship union by target+type
 *  10. Quality gate: all 8 deterministic checks
 *  11. Quality gate integration in merge result (__qualityGate)
 */

import { describe, it, expect } from "vitest";
import { AnalyzeMerger } from "../src/generators/merge.js";
import { checkAnalysisQuality, type QualityCheckResult } from "../src/shared/analysisQualityGate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake LLM that never gets called (preMerge is deterministic). */
const fakeLlm = {
  generateJson: async () => {
    throw new Error("LLM should not be called in preMerge tests");
  },
} as any;

/** Shorthand for an artifact. */
function artifact(content: Record<string, unknown>) {
  return { taskId: `task-${Math.random().toString(36).slice(2, 8)}`, content };
}

/** Count total items in an analysis result. */
function totalItems(result: Record<string, unknown>): number {
  const count = (key: string) =>
    Array.isArray(result[key]) ? (result[key] as unknown[]).length : 0;
  return (
    count("actors") +
    count("functions") +
    count("entities") +
    count("constraints") +
    count("exceptions")
  );
}

// ---------------------------------------------------------------------------
// 1. Lossless invariant: total items never decrease
// ---------------------------------------------------------------------------

describe("preMerge lossless invariant", () => {
  it("total items >= sum of any single artifact", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      actors: [{ name: "User" }],
      functions: [{ id: "F001", name: "Login", description: "User login" }],
      entities: [{ name: "User", attributes: [], relationships: [] }],
      constraints: [{ id: "C001", description: "Must be 18+" }],
      exceptions: [{ id: "X001", description: "Timeout" }],
    });
    const a2 = artifact({
      actors: [{ name: "Admin" }],
      functions: [{ id: "F001", name: "Login", description: "User authentication and login" }],
      entities: [{ name: "Order", attributes: [], relationships: [] }],
      constraints: [{ id: "C001", description: "Password 8+ chars" }],
      exceptions: [{ id: "X001", description: "Network error" }],
    });

    const merged = merger.preMerge([a1, a2]);
    const total = totalItems(merged);

    // Each artifact has 5 items. Merged should have >= 5
    expect(total).toBeGreaterThanOrEqual(5);
    // Specifically: entities should be 2 (User + Order), not 1
    expect((merged.entities as unknown[]).length).toBe(2);
  });

  it("preserves constraints with same ID from different artifacts", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    // The BUG: both start at C001, old dedup would only keep one
    const a1 = artifact({
      constraints: [
        { id: "C001", description: "User must be 18 years old to register" },
      ],
    });
    const a2 = artifact({
      constraints: [
        { id: "C001", description: "Password must be at least 8 characters long" },
      ],
    });
    const a3 = artifact({
      constraints: [
        { id: "C001", description: "System must respond within 3 seconds" },
      ],
    });

    const merged = merger.preMerge([a1, a2, a3]);

    // All 3 constraints should be preserved (different descriptions, same ID)
    expect((merged.constraints as unknown[]).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. Entity merge: same-name union with longer description, attributes union
// ---------------------------------------------------------------------------

describe("preMerge entity merging", () => {
  it("merges same-name entities: keeps longer description, unions attributes", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      entities: [
        {
          name: "User",
          description: "User account",
          attributes: [
            { name: "id", type: "Long", description: "ID" },
            { name: "name", type: "String", description: "Name" },
          ],
          relationships: [],
        },
      ],
    });
    const a2 = artifact({
      entities: [
        {
          name: "User",
          description: "User account entity representing registered users in the system",
          attributes: [
            { name: "id", type: "Long", description: "User ID" },
            { name: "email", type: "String", description: "Email address" },
          ],
          relationships: [],
        },
      ],
    });

    const merged = merger.preMerge([a1, a2]);
    const entities = merged.entities as Array<Record<string, unknown>>;
    const user = entities.find((e) => String(e.name) === "User");

    expect(user).toBeDefined();
    // Keeps longer description
    expect(String(user!.description)).toContain("representing registered users");
    // Attributes union: id, name, email (3 unique by name)
    const attrs = user!.attributes as Array<Record<string, unknown>>;
    const attrNames = attrs.map((a) => String(a.name));
    expect(attrNames).toContain("name");
    expect(attrNames).toContain("email");
    // For duplicate attribute name "id", keeps the longer description version
    const idAttr = attrs.find((a) => String(a.name) === "id");
    expect(idAttr).toBeDefined();
    expect(String(idAttr!.description)).toContain("User ID");
  });

  it("merges relationships by target+type union", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      entities: [
        {
          name: "Order",
          description: "Order",
          attributes: [],
          relationships: [
            { target: "User", type: "many-to-one", description: "belongs to user" },
          ],
        },
      ],
    });
    const a2 = artifact({
      entities: [
        {
          name: "Order",
          description: "Order entity",
          attributes: [],
          relationships: [
            { target: "User", type: "many-to-one", description: "belongs to user" },
            { target: "Product", type: "many-to-many", description: "contains products" },
          ],
        },
      ],
    });

    const merged = merger.preMerge([a1, a2]);
    const order = (merged.entities as Array<Record<string, unknown>>).find(
      (e) => String(e.name) === "Order",
    );
    const rels = order!.relationships as Array<Record<string, unknown>>;

    // Should have 2 relationships (User is deduped, Product is new)
    expect(rels.length).toBe(2);
    const targets = rels.map((r) => String(r.target));
    expect(targets).toContain("User");
    expect(targets).toContain("Product");
  });
});

// ---------------------------------------------------------------------------
// 3. Entity merge: Jaccard < 0.3 keeps both with suffix
// ---------------------------------------------------------------------------

describe("preMerge entity dissimilar handling", () => {
  it("keeps entities with Jaccard < 0.3 description similarity as separate (suffix)", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      entities: [
        {
          name: "Account",
          description: "Bank account with balance and transaction history",
          attributes: [],
          relationships: [],
        },
      ],
    });
    const a2 = artifact({
      entities: [
        {
          name: "Account",
          description: "User login credentials and authentication settings",
          attributes: [],
          relationships: [],
        },
      ],
    });

    const merged = merger.preMerge([a1, a2]);
    const entities = merged.entities as Array<Record<string, unknown>>;

    // Both should be kept (very dissimilar descriptions)
    expect(entities.length).toBe(2);
    // At least one should have a suffix to distinguish
    const names = entities.map((e) => String(e.name));
    const hasSuffix = names.some((n) => n !== "Account");
    expect(hasSuffix).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Function merge: same-name keeps longer desc, unions sub_capabilities
// ---------------------------------------------------------------------------

describe("preMerge function merging", () => {
  it("merges same-name functions: longer description, unions sub_capabilities and acceptance_criteria", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      functions: [
        {
          id: "F001",
          name: "Create Order",
          description: "Create order",
          sub_capabilities: ["validate items"],
          acceptance_criteria: ["order created"],
        },
      ],
    });
    const a2 = artifact({
      functions: [
        {
          id: "F001",
          name: "Create Order",
          description: "Create a new order with item validation and price calculation",
          sub_capabilities: ["calculate price"],
          acceptance_criteria: ["price calculated"],
        },
      ],
    });

    const merged = merger.preMerge([a1, a2]);
    const fns = merged.functions as Array<Record<string, unknown>>;
    const fn = fns.find((f) => String(f.name) === "Create Order");

    expect(fn).toBeDefined();
    expect(String(fn!.description)).toContain("price calculation");
    const subs = fn!.sub_capabilities as string[];
    expect(subs).toContain("validate items");
    expect(subs).toContain("calculate price");
    const criteria = fn!.acceptance_criteria as string[];
    expect(criteria).toContain("order created");
    expect(criteria).toContain("price calculated");
  });

  it("keeps different-name functions even with similar description", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      functions: [
        {
          id: "F001",
          name: "User Login",
          description: "Authenticate user credentials and create session token",
        },
      ],
    });
    const a2 = artifact({
      functions: [
        {
          id: "F002",
          name: "Admin Login",
          description: "Authenticate admin credentials and create admin session token",
        },
      ],
    });

    const merged = merger.preMerge([a1, a2]);
    const fns = merged.functions as Array<Record<string, unknown>>;

    // Both kept — different names, similar but not identical descriptions
    expect(fns.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Constraint merge: by description Jaccard >= 0.7 merges
// ---------------------------------------------------------------------------

describe("preMerge constraint merging", () => {
  it("merges constraints with Jaccard >= 0.7 description similarity", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      constraints: [
        { id: "C001", description: "The user must be at least eighteen years old to register an account" },
      ],
    });
    const a2 = artifact({
      constraints: [
        { id: "C002", description: "Users must be at least eighteen years of age to register for an account" },
      ],
    });

    const merged = merger.preMerge([a1, a2]);

    // Should merge into 1 (very similar descriptions)
    const constraints = merged.constraints as Array<Record<string, unknown>>;
    expect(constraints.length).toBe(1);
    // Keeps the more complete version
    const desc = String(constraints[0].description);
    expect(desc.length).toBeGreaterThan(0);
  });

  it("keeps constraints with Jaccard < 0.7 as separate", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      constraints: [
        { id: "C001", description: "Password must contain uppercase and lowercase letters" },
      ],
    });
    const a2 = artifact({
      constraints: [
        { id: "C002", description: "Orders exceeding 10000 yuan require manager approval" },
      ],
    });

    const merged = merger.preMerge([a1, a2]);
    expect((merged.constraints as unknown[]).length).toBe(2);
  });

  it("never loses constraints even when all have same ID", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const artifacts = [
      artifact({
        constraints: [
          { id: "C001", description: "Password must be at least 8 characters" },
          { id: "C002", description: "Session timeout after 30 minutes" },
        ],
      }),
      artifact({
        constraints: [
          { id: "C001", description: "Failed login attempts locked after 5 tries" },
          { id: "C002", description: "All API calls must be rate limited" },
        ],
      }),
    ];

    const merged = merger.preMerge(artifacts);

    // All 4 should be preserved (completely different descriptions)
    expect((merged.constraints as unknown[]).length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 6. Entity attribute cap at 20
// ---------------------------------------------------------------------------

describe("preMerge entity attribute cap", () => {
  it("caps entity attributes at 20 after merge", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const attrs = Array.from({ length: 15 }, (_, i) => ({
      name: `attr_a_${i}`,
      type: "String",
      description: `Attribute A${i}`,
    }));
    const attrs2 = Array.from({ length: 12 }, (_, i) => ({
      name: `attr_b_${i}`,
      type: "String",
      description: `Attribute B${i}`,
    }));

    const a1 = artifact({
      entities: [
        { name: "BigEntity", description: "entity", attributes: attrs, relationships: [] },
      ],
    });
    const a2 = artifact({
      entities: [
        { name: "BigEntity", description: "entity", attributes: attrs2, relationships: [] },
      ],
    });

    const merged = merger.preMerge([a1, a2]);
    const entity = (merged.entities as Array<Record<string, unknown>>)[0];
    const mergedAttrs = entity.attributes as Array<Record<string, unknown>>;

    expect(mergedAttrs.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// 7. Exception merge: same as constraints (description-based)
// ---------------------------------------------------------------------------

describe("preMerge exception merging", () => {
  it("merges exceptions with similar descriptions", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      exceptions: [
        { id: "X001", description: "Network connection timeout when server is unreachable" },
      ],
    });
    const a2 = artifact({
      exceptions: [
        { id: "X002", description: "Network connection timeout when the server becomes unreachable" },
      ],
    });

    const merged = merger.preMerge([a1, a2]);
    expect((merged.exceptions as unknown[]).length).toBe(1);
  });

  it("keeps different exceptions", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      exceptions: [
        { id: "X001", description: "Payment gateway rejection" },
      ],
    });
    const a2 = artifact({
      exceptions: [
        { id: "X002", description: "Database connection failure" },
      ],
    });

    const merged = merger.preMerge([a1, a2]);
    expect((merged.exceptions as unknown[]).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 8. Quality gate: deterministic checks
// ---------------------------------------------------------------------------

describe("checkAnalysisQuality", () => {
  /** Valid analysis that should pass all checks. */
  const validAnalysis = {
    actors: [{ name: "User" }],
    functions: [
      {
        id: "F001",
        name: "Login",
        description: "User authentication and login",
        sub_capabilities: [],
        acceptance_criteria: [],
      },
    ],
    entities: [
      {
        id: "E001",
        name: "User",
        description: "User account",
        attributes: [
          { name: "id", type: "Long", description: "User ID" },
        ],
        relationships: [{ target: "User", type: "one-to-one", description: "self" }],
      },
    ],
    constraints: [
      {
        id: "C001",
        description: "Must be 18+",
        source_text: "users must be at least 18 years old",
      },
    ],
    exceptions: [],
  };

  it("passes with valid analysis", () => {
    const result = checkAnalysisQuality(validAnalysis, "users must be at least 18 years old");
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.7);
  });

  it("fails when actors is empty", () => {
    const analysis = { ...validAnalysis, actors: [] };
    const result = checkAnalysisQuality(analysis);
    const check = result.checks.find((c) => c.name === "required_fields_non_empty");
    expect(check!.passed).toBe(false);
  });

  it("fails entity coverage when < 80% entities have attributes", () => {
    const analysis = {
      ...validAnalysis,
      entities: [
        { name: "User", attributes: [{ name: "id", type: "Long", description: "ID" }], relationships: [] },
        { name: "Order", attributes: [], relationships: [] },
        { name: "Product", attributes: [], relationships: [] },
        { name: "Cart", attributes: [], relationships: [] },
        { name: "Payment", attributes: [], relationships: [] },
      ],
    };
    const result = checkAnalysisQuality(analysis);
    const check = result.checks.find((c) => c.name === "entity_attribute_coverage");
    expect(check!.passed).toBe(false);
  });

  it("fails function coverage when < 80% functions have description", () => {
    const analysis = {
      ...validAnalysis,
      functions: [
        { id: "F001", name: "Login", description: "User login" },
        { id: "F002", name: "Logout" }, // no description
        { id: "F003", name: "Register" }, // no description
      ],
    };
    const result = checkAnalysisQuality(analysis);
    const check = result.checks.find((c) => c.name === "function_description_coverage");
    expect(check!.passed).toBe(false);
  });

  it("fails when constraints and exceptions are both empty", () => {
    const analysis = { ...validAnalysis, constraints: [], exceptions: [] };
    const result = checkAnalysisQuality(analysis);
    const check = result.checks.find((c) => c.name === "constraints_non_empty");
    expect(check!.passed).toBe(false);
  });

  it("fails ID format check for bad IDs", () => {
    const analysis = {
      ...validAnalysis,
      entities: [{ name: "X", id: "BAD_ID", attributes: [], relationships: [] }],
    };
    const result = checkAnalysisQuality(analysis);
    const check = result.checks.find((c) => c.name === "id_format");
    expect(check!.passed).toBe(false);
  });

  it("fails cross-reference integrity when relationship target missing", () => {
    const analysis = {
      ...validAnalysis,
      entities: [
        {
          name: "Order",
          attributes: [{ name: "id", type: "Long", description: "ID" }],
          relationships: [{ target: "NonExistentEntity", type: "many-to-one", description: "ref" }],
        },
      ],
    };
    const result = checkAnalysisQuality(analysis);
    const check = result.checks.find((c) => c.name === "cross_reference_integrity");
    expect(check!.passed).toBe(false);
  });

  it("fails source_ref coverage when < 30% constraints have source_text", () => {
    const analysis = {
      ...validAnalysis,
      constraints: [
        { id: "C001", description: "Must be 18+" },
        { id: "C002", description: "Must be 21+" },
        { id: "C003", description: "Must be 25+" },
        { id: "C004", description: "Must be 30+" },
      ],
    };
    const result = checkAnalysisQuality(analysis, "some source text");
    const check = result.checks.find((c) => c.name === "source_ref_coverage");
    expect(check!.passed).toBe(false);
  });

  it("passes source_ref coverage check when no sourceText provided", () => {
    const result = checkAnalysisQuality(validAnalysis);
    const check = result.checks.find((c) => c.name === "source_ref_coverage");
    // When no source text is available, this check should pass (can't enforce)
    expect(check!.passed).toBe(true);
  });

  it("detects unverified constraints (source_text not in source)", () => {
    const analysis = {
      ...validAnalysis,
      constraints: [
        {
          id: "C001",
          description: "Must be 18+",
          source_text: "users must be at least 18 years old",
        },
        {
          id: "C002",
          description: "Password 12 chars",
          source_text: "this text does not exist anywhere in the source document",
        },
      ],
    };
    const result = checkAnalysisQuality(analysis, "users must be at least 18 years old");
    const check = result.checks.find((c) => c.name === "no_unverified_constraints");
    expect(check!.passed).toBe(false);
  });

  it("score calculation is correct", () => {
    const result = checkAnalysisQuality(validAnalysis, "users must be at least 18 years old");
    const passedCount = result.checks.filter((c) => c.passed).length;
    const totalCount = result.checks.length;
    expect(result.score).toBeCloseTo(passedCount / totalCount);
  });
});

// ---------------------------------------------------------------------------
// 9. _dedupFunctionsByDescription removed
// ---------------------------------------------------------------------------

describe("_dedupFunctionsByDescription removed", () => {
  it("static method _dedupFunctionsByDescription no longer exists", () => {
    // The method should have been removed from the class
    expect(
      (AnalyzeMerger as any)._dedupFunctionsByDescription,
    ).toBeUndefined();
  });
});
