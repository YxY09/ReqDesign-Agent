/**
 * Integration test: ConstraintCanonicalizer wired into merge pipeline.
 *
 * Verifies that merge() produces constraints in the new CanonicalConstraint format
 * (canonicalId, constraintUid, type, subtype, etc.) instead of the old format.
 */

import { describe, it, expect } from "vitest";
import { AnalyzeMerger } from "../src/generators/merge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeLlm = {
  generateJson: async () => {
    throw new Error("LLM should not be called in integration tests");
  },
} as any;

function artifact(content: Record<string, unknown>) {
  return { taskId: `task-${Math.random().toString(36).slice(2, 8)}`, content };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConstraintCanonicalizer integration in merge pipeline", () => {
  it("single-artifact merge produces CanonicalConstraint format", async () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const single = artifact({
      functions: [{ id: "old_func", name: "Login", description: "User login" }],
      constraints: [
        {
          id: "old_con_1",
          description: "Audit trail data cannot be modified or deleted",
          source_text: "审计跟踪数据不可修改或删除",
        },
      ],
      exceptions: [
        { id: "old_exc_1", description: "Network timeout" },
      ],
    });

    const result = await merger.merge([single], "审计跟踪数据不可修改或删除");

    const constraints = result.constraints as Array<Record<string, unknown>>;
    expect(constraints.length).toBe(1);

    const c = constraints[0];

    // New CanonicalConstraint fields
    expect(c.canonicalId).toMatch(/^CON_SEC_AUDIT/);
    expect(c.constraintUid).toMatch(/^ct_[A-Z0-9]{8}$/);
    expect(c.type).toBe("security");
    expect(c.subtype).toBe("audit");
    expect(c.descriptionZh).toBe("审计跟踪数据不可修改或删除");
    expect(c.sourceText).toBe("审计跟踪数据不可修改或删除");

    // Compatibility fields (id, displayId, source_text)
    expect(c.id).toMatch(/^CON_/);
    expect(c.displayId).toBe("C001");
    expect(c.source_text).toBe("审计跟踪数据不可修改或删除");
  });

  it("multi-artifact merge deduplicates constraints via ConstraintCanonicalizer", async () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const a1 = artifact({
      functions: [{ id: "f1", name: "SearchCase", description: "Search" }],
      constraints: [
        {
          id: "c1",
          description: "Audit trail must be immutable",
          source_text: "审计数据不可修改",
        },
      ],
    });
    const a2 = artifact({
      functions: [{ id: "f2", name: "CreateUser", description: "Create user" }],
      constraints: [
        {
          id: "c2",
          description: "Audit data cannot be changed",
          source_text: "审计数据不可修改",
        },
      ],
    });

    // merge with single artifact won't go through preMerge
    // Use multi-artifact path
    const result = merger.preMerge([a1, a2]);

    // After preMerge, both constraints are present (same source_text → deduped to 1)
    const constraints = result.constraints as Array<Record<string, unknown>>;
    expect(constraints.length).toBe(1);
  });

  it("constraints have normalizedRule and verification fields", async () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const single = artifact({
      constraints: [
        {
          id: "c1",
          description: "Response time must be under 5 seconds",
          source_text: "响应时间必须低于5秒",
        },
      ],
    });

    const result = await merger.merge([single], "响应时间必须低于5秒");
    const c = (result.constraints as Array<Record<string, unknown>>)[0];

    // normalizedRule
    expect(c.normalizedRule).toBeDefined();
    const rule = c.normalizedRule as Record<string, unknown>;
    expect(rule.modality).toBeDefined();

    // verification
    expect(c.verification).toBeDefined();
    const verification = c.verification as Record<string, unknown>;
    expect(verification.testability).toBe("testable");
    expect(verification.recommendedType).toBe("performance_test");
  });

  it("functions and exceptions still get canonical IDs from old canonicalizer", async () => {
    const merger = new AnalyzeMerger(fakeLlm);
    const single = artifact({
      functions: [{ id: "old_func", name: "Login", description: "User login" }],
      constraints: [
        { id: "old_con", description: "Must be secure", source_text: "安全要求" },
      ],
      exceptions: [
        { id: "old_exc", description: "Network failure" },
      ],
    });

    const result = await merger.merge([single], "安全要求");

    // Functions still processed by old canonicalizer
    const fns = result.functions as Array<Record<string, unknown>>;
    expect(fns[0].id).toBe("FUN_LOGIN");
    expect(fns[0].displayId).toBe("F001");

    // Exceptions still processed by old canonicalizer
    const excs = result.exceptions as Array<Record<string, unknown>>;
    expect(excs[0].id).toMatch(/^EXC_/);
    expect(excs[0].displayId).toBe("X001");
  });
});
