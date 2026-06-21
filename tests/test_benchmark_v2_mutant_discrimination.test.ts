/**
 * Phase-2 acceptance: mutant discrimination.
 *
 * For each of the 5 hand-crafted mutants (M1..M5) we feed the judge a mock LLM
 * whose verdict mirrors the SEMANTIC content actually present in that mutant's
 * design/tests artifacts, then assert that the aggregated {@link QualityScores}
 * move in the EXPECTED direction relative to a clean baseline. This is the
 * Phase-2 acceptance criterion: the judge must be able to tell good from bad
 * artifact sets, not just rubber-stamp them.
 *
 * The mock verdicts are constructed to reflect what a well-behaved judge would
 * extract from each mutant's on-disk artifacts (under benchmark/mutants).
 * Each mutant's `expected_scores.json` pins the expected per-obligation cap and
 * the primary sub-score that must drop.
 *
 * NOTE: a real-LLM smoke variant is intentionally NOT asserted here (non-
 * deterministic + needs an API key); mock-based discrimination is the
 * acceptance gate per the plan.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { judgeAgainstGold, type ObligationVerdict } from "../src/benchmark/qualityJudge.js";
import type { JudgeClient } from "../src/benchmark/judgeClient.js";
import { loadGoldContract } from "../src/benchmark/goldObligation.js";

/** Gold obligation id → the mock verdict the judge would produce for it. */
type VerdictMap = Record<string, Partial<ObligationVerdict> & { score: 0 | 1 | 2 | 3 }>;

/** Build a mock JudgeClient that returns the mapped verdict per obligation id. */
function mockJudgeFor(verdicts: VerdictMap): JudgeClient {
  return {
    generateJson: async (prompt: string) => {
      // Identify the obligation from the prompt (the prompt always lists `- id:`).
      const m = prompt.match(/- id:\s*([A-Z]-\d{3})/);
      const id = m ? m[1] : "";
      const v = verdicts[id] ?? { score: 0 };
      return {
        extracted_design_evidence: v.extracted_design_evidence ?? (v.score_basis?.has_concrete_rule ? ["rule"] : []),
        extracted_test_evidence: v.extracted_test_evidence ?? (v.score_basis?.has_test_alignment ? ["assertion"] : []),
        missing_evidence: v.missing_evidence ?? [],
        score: v.score,
        score_basis: v.score_basis ?? {
          has_concrete_rule: false,
          has_trigger_condition: false,
          has_handling_behavior: false,
          has_test_alignment: false,
        },
        reason: v.reason ?? "mock",
      };
    },
  };
}

/** A fully-aligned verdict (the "clean baseline" answer for one obligation). */
const FULL: Partial<ObligationVerdict> & { score: 0 | 1 | 2 | 3 } = {
  score: 3,
  extracted_design_evidence: ["concrete rule excerpt"],
  extracted_test_evidence: ["aligned assertion excerpt"],
  score_basis: {
    has_concrete_rule: true,
    has_trigger_condition: true,
    has_handling_behavior: true,
    has_test_alignment: true,
  },
};

/** ID-only / shallow verdict: concrete rule absent ⇒ capped at 1. */
const SHALLOW: Partial<ObligationVerdict> & { score: 0 | 1 | 2 | 3 } = {
  score: 1,
  extracted_design_evidence: ["C-001 已覆盖"],
  score_basis: {
    has_concrete_rule: false,
    has_trigger_condition: false,
    has_handling_behavior: false,
    has_test_alignment: false,
  },
};

/** Concrete rule present but test does NOT align ⇒ ≤ 2 (fake-trace shape). */
function ruleOnly(score: 1 | 2 = 2): Partial<ObligationVerdict> & { score: 0 | 1 | 2 | 3 } {
  return {
    score,
    extracted_design_evidence: ["concrete rule excerpt"],
    extracted_test_evidence: ["unrelated test excerpt"],
    score_basis: {
      has_concrete_rule: true,
      has_trigger_condition: true,
      has_handling_behavior: true,
      has_test_alignment: false,
    },
  };
}

/** Missing exception handling: concrete rule absent for an exception obligation. */
const NO_HANDLING: Partial<ObligationVerdict> & { score: 0 | 1 | 2 | 3 } = {
  score: 1,
  extracted_design_evidence: [],
  extracted_test_evidence: [],
  score_basis: {
    has_concrete_rule: false,
    has_trigger_condition: false,
    has_handling_behavior: false,
    has_test_alignment: false,
  },
};

const GOLD_PATH = join("benchmark", "gold_contracts", "hospital_mgmt.json");
const GOLD = loadGoldContract(GOLD_PATH)!;
const GOLD_IDS = GOLD.obligations.map((o) => o.id);

/** Spread a per-mutant override over a baseline of FULL for every gold id. */
function verdictAll(override: VerdictMap): VerdictMap {
  const out: VerdictMap = {};
  for (const id of GOLD_IDS) out[id] = override[id] ?? FULL;
  return out;
}

