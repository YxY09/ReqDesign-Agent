/**
 * Phase-2 unit tests: qualityJudge.ts — rubric enforcement (code-side
 * downgrade), evidence parsing, aggregation, and the anti-self-hype guarantees.
 * Fully offline using a mock JudgeClient.
 */
import { describe, it, expect } from "vitest";

import {
  buildJudgePrompt,
  enforceRubric,
  judgeObligation,
  aggregateQuality,
  judgeAgainstGold,
  buildContradictionPrompt,
  checkContradiction,
  buildTraceChainPrompt,
  judgeTraceChain,
  extractChainsForObligation,
  type ObligationVerdict,
} from "../src/benchmark/qualityJudge.js";
import type { JudgeClient } from "../src/benchmark/scorer.js";
import type { GoldContract, GoldObligation } from "../src/benchmark/goldObligation.js";

/** Mock JudgeClient that always returns `verdict` (the test_benchmark_scorer pattern). */
function mockJudge(verdict: Record<string, unknown>): JudgeClient {
  return { generateJson: async () => verdict };
}

/** A canonical obligation used across the rubric tests. */
function sampleObligation(): GoldObligation {
  return {
    id: "C-001",
    type: "constraint",
    severity: "major",
    source_span: "每位医生每日限号 50，同一患者同日同科限挂 1 次",
    expected_design_evidence: ["每日 50 的硬性校验", "同科同日 1 次去重"],
    expected_test_evidence: ["第 51 个被拒绝", "重复挂号被拒"],
    anti_patterns: ["只挂 ID 无数值规则"],
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

describe("buildJudgePrompt — rubric 铁律 are hardcoded", () => {
  it("embeds all four hard rubric rules + the anti-self-hype constraints", () => {
    const prompt = buildJudgePrompt({
      obligation: sampleObligation(),
      source_language: "zh",
      requirement_source: "需求原文",
      design: "design 文本",
      tests: "tests 文本",
    });
    // 0..3 score bands.
    expect(prompt).toMatch(/Score 0/);
    expect(prompt).toMatch(/Score 1/);
    expect(prompt).toMatch(/Score 2/);
    expect(prompt).toMatch(/Score 3/);
    // Anti-self-hype hard constraints (verbatim phrases from the spec).
    expect(prompt).toMatch(/no verbatim evidence.*0/);
    expect(prompt).toMatch(/ID\/keyword\/trace-link.*AT MOST 1/);
    expect(prompt).toMatch(/no testable design rule.*NOT 2 or 3/);
    expect(prompt).toMatch(/no test alignment.*NOT 3/);
    expect(prompt).toMatch(/CONTRADICTS the obligation/);
    // Output shape is pinned.
    expect(prompt).toMatch(/extracted_design_evidence/);
    expect(prompt).toMatch(/score_basis/);
    expect(prompt).toMatch(/has_test_alignment/);
  });

  it("embeds the obligation's expected evidence + anti-patterns", () => {
    const prompt = buildJudgePrompt({
      obligation: sampleObligation(),
      source_language: "zh",
      requirement_source: "r",
      design: "d",
      tests: "t",
    });
    expect(prompt).toContain("每日 50 的硬性校验");
    expect(prompt).toContain("只挂 ID 无数值规则");
    expect(prompt).toContain("C-001");
  });
});

// ---------------------------------------------------------------------------
// enforceRubric — the code-side anti-self-hype gate
// ---------------------------------------------------------------------------

describe("enforceRubric — 铁律 1: no evidence ⇒ 0", () => {
  it("forces 0 when both evidence lists are empty, even if the LLM said 3", () => {
    const v = enforceRubric(sampleObligation(), {
      extracted_design_evidence: [],
      extracted_test_evidence: [],
      score: 3,
      score_basis: {
        has_concrete_rule: true,
        has_trigger_condition: true,
        has_handling_behavior: true,
        has_test_alignment: true,
      },
      reason: "looks good overall",
    });
    expect(v.score).toBe(0);
    expect(v.rubric_downgraded).toBe(true);
  });
});

describe("enforceRubric — 铁律 2/3: no testable rule ⇒ ≤ 1", () => {
  it("caps at 1 when has_concrete_rule is false even with a high raw score", () => {
    const v = enforceRubric(sampleObligation(), {
      extracted_design_evidence: ["C-001 已覆盖"],
      extracted_test_evidence: ["相关测试"],
      score: 3,
      score_basis: {
        has_concrete_rule: false, // ID/keyword only — no concrete rule
        has_trigger_condition: false,
        has_handling_behavior: false,
        has_test_alignment: true,
      },
      reason: "id present",
    });
    expect(v.score).toBe(1);
    expect(v.rubric_downgraded).toBe(true);
  });

  it("keeps a legitimate score 1 (ID-only) unchanged", () => {
    const v = enforceRubric(sampleObligation(), {
      extracted_design_evidence: ["C-001"],
      extracted_test_evidence: [],
      score: 1,
      score_basis: {
        has_concrete_rule: false,
        has_trigger_condition: false,
        has_handling_behavior: false,
        has_test_alignment: false,
      },
    });
    expect(v.score).toBe(1);
    expect(v.rubric_downgraded).toBe(false);
  });
});

describe("enforceRubric — 铁律 4: no test alignment ⇒ not 3", () => {
  it("caps at 2 when concrete rule exists but no test alignment (score 3 → 2)", () => {
    const v = enforceRubric(sampleObligation(), {
      extracted_design_evidence: ["每日限号 50 的校验规则"],
      extracted_test_evidence: ["某测试"],
      score: 3,
      score_basis: {
        has_concrete_rule: true,
        has_trigger_condition: true,
        has_handling_behavior: true,
        has_test_alignment: false, // tests do not align
      },
    });
    expect(v.score).toBe(2);
    expect(v.rubric_downgraded).toBe(true);
  });

  it("forces score 3 → 2 when test evidence excerpts are missing", () => {
    const v = enforceRubric(sampleObligation(), {
      extracted_design_evidence: ["限号 50 规则"],
      extracted_test_evidence: [], // defense-in-depth: no test excerpt at all
      score: 3,
      score_basis: {
        has_concrete_rule: true,
        has_trigger_condition: true,
        has_handling_behavior: true,
        has_test_alignment: true,
      },
    });
    // 铁律 1 does not fire (design evidence present), but the score-3 guard
    // requires test evidence — so 3 → 2.
    expect(v.score).toBe(2);
  });
});

describe("enforceRubric — happy path", () => {
  it("preserves a legitimate full-score verdict", () => {
    const v = enforceRubric(sampleObligation(), {
      extracted_design_evidence: ["每日限号 50"],
      extracted_test_evidence: ["第 51 个被拒绝"],
      score: 3,
      score_basis: {
        has_concrete_rule: true,
        has_trigger_condition: true,
        has_handling_behavior: true,
        has_test_alignment: true,
      },
    });
    expect(v.score).toBe(3);
    expect(v.rubric_downgraded).toBe(false);
  });

  it("treats unknown / missing score_basis flags as false (strict)", () => {
    const v = enforceRubric(sampleObligation(), {
      extracted_design_evidence: ["x"],
      extracted_test_evidence: ["y"],
      score: 2,
      // score_basis omitted entirely
    });
    expect(v.score_basis.has_concrete_rule).toBe(false);
    // no concrete rule ⇒ capped at 1.
    expect(v.score).toBe(1);
  });

  it("clamps an out-of-range score", () => {
    const v = enforceRubric(sampleObligation(), {
      extracted_design_evidence: ["r"],
      extracted_test_evidence: ["t"],
      score: 7,
      score_basis: {
        has_concrete_rule: true,
        has_trigger_condition: true,
        has_handling_behavior: true,
        has_test_alignment: true,
      },
    });
    expect(v.score).toBe(3);
  });

  it("tolerates a string score and coerces", () => {
    const v = enforceRubric(sampleObligation(), {
      extracted_design_evidence: ["r"],
      extracted_test_evidence: ["t"],
      score: "2",
      score_basis: {
        has_concrete_rule: true,
        has_trigger_condition: true,
        has_handling_behavior: true,
        has_test_alignment: false,
      },
    });
    expect(v.score).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// judgeObligation — LLM call + parse + enforce pipeline
// ---------------------------------------------------------------------------

describe("judgeObligation", () => {
  it("runs the LLM, parses, and rubric-enforces", async () => {
    const client = mockJudge({
      extracted_design_evidence: ["每日限号 50"],
      extracted_test_evidence: ["第 51 个拒绝"],
      score: 3,
      score_basis: {
        has_concrete_rule: true,
        has_trigger_condition: true,
        has_handling_behavior: true,
        has_test_alignment: true,
      },
      reason: "ok",
    });
    const v = await judgeObligation(client, {
      obligation: sampleObligation(),
      source_language: "zh",
      requirement_source: "r",
      design: "d",
      tests: "t",
    });
    expect(v.score).toBe(3);
    expect(v.obligation_id).toBe("C-001");
  });

  it("degrades to score 0 when the LLM throws", async () => {
    const throwing: JudgeClient = {
      generateJson: async () => {
        throw new Error("network down");
      },
    };
    const v = await judgeObligation(throwing, {
      obligation: sampleObligation(),
      source_language: "zh",
      requirement_source: "r",
      design: "d",
      tests: "t",
    });
    expect(v.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// aggregateQuality — the 4 sub-scores
// ---------------------------------------------------------------------------

/** Helper: build a verdict directly. */
function verdict(
  id: string,
  score: 0 | 1 | 2 | 3,
  basis: Partial<ObligationVerdict["score_basis"]>,
): ObligationVerdict {
  return {
    obligation_id: id,
    extracted_design_evidence: basis.has_concrete_rule ? ["rule"] : [],
    extracted_test_evidence: basis.has_test_alignment ? ["assertion"] : [],
    missing_evidence: [],
    score,
    score_basis: {
      has_concrete_rule: basis.has_concrete_rule ?? false,
      has_trigger_condition: basis.has_trigger_condition ?? false,
      has_handling_behavior: basis.has_handling_behavior ?? false,
      has_test_alignment: basis.has_test_alignment ?? false,
    },
    reason: "",
    rubric_downgraded: false,
  };
}

describe("aggregateQuality", () => {
  it("returns all-null for an empty verdict list", () => {
    const q = aggregateQuality([]);
    expect(q.gold_obligation_coverage).toBeNull();
    expect(q.final_score).toBeNull();
  });

  it("gold_obligation_coverage = mean(score/3)*100", () => {
    // two obligations: scores 3 and 0 → 50.
    const q = aggregateQuality([verdict("a", 3, { has_concrete_rule: true, has_test_alignment: true }), verdict("b", 0, {})]);
    expect(q.gold_obligation_coverage).toBe(50);
  });

  it("design_depth rewards concrete_rule + trigger + handling", () => {
    const full = aggregateQuality([verdict("a", 2, {
      has_concrete_rule: true, has_trigger_condition: true, has_handling_behavior: true,
    })]);
    expect(full.design_depth).toBe(100);
    const partial = aggregateQuality([verdict("a", 1, { has_concrete_rule: true })]);
    // 1 of 3 flags → ~33.3
    expect(partial.design_depth).toBe(33.3);
  });

  it("test_effectiveness = fraction with has_test_alignment", () => {
    const q = aggregateQuality([
      verdict("a", 2, { has_concrete_rule: true, has_test_alignment: true }),
      verdict("b", 2, { has_concrete_rule: true, has_test_alignment: false }),
    ]);
    expect(q.test_effectiveness).toBe(50);
  });

  it("traceability_truthfulness is low when rules exist but tests do not align (fake-trace signal)", () => {
    const q = aggregateQuality([
      verdict("a", 2, { has_concrete_rule: true, has_test_alignment: false }),
      verdict("b", 2, { has_concrete_rule: true, has_test_alignment: false }),
    ]);
    expect(q.traceability_truthfulness).toBe(0);
  });

  it("traceability_truthfulness is 0 when NO obligation has a concrete rule (nothing to trace)", () => {
    const q = aggregateQuality([
      verdict("a", 0, { has_concrete_rule: false }),
      verdict("b", 0, { has_concrete_rule: false }),
    ]);
    expect(q.traceability_truthfulness).toBe(0);
  });

  it("final_score is a weighted average in [0,100]", () => {
    const q = aggregateQuality([
      verdict("a", 3, {
        has_concrete_rule: true, has_trigger_condition: true,
        has_handling_behavior: true, has_test_alignment: true,
      }),
    ]);
    expect(q.final_score).toBe(100);
    const bad = aggregateQuality([verdict("a", 0, {})]);
    expect(bad.final_score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// judgeAgainstGold — end-to-end orchestrator with mock LLM
// ---------------------------------------------------------------------------

describe("judgeAgainstGold", () => {
  it("judges every obligation and aggregates once per obligation", async () => {
    let calls = 0;
    // An HONEST mock judge: with missing design/tests files it finds no
    // verbatim evidence, so it returns empty evidence + score 0 — which the
    // code-side 铁律 1 must preserve.
    const client: JudgeClient = {
      generateJson: async () => {
        calls += 1;
        return {
          extracted_design_evidence: [],
          extracted_test_evidence: [],
          score: 0,
          score_basis: {
            has_concrete_rule: false,
            has_trigger_condition: false,
            has_handling_behavior: false,
            has_test_alignment: false,
          },
          reason: "no evidence in empty artifacts",
        };
      },
    };
    const gold: GoldContract = {
      case_id: "x",
      source_language: "zh",
      canonical_language: "en",
      obligations: [sampleObligation(), { ...sampleObligation(), id: "X-002", type: "exception" }],
    };
    const { verdicts, quality } = await judgeAgainstGold(client, gold, {
      requirement_source: "r",
      designPath: "__missing__",
      testsPath: "__missing__",
    });
    expect(calls).toBe(2);
    expect(verdicts).toHaveLength(2);
    // Missing design/tests files ⇒ honest judge finds no evidence ⇒ score 0.
    expect(verdicts.every((v) => v.score === 0)).toBe(true);
    expect(quality.gold_obligation_coverage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2.5 — contradiction check (weakness 1: wrong-but-testable rules)
// ---------------------------------------------------------------------------

/** The M5 shape: an obligation whose design rule REVERSES it. */
function contradictingObligation(): GoldObligation {
  return {
    id: "C-002",
    type: "constraint",
    severity: "major",
    source_span: "C002: 处方约束 - 抗生素需主任医师审核",
    expected_design_evidence: ["含抗生素处方需主任医师审核的强制审批流（普通医生不可直接通过）"],
    expected_test_evidence: ["验证含抗生素处方未主任审核时被拦截/挂起"],
    anti_patterns: ["抗生素审核流程缺失或允许普通医生直接通过"],
  };
}

describe("Phase 2.5 — contradiction check", () => {
  it("buildContradictionPrompt embeds obligation + anti_patterns + decision rules", () => {
    const prompt = buildContradictionPrompt({
      obligation: contradictingObligation(),
      source_language: "zh",
      designEvidence: ["抗生素可由开方医生直接审核通过，跳过主任审批"],
      designText: "design text",
    });
    expect(prompt).toContain("C-002");
    expect(prompt).toContain("抗生素需主任医师审核");
    expect(prompt).toContain("anti_pattern");
    expect(prompt).toContain("contradicts");
    expect(prompt).toContain("contradicting_evidence");
  });

  it("checkContradiction returns contradicts=true when the LLM flags it", async () => {
    const client: JudgeClient = {
      generateJson: async () => ({
        contradicts: true,
        contradicting_evidence: ["抗生素可由开方医生直接审核通过"],
        reason: "reverses the obligation",
      }),
    };
    const r = await checkContradiction(client, {
      obligation: contradictingObligation(),
      source_language: "zh",
      designEvidence: ["抗生素可由开方医生直接审核通过，跳过主任审批"],
      designText: "design",
    });
    expect(r.contradicts).toBe(true);
    expect(r.contradicting_evidence).toHaveLength(1);
  });

  it("checkContradiction fails open (false) when the LLM throws", async () => {
    const throwing: JudgeClient = {
      generateJson: async () => {
        throw new Error("network down");
      },
    };
    const r = await checkContradiction(throwing, {
      obligation: contradictingObligation(),
      source_language: "zh",
      designEvidence: ["x"],
      designText: "d",
    });
    expect(r.contradicts).toBe(false);
  });
});

describe("Phase 2.5 — enforceRubric contradiction clamp (code-side)", () => {
  it("clamps a concrete-rule verdict to 1 when has_contradiction=true", () => {
    // The LLM gave full credit (concrete rule + test alignment ⇒ raw 3) for a
    // WRONG rule. Without the clamp this would stay at 3.
    const v = enforceRubric(
      contradictingObligation(),
      {
        extracted_design_evidence: ["抗生素可由开方医生直接审核通过，跳过主任审批"],
        extracted_test_evidence: ["验证抗生素可直接通过"],
        score: 3,
        score_basis: {
          has_concrete_rule: true,
          has_trigger_condition: true,
          has_handling_behavior: true,
          has_test_alignment: true,
        },
      },
      { has_contradiction: true },
    );
    expect(v.score).toBe(1);
    expect(v.rubric_downgraded).toBe(true);
    expect(v.has_contradiction).toBe(true);
  });

  it("keeps the verdict at ≤1 even if the raw score was only 2", () => {
    const v = enforceRubric(
      contradictingObligation(),
      {
        extracted_design_evidence: ["抗生素可由开方医生直接审核通过"],
        extracted_test_evidence: [],
        score: 2,
        score_basis: {
          has_concrete_rule: true,
          has_trigger_condition: true,
          has_handling_behavior: false,
          has_test_alignment: false,
        },
      },
      { has_contradiction: true },
    );
    expect(v.score).toBe(1);
  });

  it("does NOT clamp when has_contradiction is false (legacy behavior intact)", () => {
    const v = enforceRubric(
      contradictingObligation(),
      {
        extracted_design_evidence: ["抗生素需主任医师审核"],
        extracted_test_evidence: ["抗生素未主任审核被拦截"],
        score: 3,
        score_basis: {
          has_concrete_rule: true,
          has_trigger_condition: true,
          has_handling_behavior: true,
          has_test_alignment: true,
        },
      },
      { has_contradiction: false },
    );
    expect(v.score).toBe(3);
    expect(v.has_contradiction).toBeUndefined();
  });

  it("preserves legacy 2-arg behavior (no clamp) when flags omitted", () => {
    const v = enforceRubric(sampleObligation(), {
      extracted_design_evidence: ["每日限号 50"],
      extracted_test_evidence: ["第 51 个被拒绝"],
      score: 3,
      score_basis: {
        has_concrete_rule: true,
        has_trigger_condition: true,
        has_handling_behavior: true,
        has_test_alignment: true,
      },
    });
    expect(v.score).toBe(3);
    expect(v.has_contradiction).toBeUndefined();
  });
});

describe("Phase 2.5 — judgeObligation wires the two-step contradiction check", () => {
  it("runs the contradiction check only when design evidence exists and clamps on contradiction", async () => {
    const calls: string[] = [];
    // First call: main judge lifts design evidence + gives raw score 3.
    // Second call: contradiction auditor says contradicts=true.
    const client: JudgeClient = {
      generateJson: async (prompt: string) => {
        if (prompt.includes("contradiction auditor")) {
          calls.push("contradiction");
          return {
            contradicts: true,
            contradicting_evidence: ["抗生素可由开方医生直接审核通过"],
            reason: "reverses obligation",
          };
        }
        calls.push("judge");
        return {
          extracted_design_evidence: ["抗生素可由开方医生直接审核通过，跳过主任审批"],
          extracted_test_evidence: ["验证抗生素可直接通过"],
          score: 3,
          score_basis: {
            has_concrete_rule: true,
            has_trigger_condition: true,
            has_handling_behavior: true,
            has_test_alignment: true,
          },
          reason: "rule present",
        };
      },
    };
    const v = await judgeObligation(client, {
      obligation: contradictingObligation(),
      source_language: "zh",
      requirement_source: "r",
      design: "抗生素可由开方医生直接审核通过",
      tests: "验证抗生素可直接通过",
    });
    expect(calls).toEqual(["judge", "contradiction"]);
    expect(v.score).toBe(1); // code-side clamp applied
    expect(v.has_contradiction).toBe(true);
  });

  it("does NOT run the contradiction check when no design evidence was lifted (gate)", async () => {
    const calls: string[] = [];
    const client: JudgeClient = {
      generateJson: async (prompt: string) => {
        if (prompt.includes("contradiction auditor")) calls.push("contradiction");
        else calls.push("judge");
        return { // main judge finds nothing
          extracted_design_evidence: [],
          extracted_test_evidence: [],
          score: 0,
          score_basis: {
            has_concrete_rule: false,
            has_trigger_condition: false,
            has_handling_behavior: false,
            has_test_alignment: false,
          },
        };
      },
    };
    const v = await judgeObligation(client, {
      obligation: sampleObligation(),
      source_language: "zh",
      requirement_source: "r",
      design: "",
      tests: "",
    });
    expect(calls).toEqual(["judge"]); // no contradiction call
    expect(v.score).toBe(0);
    expect(v.has_contradiction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 2.5 — trace-chain truthfulness (weakness 2: fake traceability)
// ---------------------------------------------------------------------------

describe("Phase 2.5 — trace-chain truthfulness", () => {
  it("buildTraceChainPrompt embeds the chains + design/tests context", () => {
    const prompt = buildTraceChainPrompt({
      obligation: sampleObligation(),
      source_language: "zh",
      chains: [
        { constraint_description: "每日限号 50", design_element: "AppointmentService", test_id: "TC-B-014" },
      ],
      designText: "design",
      tests: "tests",
    });
    expect(prompt).toContain("traceability-truthfulness");
    expect(prompt).toContain("chain 1");
    expect(prompt).toContain("TC-B-014");
    expect(prompt).toContain("chain_truthful");
  });

  it("judgeTraceChain returns chain_truthful=false when the LLM flags a fake chain", async () => {
    const client: JudgeClient = {
      generateJson: async () => ({ chain_truthful: false, reason: "test asserts audit-log not allergy" }),
    };
    const r = await judgeTraceChain(client, {
      obligation: sampleObligation(),
      source_language: "zh",
      chains: [{ constraint_description: "x", design_element: "y", test_id: "TC-E-005" }],
      designText: "d",
      tests: "t",
    });
    expect(r.chain_truthful).toBe(false);
  });

  it("judgeTraceChain fails open (true) when the LLM throws", async () => {
    const throwing: JudgeClient = {
      generateJson: async () => {
        throw new Error("network down");
      },
    };
    const r = await judgeTraceChain(throwing, {
      obligation: sampleObligation(),
      source_language: "zh",
      chains: [{ constraint_description: "x", design_element: "y", test_id: "TC-1" }],
      designText: "d",
      tests: "t",
    });
    expect(r.chain_truthful).toBe(true);
  });

  it("judgeObligation sets trace_chain_truthful only when chains are supplied", async () => {
    // Main judge + contradiction (no contradict) + trace chain (untruthful).
    const client: JudgeClient = {
      generateJson: async (prompt: string) => {
        if (prompt.includes("contradiction auditor")) {
          return { contradicts: false, contradicting_evidence: [], reason: "" };
        }
        if (prompt.includes("traceability-truthfulness")) {
          return { chain_truthful: false, reason: "fake" };
        }
        return {
          extracted_design_evidence: ["rule"],
          extracted_test_evidence: ["assertion"],
          score: 3,
          score_basis: {
            has_concrete_rule: true,
            has_trigger_condition: true,
            has_handling_behavior: true,
            has_test_alignment: true,
          },
        };
      },
    };
    const v = await judgeObligation(client, {
      obligation: sampleObligation(),
      source_language: "zh",
      requirement_source: "r",
      design: "rule",
      tests: "assertion",
      matrix: { chains: [{ constraint_description: "每日 50", design_element: "AppointmentService", test_id: "TC-B-014" }] },
    });
    expect(v.trace_chain_truthful).toBe(false);
    // score unaffected by the chain verdict (the chain only affects aggregation).
    expect(v.score).toBe(3);
  });

  it("does NOT call the trace-chain judge when no matrix chains are supplied (gate)", async () => {
    const calls: string[] = [];
    const client: JudgeClient = {
      generateJson: async (prompt: string) => {
        if (prompt.includes("traceability-truthfulness")) calls.push("trace");
        else if (prompt.includes("contradiction auditor")) calls.push("contradiction");
        else calls.push("judge");
        return {
          extracted_design_evidence: ["rule"],
          extracted_test_evidence: ["assertion"],
          score: 3,
          score_basis: {
            has_concrete_rule: true,
            has_trigger_condition: true,
            has_handling_behavior: true,
            has_test_alignment: true,
          },
        };
      },
    };
    await judgeObligation(client, {
      obligation: sampleObligation(),
      source_language: "zh",
      requirement_source: "r",
      design: "rule",
      tests: "assertion",
    });
    expect(calls).toEqual(["judge", "contradiction"]); // no trace call
  });
});

describe("Phase 2.5 — extractChainsForObligation + matrix mapping", () => {
  it("extracts chains keyed by gold obligation id (C-001)", () => {
    const matrix = {
      constraintToDesign: { "C-001": ["AppointmentService"] },
      constraintToTests: { "C-001": ["TC-B-014"] },
    };
    const chains = extractChainsForObligation(sampleObligation(), matrix);
    expect(chains).toHaveLength(1);
    expect(chains[0].design_element).toContain("AppointmentService");
    expect(chains[0].test_id).toContain("TC-B-014");
  });

  it("extracts chains keyed by a dash-less display id (C001) via normalization", () => {
    const matrix = {
      constraintToDesign: { C001: ["X"] },
      constraintToTests: { C001: ["TC-1"] },
    };
    const chains = extractChainsForObligation(sampleObligation(), matrix);
    expect(chains).toHaveLength(1);
  });

  it("returns [] when the matrix is null", () => {
    expect(extractChainsForObligation(sampleObligation(), null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 2.5 — aggregateQuality prioritizes chain truthfulness
// ---------------------------------------------------------------------------

describe("Phase 2.5 — aggregateQuality traceability_truthfulness with chains", () => {
  it("uses chain truthfulness when any verdict has a chain verdict (fake chain drops the score)", () => {
    // Two obligations with rules + tests aligned; one has a JUDGED fake chain.
    const v1 = verdict("a", 2, { has_concrete_rule: true, has_test_alignment: true });
    v1.trace_chain_truthful = false; // matrix said chain is fake
    const v2 = verdict("b", 2, { has_concrete_rule: true, has_test_alignment: true });
    // v2 has no chain verdict (no matrix entry for it).
    const q = aggregateQuality([v1, v2]);
    // Only v1 was judged on its chain; it was untruthful ⇒ 0/1 = 0.
    expect(q.traceability_truthfulness).toBe(0);
  });

  it("rewards truthful chains over mere test alignment", () => {
    const v1 = verdict("a", 2, { has_concrete_rule: true, has_test_alignment: true });
    v1.trace_chain_truthful = true;
    const q = aggregateQuality([v1]);
    expect(q.traceability_truthfulness).toBe(100);
  });

  it("falls back to has_test_alignment when NO verdict has a chain verdict (legacy)", () => {
    // Clean baseline: no matrix ⇒ no chain verdicts ⇒ legacy formula.
    const q = aggregateQuality([
      verdict("a", 2, { has_concrete_rule: true, has_test_alignment: true }),
      verdict("b", 2, { has_concrete_rule: true, has_test_alignment: false }),
    ]);
    // 1 of 2 rule-bearing obligations has aligned tests ⇒ 50.
    expect(q.traceability_truthfulness).toBe(50);
  });
});
