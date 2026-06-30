import { describe, it, expect } from "vitest";
import {
  detectDroppedConstraints,
  formatDroppedConstraints,
  normalizeConstraintText,
} from "../src/shared/constraintReconcile.js";
import type { ConstraintCandidate } from "../src/shared/constraintCanonicalizer.js";
import { AnalyzeMerger } from "../src/generators/merge.js";

function cand(sourceText: string, description = sourceText): ConstraintCandidate {
  return { sourceText, description, canonicalRuleEn: description, type: "functional", subtype: "general" };
}

describe("detectDroppedConstraints", () => {
  it("flags candidates absent from the final constraints (C002–C005 drop)", () => {
    const candidates = [
      cand("订单金额必须大于0"),
      cand("库存不足时不可下单"),
      cand("支付超时时间为30分钟"),
      cand("用户密码至少8位"),
      cand("每个账户每日最多下单100次"),
      cand("管理员才能删除订单"),
    ];
    // analyze only kept the 1st and last (by content)
    const finalConstraints = [
      { source_text: "订单金额必须大于0", description: "金额为正" },
      { source_text: "管理员才能删除订单", description: "删除权限" },
    ];

    const dropped = detectDroppedConstraints(candidates, finalConstraints);
    expect(dropped.map((d) => d.constraintRef)).toEqual(["C002", "C003", "C004", "C005"]);
    expect(dropped[0].sourceText).toBe("库存不足时不可下单");
  });

  it("treats a reworded/expanded final constraint as covering the candidate", () => {
    const candidates = [cand("支付超时时间为30分钟")];
    // Final wraps the same rule in a longer sentence → containment match
    const finalConstraints = [
      { source_text: "系统规定支付超时时间为30分钟，超时后订单自动取消" },
    ];
    expect(detectDroppedConstraints(candidates, finalConstraints)).toEqual([]);
  });

  it("matches against description when source_text is absent on the final", () => {
    const candidates = [cand("用户密码至少8位")];
    const finalConstraints = [{ description: "用户密码至少8位" }];
    expect(detectDroppedConstraints(candidates, finalConstraints)).toEqual([]);
  });

  it("returns [] for empty / missing registry", () => {
    expect(detectDroppedConstraints(undefined, [{ source_text: "x" }])).toEqual([]);
    expect(detectDroppedConstraints([], [{ source_text: "x" }])).toEqual([]);
  });

  it("skips candidates too short to match reliably", () => {
    const candidates = [cand("唯一")]; // < MIN_MATCH_LEN normalized
    expect(detectDroppedConstraints(candidates, [])).toEqual([]);
  });

  it("reports all candidates dropped when final is empty", () => {
    const candidates = [cand("订单金额必须大于0"), cand("库存不足时不可下单")];
    const dropped = detectDroppedConstraints(candidates, []);
    expect(dropped.map((d) => d.constraintRef)).toEqual(["C001", "C002"]);
  });
});

describe("normalizeConstraintText", () => {
  it("folds case, whitespace, hyphens and punctuation but keeps CJK", () => {
    expect(normalizeConstraintText("  Order-Amount  > 0! ")).toBe("order amount 0");
    expect(normalizeConstraintText("订单金额，必须大于0。")).toBe("订单金额必须大于0");
  });
});

describe("AnalyzeMerger.merge — constraint registry instrumentation", () => {
  it("re-adds dropped registry candidates and reports droppedCount=0", async () => {
    // single-artifact path is deterministic (no LLM call)
    const merger = new AnalyzeMerger({} as never);
    const registry = [cand("订单金额必须大于0"), cand("库存不足时不可下单")];
    const artifact = {
      taskId: "analyze-1",
      content: {
        actors: [],
        entities: [],
        functions: [],
        // analyze kept only the first registry constraint, dropped the second
        constraints: [{ description: "订单金额必须大于0", source_text: "订单金额必须大于0" }],
      },
    };

    const merged = await merger.merge([artifact], "需求文本", undefined, undefined, registry);
    const diag = (merged as Record<string, unknown>).__constraintRegistryDiagnostic as
      | { registryTotal: number; droppedCount: number; dropped: Array<{ constraintRef: string }> }
      | undefined;

    expect(diag).toBeTruthy();
    expect(diag!.registryTotal).toBe(2);
    // FIX 3: dropped candidates are AUTHORITATIVELY re-added, so the final
    // constraints are a superset of the registry and droppedCount is 0.
    expect(diag!.droppedCount).toBe(0);

    const constraints = (merged.constraints as Array<Record<string, unknown>>) ?? [];
    // Both registry candidates must be represented in the final constraints.
    expect(constraints.some((c) => String(c.description ?? "").includes("订单金额必须大于0"))).toBe(true);
    expect(constraints.some((c) => String(c.description ?? "").includes("库存不足时不可下单"))).toBe(true);
  });

  it("does not attach a diagnostic when no registry is provided", async () => {
    const merger = new AnalyzeMerger({} as never);
    const artifact = {
      taskId: "analyze-1",
      content: { actors: [], entities: [], functions: [], constraints: [] },
    };
    const merged = await merger.merge([artifact], "需求文本");
    expect((merged as Record<string, unknown>).__constraintRegistryDiagnostic).toBeUndefined();
  });
});

// Regression (FIX 3): when the analyze artifact drops registry candidates,
// AnalyzeMerger.merge re-adds them so the final constraints array is a
// superset of the registry.
describe("AnalyzeMerger.merge — authoritative constraint re-add (FIX 3)", () => {
  it("makes final constraints a superset of the registry", async () => {
    const merger = new AnalyzeMerger({} as never);
    const registry = [
      cand("支付超时时间为30分钟"),
      cand("用户密码至少8位"),
      cand("管理员才能删除订单"),
      cand("每个账户每日最多下单100次"),
    ];
    const artifact = {
      taskId: "analyze-1",
      content: {
        actors: [],
        entities: [],
        functions: [],
        // analyze dropped ALL registry constraints
        constraints: [],
      },
    };

    const merged = await merger.merge([artifact], "需求文本", undefined, undefined, registry);
    const constraints = (merged.constraints as Array<Record<string, unknown>>) ?? [];
    const descriptions = constraints.map((c) => String(c.description ?? ""));

    // Every registry candidate must appear in the final constraints.
    for (const r of registry) {
      expect(descriptions.some((d) => d.includes(r.description ?? ""))).toBe(true);
    }
    // No `ct_00000000` empty stubs should survive.
    expect(constraints.some((c) => String(c.id ?? "").includes("00000000"))).toBe(false);
    expect(constraints.some((c) => !String(c.description ?? "").trim())).toBe(false);
  });
});

describe("formatDroppedConstraints", () => {
  it("produces a summary line plus one line per dropped constraint", () => {
    const lines = formatDroppedConstraints(
      [
        { constraintRef: "C002", description: "库存", sourceText: "库存不足时不可下单" },
        { constraintRef: "C003", description: "超时", sourceText: "支付超时时间为30分钟" },
      ],
      6,
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("2/6");
    expect(lines[0]).toContain("C002, C003");
    expect(lines[1]).toContain("C002");
  });

  it("returns no lines when nothing was dropped", () => {
    expect(formatDroppedConstraints([], 6)).toEqual([]);
  });
});