/** Load a mutant's expected_scores.json. */
function expected(mutantId: string): {
  expected_per_obligation: Record<string, { max_score: number }>;
  expected_quality_direction: Record<string, string>;
} {
  return JSON.parse(
    readFileSync(join("benchmark", "mutants", mutantId, "expected_scores.json"), "utf8"),
  );
}

// ---------------------------------------------------------------------------
// Baseline: a clean artifact set should score high everywhere.
// ---------------------------------------------------------------------------

describe("mutant discrimination — clean baseline", () => {
  it("scores near 100 across all sub-scores when every obligation is fully evidenced", async () => {
    const { quality } = await judgeAgainstGold(mockJudgeFor(verdictAll({})), GOLD, {
      requirement_source: "r",
      designPath: "__missing__",
      testsPath: "__missing__",
    });
    expect(quality.gold_obligation_coverage).toBe(100);
    expect(quality.design_depth).toBe(100);
    expect(quality.test_effectiveness).toBe(100);
    expect(quality.traceability_truthfulness).toBe(100);
    expect(quality.final_score).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Per-mutant discrimination.
// ---------------------------------------------------------------------------

/**
 * M1 shallow_coverage: every constraint/exception obligation loses its concrete
 * rule (ID-only). gold_obligation_coverage + design_depth must collapse.
 */
describe("M1 shallow_coverage", () => {
  it("collapses coverage & depth and respects each obligation's expected cap", async () => {
    const exp = expected("M1_shallow_coverage");
    const overrides: VerdictMap = {};
    for (const id of GOLD_IDS) overrides[id] = SHALLOW; // all shallow
    const { verdicts, quality } = await judgeAgainstGold(
      mockJudgeFor(verdictAll(overrides)),
      GOLD,
      { requirement_source: "r", designPath: "__missing__", testsPath: "__missing__" },
    );
    // Every verdict respects its expected per-obligation cap.
    for (const v of verdicts) {
      expect(v.score).toBeLessThanOrEqual(exp.expected_per_obligation[v.obligation_id].max_score);
    }
    // Primary drop: gold_obligation_coverage must be LOW (all obligations at
    // score 1 ⇒ 1/3 ≈ 33.3).
    expect(quality.gold_obligation_coverage!).toBeLessThanOrEqual(34);
    expect(quality.design_depth!).toBeLessThanOrEqual(34);
    // And clearly worse than the clean baseline.
    expect(quality.final_score!).toBeLessThan(50);
  });
});

/**
 * M2 fake_traceability: concrete rules exist but tests do not align.
 * traceability_truthfulness + test_effectiveness must drop while design_depth
 * stays high.
 */
describe("M2 fake_traceability", () => {
  it("drops traceability/test while keeping design depth", async () => {
    const { quality } = await judgeAgainstGold(
      mockJudgeFor(verdictAll({})), // baseline FULL everywhere...
      GOLD,
      { requirement_source: "r", designPath: "__missing__", testsPath: "__missing__" },
    );
    // Sanity: baseline is high (control).
    expect(quality.traceability_truthfulness).toBe(100);

    // Now the mutant: every obligation has a rule but NO test alignment.
    const overrides: VerdictMap = {};
    for (const id of GOLD_IDS) overrides[id] = ruleOnly(2);
    const mut = await judgeAgainstGold(
      mockJudgeFor(verdictAll(overrides)),
      GOLD,
      { requirement_source: "r", designPath: "__missing__", testsPath: "__missing__" },
    );
    expect(mut.quality.traceability_truthfulness!).toBe(0); // rules but no aligned tests
    expect(mut.quality.test_effectiveness!).toBe(0);
    expect(mut.quality.design_depth!).toBe(100); // rules still deep
    expect(mut.quality.gold_obligation_coverage!).toBeGreaterThan(0); // score 2 each → ~66
    expect(mut.quality.gold_obligation_coverage!).toBeLessThanOrEqual(67);
  });
});

/**
 * M3 missing_exception: exception obligations (X-*) lose handling. design_depth
 * drops, while constraint/functional obligations stay full.
 */
describe("M3 missing_exception", () => {
  it("drops design_depth / coverage for exception obligations only", async () => {
    const exp = expected("M3_missing_exception");
    const overrides: VerdictMap = {};
    for (const id of GOLD_IDS) {
      const o = GOLD.obligations.find((x) => x.id === id)!;
      overrides[id] = o.type === "exception" ? NO_HANDLING : FULL;
    }
    const { verdicts, quality } = await judgeAgainstGold(
      mockJudgeFor(verdictAll(overrides)),
      GOLD,
      { requirement_source: "r", designPath: "__missing__", testsPath: "__missing__" },
    );
    // Exception obligations capped at 1; others full.
    for (const v of verdicts) {
      expect(v.score).toBeLessThanOrEqual(exp.expected_per_obligation[v.obligation_id].max_score);
    }
    // design_depth must be strictly lower than the all-FULL baseline (100),
    // because the two exception obligations now have no handling flags.
    expect(quality.design_depth!).toBeLessThan(100);
    expect(quality.design_depth!).toBeGreaterThan(0);
    // Coverage also drops (two obligations at score 1).
    expect(quality.gold_obligation_coverage!).toBeLessThan(100);
  });
});

/**
 * M4 hallucinated_test: the allergy test (X-002) asserts the wrong behavior.
 * test_effectiveness for X-002 must drop (no alignment), while the design rule
 * is intact (so design_depth stays).
 */
describe("M4 hallucinated_test", () => {
  it("drops test_effectiveness for the misaligned obligation", async () => {
    const overrides: VerdictMap = {
      "X-002": ruleOnly(2), // design rule present, but test asserts something else
    };
    const { quality } = await judgeAgainstGold(
      mockJudgeFor(verdictAll(overrides)),
      GOLD,
      { requirement_source: "r", designPath: "__missing__", testsPath: "__missing__" },
    );
    // test_effectiveness: 11 of 12 fully align (only X-002 misaligned),
    // X-002 does not.
    expect(quality.test_effectiveness!).toBeLessThan(100);
    expect(quality.test_effectiveness!).toBeGreaterThanOrEqual(80);
    // design_depth unaffected (rule still present).
    expect(quality.design_depth).toBe(100);
    // traceability_truthfulness drops because X-002 has a rule but no aligned test.
    expect(quality.traceability_truthfulness!).toBeLessThan(100);
  });
});

/**
 * M5 wrong_design_decision: C-002 has a concrete rule that CONTRADICTS the
 * obligation. The judge must NOT give it high coverage just because "a rule
 * exists" — a wrong rule scores ≤ 1.
 */
describe("M5 wrong_design_decision", () => {
  it("scores a contradicting rule ≤ 1 even though a rule exists", async () => {
    const exp = expected("M5_wrong_design_decision");
    const overrides: VerdictMap = {
      "C-002": {
        score: 1,
        extracted_design_evidence: ["抗生素可由开方医生直接审核通过，跳过主任审批"],
        score_basis: {
          // The judge flags concrete_rule true (a rule IS stated) but scores 1
          // because the rule contradicts the obligation. enforceRubric keeps 1.
          has_concrete_rule: true,
          has_trigger_condition: true,
          has_handling_behavior: true,
          has_test_alignment: false,
        },
      },
    };
    const { verdicts, quality } = await judgeAgainstGold(
      mockJudgeFor(verdictAll(overrides)),
      GOLD,
      { requirement_source: "r", designPath: "__missing__", testsPath: "__missing__" },
    );
    const c002 = verdicts.find((v) => v.obligation_id === "C-002")!;
    expect(c002.score).toBeLessThanOrEqual(exp.expected_per_obligation["C-002"].max_score);
    expect(c002.score).toBe(1);
    // Coverage drops below the clean baseline (one obligation at 1 vs 3).
    expect(quality.gold_obligation_coverage!).toBeLessThan(100);
    // But not a total collapse (other obligations are full).
    expect(quality.gold_obligation_coverage!).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// Discrimination summary: the judge separates clean vs each mutant.
// ---------------------------------------------------------------------------

describe("discrimination summary", () => {
  it("every mutant's primary-drop sub-score is strictly below the clean baseline", async () => {
    const clean = (await judgeAgainstGold(mockJudgeFor(verdictAll({})), GOLD, {
      requirement_source: "r",
      designPath: "__missing__",
      testsPath: "__missing__",
    })).quality;

    const cases: Array<{ mutant: string; build: () => VerdictMap; primary: keyof typeof clean }> = [
      {
        mutant: "M1_shallow_coverage",
        primary: "gold_obligation_coverage",
        build: () => verdictAll(Object.fromEntries(GOLD_IDS.map((id) => [id, SHALLOW]))),
      },
      {
        mutant: "M2_fake_traceability",
        primary: "traceability_truthfulness",
        build: () => verdictAll(Object.fromEntries(GOLD_IDS.map((id) => [id, ruleOnly(2)]))),
      },
      {
        mutant: "M3_missing_exception",
        primary: "design_depth",
        build: () =>
          verdictAll(
            Object.fromEntries(
              GOLD_IDS.map((id) => [
                id,
                GOLD.obligations.find((x) => x.id === id)!.type === "exception" ? NO_HANDLING : FULL,
              ]),
            ),
          ),
      },
      {
        mutant: "M4_hallucinated_test",
        primary: "test_effectiveness",
        build: () => ({ "X-002": ruleOnly(2) }),
      },
      {
        mutant: "M5_wrong_design_decision",
        primary: "gold_obligation_coverage",
        build: () => ({ "C-002": { ...ruleOnly(1), score: 1 } }),
      },
    ];

    for (const c of cases) {
      const q = (
        await judgeAgainstGold(mockJudgeFor(c.build()), GOLD, {
          requirement_source: "r",
          designPath: "__missing__",
          testsPath: "__missing__",
        })
      ).quality;
      const drop = q[c.primary]!;
      const base = clean[c.primary] as number;
      expect(drop, `${c.mutant}: ${String(c.primary)} should drop below clean baseline (${base})`).toBeLessThan(base);
    }
  });
});
