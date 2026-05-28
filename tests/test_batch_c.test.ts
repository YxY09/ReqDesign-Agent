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

  it("keeps ALL entities when group.length > 2 and first two are dissimilar (bug fix)", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    // Three artifacts, each with an entity named "Account" but mutually dissimilar descriptions
    const a1 = artifact({
      entities: [
        {
          name: "Account",
          description: "Bank account with balance and transaction history",
          attributes: [{ name: "balance", type: "Decimal", description: "Current balance" }],
          relationships: [],
        },
      ],
    });
    const a2 = artifact({
      entities: [
        {
          name: "Account",
          description: "User login credentials and authentication settings",
          attributes: [{ name: "password", type: "String", description: "Hashed password" }],
          relationships: [],
        },
      ],
    });
    const a3 = artifact({
      entities: [
        {
          name: "Account",
          description: "Cloud subscription billing and usage tracking",
          attributes: [{ name: "plan", type: "String", description: "Subscription plan" }],
          relationships: [],
        },
      ],
    });

    const merged = merger.preMerge([a1, a2, a3]);
    const entities = merged.entities as Array<Record<string, unknown>>;

    // BUG: previously only 2 were kept (group[0] and group[1]); group[2] was dropped
    // Fix: ALL 3 must be kept with suffixed names
    expect(entities.length).toBe(3);
    // All should have the base name "Account" (possibly with suffix)
    const names = entities.map((e) => String(e.name));
    for (const name of names) {
      expect(name).toMatch(/^Account/);
    }
    // At least some should have suffixes to disambiguate
    const suffixCount = names.filter((n) => n !== "Account").length;
    expect(suffixCount).toBeGreaterThanOrEqual(2);
    // Verify each entity's attributes are preserved (not merged)
    const allAttrs = entities.map(
      (e) => (e.attributes as Array<Record<string, unknown>>).map((a) => String(a.name)),
    );
    // Since they are kept separate, each should have only its own attributes
    const attrFlat = allAttrs.flat();
    expect(attrFlat).toContain("balance");
    expect(attrFlat).toContain("password");
    expect(attrFlat).toContain("plan");
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
  it("keeps constraints separate without source_text (no Jaccard)", () => {
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

    // Without constraintRef or source_text, each is a separate item
    const constraints = merged.constraints as Array<Record<string, unknown>>;
    expect(constraints.length).toBe(2);
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

  it("dedupes cross-language constraints with same source_text", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      constraints: [
        { id: "C001", description: "搜索响应时间", source_text: "Search response time must be under 2 seconds" },
      ],
    });
    const a2 = artifact({
      constraints: [
        { id: "C002", description: "search response time", source_text: "Search response time must be under 2 seconds" },
      ],
    });

    const merged = merger.preMerge([a1, a2]);

    const constraints = merged.constraints as Array<Record<string, unknown>>;
    // Should dedupe into 1 because source_text is identical
    expect(constraints.length).toBe(1);
    // Should keep the more complete description (longer one)
    const desc = String(constraints[0].description);
    expect(desc.length).toBeGreaterThan(0);
  });

  it("keeps constraints separate when source_text differs", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      constraints: [
        { id: "C001", description: "搜索响应时间", source_text: "Search response time must be under 2 seconds" },
      ],
    });
    const a2 = artifact({
      constraints: [
        { id: "C002", description: "订单审批流程", source_text: "Order approval workflow requires manager sign-off" },
      ],
    });

    const merged = merger.preMerge([a1, a2]);
    expect((merged.constraints as unknown[]).length).toBe(2);
  });

  it("keeps N-way constraints separate without source_text (no transitive Jaccard)", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    // Without constraintRef or source_text, no merging occurs
    const a1 = artifact({
      constraints: [
        { id: "C001", description: "User password must contain uppercase letters and lowercase letters" },
      ],
    });
    const a2 = artifact({
      constraints: [
        { id: "C002", description: "User password must contain uppercase letters and numbers for security" },
      ],
    });
    const a3 = artifact({
      constraints: [
        { id: "C003", description: "User password must contain uppercase letters and lowercase letters for security" },
      ],
    });

    const merged = merger.preMerge([a1, a2, a3]);
    const constraints = merged.constraints as Array<Record<string, unknown>>;

    // All 3 kept separate without constraintRef or source_text
    expect(constraints.length).toBe(3);
  });

  it("merges only by source_text (no Jaccard transitive closure)", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    // E1 vs E2: same source_text → match
    // E2 vs E3: no constraintRef/source_text → no match
    // E1 vs E3: no constraintRef/source_text → no match
    // Result: E1+E2 merged, E3 separate → 2 total
    const a1 = artifact({
      constraints: [
        { id: "C001", description: "安全属性只能超管修改", source_text: "Only super admin can modify security attributes" },
      ],
    });
    const a2 = artifact({
      constraints: [
        { id: "C002", description: "Only super administrators may change security properties and permissions", source_text: "Only super admin can modify security attributes" },
      ],
    });
    const a3 = artifact({
      constraints: [
        { id: "C003", description: "Super administrators are the only users allowed to change security properties and permissions" },
      ],
    });

    const merged = merger.preMerge([a1, a2, a3]);
    const constraints = merged.constraints as Array<Record<string, unknown>>;

    // C1+C2 merge by source_text, C3 stays separate
    expect(constraints.length).toBe(2);
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
  it("keeps exceptions separate without source_text (no Jaccard)", () => {
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
    // Without exceptionRef or source_text, each is separate
    expect((merged.exceptions as unknown[]).length).toBe(2);
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

  it("dedupes cross-language exceptions with same source_text (BUG-10)", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      exceptions: [
        { id: "X005", description: "AuditExportFailure: system fails to export audit data", source_text: "审计数据导出失败时系统应记录日志" },
      ],
    });
    const a2 = artifact({
      exceptions: [
        { id: "X008", description: "审计导出失败时记录日志并通知管理员", source_text: "审计数据导出失败时系统应记录日志" },
      ],
    });

    const merged = merger.preMerge([a1, a2]);
    const exceptions = merged.exceptions as Array<Record<string, unknown>>;

    // Same source_text → should merge into 1
    expect(exceptions.length).toBe(1);
    // Should keep the longer description
    const desc = String(exceptions[0].description);
    expect(desc.length).toBeGreaterThan(0);
  });

  it("merges N-way cross-language exceptions via transitive source_text (BUG-10)", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    // 3 exceptions from 3 artifacts, all same source_text but different language descriptions
    const a1 = artifact({
      exceptions: [
        { id: "X005", description: "AuditExportFailure", source_text: "审计数据导出失败时系统应记录日志" },
      ],
    });
    const a2 = artifact({
      exceptions: [
        { id: "X006", description: "Database connection timeout", source_text: "高峰期数据库连接超时" },
      ],
    });
    const a3 = artifact({
      exceptions: [
        { id: "X008", description: "审计导出失败时系统应记录完整日志并通知相关管理员", source_text: "审计数据导出失败时系统应记录日志" },
      ],
    });

    const merged = merger.preMerge([a1, a2, a3]);
    const exceptions = merged.exceptions as Array<Record<string, unknown>>;

    // X005 and X008 have same source_text → merge. X006 is different → keep.
    expect(exceptions.length).toBe(2);
    // The merged one should have the longest description
    const descs = exceptions.map((e) => String(e.description ?? ""));
    const hasLongDesc = descs.some((d) => d.includes("管理员"));
    expect(hasLongDesc).toBe(true);
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

  it("passes cross-reference integrity when relationship targets are canonical IDs", () => {
    // Relationship targets that are canonical IDs (E001, E002) should NOT be flagged as broken.
    // After the 大简化 refactor, entity IDs are Registry IDs directly.
    const analysis = {
      ...validAnalysis,
      entities: [
        {
          id: "E001",
          name: "Order",
          attributes: [{ name: "id", type: "Long", description: "ID" }],
          relationships: [{ target: "E002", type: "many-to-one", description: "ref to Customer" }],
        },
        {
          id: "E002",
          name: "Customer",
          attributes: [{ name: "id", type: "Long", description: "ID" }],
          relationships: [],
        },
      ],
    };
    const result = checkAnalysisQuality(analysis);
    const check = result.checks.find((c) => c.name === "cross_reference_integrity");
    expect(check!.passed).toBe(true);
  });

  it("passes cross-reference integrity when relationship targets match entityRef (production shape)", () => {
    // Production entities use entityRef, not id. The quality gate must also
    // match relationship targets against entityRef values.
    const analysis = {
      ...validAnalysis,
      entities: [
        {
          entityRef: "E_CASE",
          name: "Case",
          attributes: [{ name: "id", type: "Long", description: "ID" }],
          relationships: [{ target: "E_DOCUMENT", type: "one-to-many", description: "contains documents" }],
        },
        {
          entityRef: "E_DOCUMENT",
          name: "Document",
          attributes: [{ name: "id", type: "Long", description: "ID" }],
          relationships: [],
        },
      ],
    };
    const result = checkAnalysisQuality(analysis);
    const check = result.checks.find((c) => c.name === "cross_reference_integrity");
    expect(check!.passed).toBe(true);
  });

  it("fails cross-reference integrity when entityRef target does not exist", () => {
    const analysis = {
      ...validAnalysis,
      entities: [
        {
          entityRef: "E_CASE",
          name: "Case",
          attributes: [{ name: "id", type: "Long", description: "ID" }],
          relationships: [{ target: "E_MISSING", type: "one-to-many", description: "broken ref" }],
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

  it("passes unverified constraints check when source_text has unicode curly quotes", () => {
    const analysis = {
      ...validAnalysis,
      constraints: [
        {
          id: "C001",
          description: "Search constraint",
          source_text: "\u201Csearch results\u201D for the user\u2019s password",
        },
      ],
    };
    const result = checkAnalysisQuality(analysis, 'the system must "search results" for the user\'s password');
    const check = result.checks.find((c) => c.name === "no_unverified_constraints");
    expect(check!.passed).toBe(true);
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

// ---------------------------------------------------------------------------
// Actor merge: actorRef-based + name fallback
// ---------------------------------------------------------------------------

describe("preMerge actor merging", () => {
  it("merges actors with identical name (case-insensitive)", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      actors: [{ name: "Police", description: "Law enforcement officer" }],
    });
    const a2 = artifact({
      actors: [{ name: "police", description: "Law enforcement agency responsible for maintaining public order" }],
    });
    const merged = merger.preMerge([a1, a2]);
    const actors = merged.actors as Array<Record<string, unknown>>;
    expect(actors).toHaveLength(1);
    // Should keep the longer description
    expect(String(actors[0].description)).toContain("maintaining public order");
  });

  it("keeps actors with different names separate even if words overlap", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      actors: [{ name: "Police", description: "Law enforcement officer" }],
    });
    const a2 = artifact({
      actors: [{ name: "Police Personnel", description: "Law enforcement agency staff responsible for public safety and order" }],
    });
    const merged = merger.preMerge([a1, a2]);
    const actors = merged.actors as Array<Record<string, unknown>>;
    // "Police" and "Police Personnel" are different names — should stay separate
    expect(actors).toHaveLength(2);
  });

  it("keeps actors separate when names differ (no substring merging)", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      actors: [{ name: "Admin", description: "System administrator" }],
    });
    const a2 = artifact({
      actors: [{ name: "System Admin User", description: "Administrator with full system access and configuration privileges" }],
    });
    const merged = merger.preMerge([a1, a2]);
    const actors = merged.actors as Array<Record<string, unknown>>;
    // Different names — should stay separate without Jaccard
    expect(actors).toHaveLength(2);
  });

  it("keeps both actors when names are dissimilar", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      actors: [{ name: "Customer", description: "End user who purchases products" }],
    });
    const a2 = artifact({
      actors: [{ name: "Warehouse Manager", description: "Manages inventory and logistics" }],
    });
    const merged = merger.preMerge([a1, a2]);
    const actors = merged.actors as Array<Record<string, unknown>>;
    // Completely different names — should keep both
    expect(actors).toHaveLength(2);
  });

  it("keeps longer description when merging same-name actors (case-insensitive)", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const shortDesc = "Police officer";
    const longDesc = "Police personnel responsible for law enforcement, crime prevention, and public safety operations across all jurisdictions";
    const a1 = artifact({
      actors: [{ name: "Police", description: shortDesc }],
    });
    const a2 = artifact({
      actors: [{ name: "POLICE", description: longDesc }],
    });
    const merged = merger.preMerge([a1, a2]);
    const actors = merged.actors as Array<Record<string, unknown>>;
    expect(actors).toHaveLength(1);
    expect(String(actors[0].description)).toBe(longDesc);
  });
});

// ---------------------------------------------------------------------------
// NFR category dedup: Chinese ↔ English normalization
// ---------------------------------------------------------------------------

describe("preMerge NFR dedup: Chinese/English category normalization", () => {
  it("deduplicates NFRs with equivalent Chinese and English categories", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      non_functional_requirements: [
        { category: "性能", description: "Response time under 200ms", metric: "latency" },
      ],
    });
    const a2 = artifact({
      non_functional_requirements: [
        { category: "performance", description: "System must be fast", metric: "throughput" },
      ],
    });
    const merged = merger.preMerge([a1, a2]);
    const nfrs = merged.non_functional_requirements as Array<Record<string, unknown>>;
    // Both NFRs refer to the same category (性能 = performance) — should keep only one
    expect(nfrs).toHaveLength(1);
  });

  it("keeps NFRs with genuinely different categories", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      non_functional_requirements: [
        { category: "性能", description: "Response time under 200ms" },
      ],
    });
    const a2 = artifact({
      non_functional_requirements: [
        { category: "安全", description: "All data encrypted at rest" },
      ],
    });
    const merged = merger.preMerge([a1, a2]);
    const nfrs = merged.non_functional_requirements as Array<Record<string, unknown>>;
    // 性能 and 安全 are different categories — should keep both
    expect(nfrs).toHaveLength(2);
  });

  it("deduplicates all known Chinese NFR category mappings", () => {
    const merger = new AnalyzeMerger(fakeLlm);
    // All mapped Chinese categories paired with their English equivalents
    const a1 = artifact({
      non_functional_requirements: [
        { category: "性能" },
        { category: "安全" },
        { category: "可用性" },
        { category: "可扩展性" },
        { category: "可维护性" },
        { category: "可靠性" },
        { category: "易用性" },
        { category: "兼容性" },
      ],
    });
    const a2 = artifact({
      non_functional_requirements: [
        { category: "performance" },
        { category: "security" },
        { category: "availability" },
        { category: "scalability" },
        { category: "maintainability" },
        { category: "reliability" },
        { category: "usability" },
        { category: "compatibility" },
      ],
    });
    const merged = merger.preMerge([a1, a2]);
    const nfrs = merged.non_functional_requirements as Array<Record<string, unknown>>;
    // Each Chinese-English pair should be deduplicated to one entry each = 8 total
    expect(nfrs).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// single-artifact path: canonicalizeAndLink must be called
// ---------------------------------------------------------------------------

describe("single-artifact merge path", () => {
  it("calls canonicalizeAndLink on single artifact (IDs are canonicalized)", async () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const single = artifact({
      functions: [{ id: "old_func_id", name: "Login", description: "User login" }],
      constraints: [{ id: "old_con_id", description: "Must be secure" }],
      exceptions: [{ id: "old_exc_id", description: "Network failure" }],
    });
    const result = await merger.merge([single], "requirement text");
    const functions = result.functions as Array<Record<string, unknown>>;
    const constraints = result.constraints as Array<Record<string, unknown>>;
    const exceptions = result.exceptions as Array<Record<string, unknown>>;

    // canonicalizeAndLink rewrites IDs to FUN_/CON_/EXC_ format
    expect(functions[0].id).toMatch(/^FUN_/);
    expect(functions[0].displayId).toBe("F001");
    expect(constraints[0].id).toMatch(/^CON_/);
    expect(constraints[0].displayId).toBe("C001");
    expect(exceptions[0].id).toMatch(/^EXC_/);
    expect(exceptions[0].displayId).toBe("X001");
  });
});
