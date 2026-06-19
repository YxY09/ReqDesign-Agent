/**
 * Benchmark v2 — Phase 2 evidence-based quality judge.
 *
 * The judge is a single LLM call per gold obligation, with a two-stage output
 * (extract verbatim evidence FIRST, then score). It is NOT an impression
 * score: the LLM may only justify a score with excerpts it literally copied
 * from the design/tests. This module then RE-ENFORCES the rubric in code
 * ({@link enforceRubric}) so an over-generous LLM cannot talk itself past the
 * 铁律.
 *
 * Rubric 铁律 (hard rules, enforced in BOTH prompt and code):
 *   - 0: no relevant evidence found.
 *   - 1: only ID / keyword / requirement restatement, or vague "needs handling".
 *   - 2: design has a concrete testable rule (trigger OR handling) but tests
 *        are not aligned / exceptions incomplete / boundaries thin.
 *   - 3: design has concrete rule + trigger + handling AND tests semantically
 *        align with a checkable assertion.
 *   - no evidence            ⇒ must be 0
 *   - ID/keyword/trace only  ⇒ at most 1
 *   - no testable rule       ⇒ no 2
 *   - no test alignment      ⇒ no 3
 *
 * The judge does NOT use generated coverage-matrix IDs — it matches obligations
 * by the verbatim `source_span` and `expected_*_evidence` excerpts, so a
 * renumbered matrix cannot fake coverage.
 *
 * @module benchmark/qualityJudge
 */

import { existsSync, readFileSync } from "node:fs";

import type { GoldContract, GoldObligation } from "./goldObligation.js";
import type { JudgeClient } from "./scorer.js";
import type { QualityScores } from "./resultStore.js";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** One obligation's judged verdict (parsed + rubric-enforced). */
export interface ObligationVerdict {
  obligation_id: string;
  /** Verbatim design excerpts the LLM lifted from the design doc. */
  extracted_design_evidence: string[];
  /** Verbatim test excerpts the LLM lifted from the test cases. */
  extracted_test_evidence: string[];
  /** Expected-evidence points the LLM could not find excerpts for. */
  missing_evidence: string[];
  /** Final rubric-enforced score 0..3. */
  score: 0 | 1 | 2 | 3;
  /** Code-recomputed basis flags (the source of truth for aggregation). */
  score_basis: ScoreBasis;
  /** Human/LLM rationale (for auditing only — never overrides the score). */
  reason: string;
  /** True when {@link enforceRubric} lowered the LLM's raw score. */
  rubric_downgraded: boolean;
  /**
   * True when an independent contradiction check decided the design states a
   * rule that is the OPPOSITE of the obligation (hits an anti_pattern). When
   * true, {@link enforceRubric} clamps the score to ≤ 1 (code-side, not just
   * prompt). Undefined when the contradiction step did not run (no design
   * evidence to contradict against).
   */
  has_contradiction?: boolean;
  /**
   * True when the traceability chain (constraint→design→test) was judged
   * semantically truthful; false when a chain exists but points at the wrong
   * design element / test. Undefined when no matrix / chain was available, in
   * which case aggregation falls back to has_test_alignment.
   */
  trace_chain_truthful?: boolean;
  /**
   * Free-text reason from {@link checkContradiction}, persisted EVEN when
   * `contradicts === false` so the report can audit why the check passed
   * (and reveal fail-open silent misses). Undefined when the contradiction
   * step did not run (no design evidence to contradict against).
   */
  contradiction_reason?: string;
  /**
   * Free-text reason from {@link judgeTraceChain}. Undefined when no matrix /
   * chain was available (the trace-chain step did not run).
   */
  chain_reason?: string;
}

/** Four booleans the aggregation uses to map verdicts → sub-scores. */
export interface ScoreBasis {
  has_concrete_rule: boolean;
  has_trigger_condition: boolean;
  has_handling_behavior: boolean;
  has_test_alignment: boolean;
}

// ---------------------------------------------------------------------------
// Prompt construction (rubric 铁律 hardcoded)
// ---------------------------------------------------------------------------

/**
 * Build the single-call judge prompt for one obligation. The prompt hardcodes
 * the rubric 铁律, the verbatim-evidence extraction requirement, the
 * anti-patterns to reject, and the exact JSON output shape.
 */
export function buildJudgePrompt(params: {
  obligation: GoldObligation;
  source_language: string;
  requirement_source: string;
  design: string;
  tests: string;
}): string {
  const { obligation, source_language, requirement_source, design, tests } = params;
  const ob = obligation;

  const lines: string[] = [];
  lines.push("You are a STRICT evidence-based evaluator for a software design + test artifact set.");
  lines.push("You evaluate ONE obligation. You may ONLY justify a score with text you LITERALLY");
  lines.push("copied (verbatim excerpt) from the DESIGN or TESTS — never paraphrase, never infer,");
  lines.push("never invent. If you cannot find a verbatim excerpt, the evidence is MISSING.");
  lines.push("");
  lines.push("## The obligation (ground truth, from the original requirement)");
  lines.push(`- id: ${ob.id}`);
  lines.push(`- type: ${ob.type}   severity: ${ob.severity}`);
  lines.push(`- source_span (original requirement, language=${source_language}):`);
  lines.push(indent(ob.source_span, "    "));
  lines.push("- expected_design_evidence (the DESIGN must express these points):");
  for (const e of ob.expected_design_evidence) lines.push(`    - ${e}`);
  lines.push("- expected_test_evidence (the TESTS must express these points):");
  for (const e of ob.expected_test_evidence) lines.push(`    - ${e}`);
  lines.push("- anti_patterns (these LOOK like coverage but MUST be scored low):");
  for (const a of ob.anti_patterns) lines.push(`    - ${a}`);
  lines.push("");
  lines.push("## Original requirement (for context only — do NOT score the requirement itself)");
  lines.push(indent(truncate(requirement_source, 4000), "    "));
  lines.push("");
  lines.push("## DESIGN artifact (excerpt verbatim evidence from HERE)");
  lines.push(indent(extractDesignSliceForObligation(design, ob), "    "));
  lines.push("");
  lines.push("## TESTS artifact (excerpt verbatim evidence from HERE)");
  lines.push(indent(extractTestsSliceForObligation(tests, ob), "    "));
  lines.push("");
  lines.push("## Rubric (HARD RULES — violating them is an invalid judgment)");
  lines.push("- Score 0: NO relevant verbatim evidence found in design OR tests.");
  lines.push("- Score 1: ONLY an ID / keyword / requirement restatement appears, or a vague phrase");
  lines.push("  like 'needs handling' / 'needs validation' with no concrete rule. AT MOST 1.");
  lines.push("- Score 2: DESIGN has a CONCRETE testable rule (a discernible trigger condition OR");
  lines.push("  handling behavior, enough to write an assertion), but tests are not aligned, OR an");
  lines.push("  exception path is missing, OR a boundary is thin, OR trace is incomplete.");
  lines.push("- Score 3: DESIGN has a concrete rule + trigger condition + handling behavior AND the");
  lines.push("  TESTS have a semantically aligned, checkable assertion for it.");
  lines.push("");
  lines.push("## Hard constraints (anti self-hype — breaking any is invalid)");
  lines.push("1. If you found no verbatim evidence ⇒ score MUST be 0.");
  lines.push("2. If only an ID/keyword/trace-link appears (no concrete rule) ⇒ score AT MOST 1.");
  lines.push("3. If there is no testable design rule (no concrete trigger/handling) ⇒ NOT 2 or 3.");
  lines.push("4. If there is no test alignment (tests do not assert this obligation) ⇒ NOT 3.");
  lines.push("5. You MUST NOT use overall impression to fill in missing design.");
  lines.push("6. A judgment with no verbatim excerpt backing it is INVALID.");
  lines.push("7. Evidence MUST be a verbatim excerpt from the artifacts, never invented.");
  lines.push("8. If the design states a rule that CONTRADICTS the obligation (e.g. obligation says");
  lines.push("   'antibiotics require chief-physician review' but the design says 'antibiotics need");
  lines.push("   no review'), that is a WRONG decision ⇒ score AT MOST 1 (the rule is not correct).");
  lines.push("");
  lines.push("## Output — JSON only, no prose, exactly this shape:");
  lines.push("{");
  lines.push('  "extracted_design_evidence": ["<verbatim excerpt from DESIGN>", ...],');
  lines.push('  "extracted_test_evidence": ["<verbatim excerpt from TESTS>", ...],');
  lines.push('  "missing_evidence": ["<expected point with no verbatim excerpt>", ...],');
  lines.push('  "score": 0|1|2|3,');
  lines.push('  "score_basis": {');
  lines.push('    "has_concrete_rule": <true iff DESIGN states a concrete rule for this obligation>,');
  lines.push('    "has_trigger_condition": <true iff a concrete trigger condition is stated>,');
  lines.push('    "has_handling_behavior": <true iff a concrete handling behavior is stated>,');
  lines.push('    "has_test_alignment": <true iff TESTS assert this obligation with a checkable outcome>');
  lines.push("  },");
  lines.push('  "reason": "<one or two sentences citing the excerpts>"');
  lines.push("}");
  return lines.join("\n");
}

const JUDGE_SYSTEM =
  "You are a strict, skeptical evaluator. You quote evidence verbatim and apply " +
  "the rubric literally. You never give credit for impression or for an ID without a " +
  "concrete rule. Respond with JSON only.";

/** Truncate a long artifact to fit the prompt, keeping head + tail. */
function truncate(text: string, max: number): string {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  return `${s.slice(0, head)}\n...[truncated ${s.length - max} chars]...\n${s.slice(-Math.floor(max * 0.3))}`;
}

/**
 * The window (±N lines) extracted around each matched needle when slicing an
 * artifact (design or tests) for one obligation.
 */
const SLICE_WINDOW = 10;

/**
 * Shared core of {@link extractDesignSliceForObligation} /
 * {@link extractTestsSliceForObligation}.
 *
 * Unlike {@link truncate} (head+tail), this locates the obligation's anchors
 * — its id (and dash-stripped / generated-matrix variants like `C_RULE_001`),
 * its `source_span`, and every entry of the chosen `evidenceField` — inside
 * `artifactText` and lifts a ±{@link SLICE_WINDOW}-line window around each
 * hit. Windows are merged/deduped so overlapping regions appear once. Returns
 * `""` when nothing matches (an empty DESIGN/TESTS section ⇒ the judge scores
 * it low, which is the desired honest signal for a missing rule).
 *
 * Needles are normalized the same way as {@link textOverlaps} (lower-cased,
 * non letter/digit runs collapsed) so spacing/punctuation differences do not
 * hide a match; distinctive substrings (CJK + digit runs like "30分钟", "99件",
 * "50") are pulled out of longer evidence strings to avoid losing a match
 * when only part of the evidence is quoted verbatim in the artifact.
 *
 * @param artifactText  the full artifact text (design or tests)
 * @param obligation    the obligation to slice for
 * @param evidenceField which evidence list to use as anchors
 * @param label         window boundary label ("design" / "tests")
 * @returns the merged slice, or `""` when no anchor matched
 */
function extractSliceForObligation(
  artifactText: string,
  obligation: GoldObligation,
  evidenceField: "expected_design_evidence" | "expected_test_evidence",
  label: "design" | "tests",
): string {
  const text = String(artifactText ?? "");
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length === 0) return "";

  // Normalize the same way as textOverlaps: lowercase + drop non letter/digit
  // runs. Matching is done against the normalized artifact so spacing/case do
  // not hide a verbatim quote.
  const norm = (s: string): string =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  const normLines = lines.map(norm);

  // Collect distinctive needles from the obligation. A needle must be at least
  // 3 chars after normalization (filters out noise like single digits / "id").
  const minNeedle = 3;
  const needles = new Set<string>();
  const addNeedle = (raw: string): void => {
    const n = norm(raw);
    if (n.length >= minNeedle) needles.add(n);
  };

  // (a) Obligation id + variants. Gold ids look like "C-001" / "F-NNN" /
  // "X-001"; generated matrices use dash-less ("C001") or rule-style
  // ("C_RULE_001"). Generate all of these forms.
  const id = String(obligation.id ?? "");
  if (id) {
    addNeedle(id); // "C-001"
    addNeedle(id.replace(/-/g, "")); // "C001"
    // "C001" -> "C_RULE_001" / "C-001" -> "C_RULE_001"
    const digits = id.match(/\d+/)?.[0];
    const letter = id.match(/^[A-Za-z]+/)?.[0];
    if (digits && letter) addNeedle(`${letter}_RULE_${digits}`);
  }

  // (b) source_span (verbatim requirement excerpt — the strongest anchor).
  addNeedle(obligation.source_span);

  // (c) Each entry of the chosen evidence list. These may be longer than what
  // the artifact quotes verbatim, so also extract their distinctive substrings
  // (runs of CJK letters and/or digits like "30分钟", "99件", "50") so a
  // partial verbatim quote still anchors a window.
  const distinctive = (raw: string): string[] => {
    return String(raw ?? "")
      .match(/[\p{L}]*\p{Script=Han}[\p{L}]*|\d+/gu) ?? [];
  };
  for (const ev of obligation[evidenceField]) {
    addNeedle(ev);
    for (const frag of distinctive(ev)) addNeedle(frag);
  }

  if (needles.size === 0) return "";

  // Locate each needle inside the (normalized) artifact lines and record the
  // ±WINDOW window around every hit. A needle may match multiple lines.
  const windows: Array<[number, number]> = [];
  for (const needle of needles) {
    for (let i = 0; i < normLines.length; i++) {
      if (normLines[i].includes(needle)) {
        const start = Math.max(0, i - SLICE_WINDOW);
        const end = Math.min(lines.length - 1, i + SLICE_WINDOW);
        windows.push([start, end]);
      }
    }
  }

  if (windows.length === 0) return "";

  // Merge overlapping/adjacent windows (sort by start, then coalesce).
  windows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of windows) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  // Emit each merged window with a clear boundary marker (so the judge can
  // still tell it is an excerpt, not the whole artifact). Joined with blanks.
  const slices: string[] = [];
  for (const [start, end] of merged) {
    slices.push(
      `...[${label} lines ${start + 1}-${end + 1}]...\n${lines.slice(start, end + 1).join("\n")}`,
    );
  }
  return slices.join("\n\n");
}

/**
 * Extract the slice of `designText` that is relevant to ONE obligation.
 * Delegates to {@link extractSliceForObligation} with the design evidence
 * anchors. See that helper for the windowing/normalization details.
 */
export function extractDesignSliceForObligation(
  designText: string,
  obligation: GoldObligation,
): string {
  return extractSliceForObligation(designText, obligation, "expected_design_evidence", "design");
}

/**
 * Extract the slice of `testsText` that is relevant to ONE obligation.
 *
 * Mirrors {@link extractDesignSliceForObligation} but anchors on
 * `expected_test_evidence` (plus the obligation id variants and source_span).
 * This replaces the old `truncate(tests, 6000)` head+tail cut in
 * {@link buildJudgePrompt}: a long test-cases file (e.g. 16k+ chars, 37
 * cases) used to be chopped to its head+tail so the middle cases — often the
 * ones relevant to this obligation — were dropped, capping
 * `has_test_alignment`. Slicing lifts ±{@link SLICE_WINDOW}-line windows
 * around each anchor so the relevant test cases survive regardless of where
 * they sit in the file. Returns `""` when nothing matches.
 *
 * @param testsText   the full tests artifact text
 * @param obligation  the obligation to slice for
 * @returns the merged tests slice, or `""` when no anchor matched
 */
export function extractTestsSliceForObligation(
  testsText: string,
  obligation: GoldObligation,
): string {
  return extractSliceForObligation(testsText, obligation, "expected_test_evidence", "tests");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Output parsing + rubric enforcement (code-side, anti self-hype)
// ---------------------------------------------------------------------------

/**
 * Parse + RUBRIC-ENFORCE a raw LLM verdict into a safe {@link ObligationVerdict}.
 *
 * The code re-derives `score_basis` defaults (unknown ⇒ false, strict) and then
 * FORCES the score to obey the 铁律 regardless of what the LLM emitted:
 *   - no verbatim evidence (both evidence lists empty) ⇒ 0
 *   - no concrete rule (`has_concrete_rule === false`) ⇒ ≤ 1
 *   - score 3 without test alignment ⇒ 2
 *   - clamp to [0,3]
 *
 * This is the second line of defense: even if the prompt is ignored, the score
 * cannot exceed what the evidence supports.
 */
export function enforceRubric(
  obligation: GoldObligation,
  raw: Record<string, unknown>,
  flags?: { has_contradiction?: boolean },
): ObligationVerdict {
  const extracted_design_evidence = readStringArray(raw.extracted_design_evidence);
  const extracted_test_evidence = readStringArray(raw.extracted_test_evidence);
  const missing_evidence = readStringArray(raw.missing_evidence);
  const basis = readScoreBasis(raw.score_basis);
  const reason = typeof raw.reason === "string" ? raw.reason : "";

  let rawScore = typeof raw.score === "number" ? raw.score : Number(raw.score);
  if (!Number.isFinite(rawScore)) rawScore = 0;
  let score = clampScore(rawScore);
  const originalScore = score;

  // 铁律 1: no verbatim evidence at all ⇒ 0.
  if (extracted_design_evidence.length === 0 && extracted_test_evidence.length === 0) {
    score = 0;
  }

  // 铁律 2/3: no testable design rule ⇒ at most 1 (covers ID-only / keyword-only).
  if (!basis.has_concrete_rule && score > 1) {
    score = 1;
  }

  // 铁律 4: no test alignment ⇒ not 3.
  if (score >= 3 && !basis.has_test_alignment) {
    score = 2;
  }

  // Defense-in-depth: score 3 also requires SOME test evidence excerpt.
  if (score >= 3 && extracted_test_evidence.length === 0) {
    score = 2;
  }

  // 铁律 5 (Phase 2.5 — code-side contradiction clamp): if an independent
  // contradiction check decided the design states the OPPOSITE of the
  // obligation (anti_pattern hit), the rule is WRONG and the score is clamped
  // to ≤ 1 regardless of how concrete the (wrong) rule looks. This is the
  // code-side guarantee that a wrong-but-testable rule cannot earn 2/3.
  const has_contradiction = flags?.has_contradiction === true;
  if (has_contradiction && score > 1) {
    score = 1;
  }

  const rubric_downgraded = score < originalScore;
  return {
    obligation_id: obligation.id,
    extracted_design_evidence,
    extracted_test_evidence,
    missing_evidence,
    score,
    score_basis: basis,
    reason,
    rubric_downgraded,
    has_contradiction: has_contradiction ? true : undefined,
  };
}

function readStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : String(x ?? ""))).map((s) => s.trim()).filter(Boolean);
}

function readScoreBasis(v: unknown): ScoreBasis {
  if (!v || typeof v !== "object") {
    return {
      has_concrete_rule: false,
      has_trigger_condition: false,
      has_handling_behavior: false,
      has_test_alignment: false,
    };
  }
  const r = v as Record<string, unknown>;
  // Unknown / missing flags default to false (strict) — see openIssues in plan.
  return {
    has_concrete_rule: r.has_concrete_rule === true,
    has_trigger_condition: r.has_trigger_condition === true,
    has_handling_behavior: r.has_handling_behavior === true,
    has_test_alignment: r.has_test_alignment === true,
  };
}

function clampScore(n: number): 0 | 1 | 2 | 3 {
  const i = Math.round(n);
  if (i <= 0) return 0;
  if (i >= 3) return 3;
  return i as 0 | 1 | 2 | 3;
}

// ---------------------------------------------------------------------------
// Phase 2.5 — Contradiction check (weakness 1: wrong-but-testable rules)
// ---------------------------------------------------------------------------

/** Result of {@link checkContradiction}. */
export interface ContradictionResult {
  /** True when the design states a rule that is the OPPOSITE of the obligation. */
  contradicts: boolean;
  /** Verbatim design evidence that contradicts the obligation (for audit). */
  contradicting_evidence: string[];
  /** Reason the LLM gave (for audit only). */
  reason: string;
}

/**
 * Build the SECOND, independent contradiction-check prompt. Unlike the main
 * judge prompt, this one is ONLY about one question: does the design's stated
 * rule match or contradict the obligation's expected evidence / hit an
 * anti_pattern? Keeping it separate means a convincing-looking "there is a
 * concrete rule" verdict in the first call cannot drown out the contradiction.
 */
export function buildContradictionPrompt(params: {
  obligation: GoldObligation;
  source_language: string;
  designEvidence: string[];
  designText: string;
}): string {
  const { obligation, source_language, designEvidence, designText } = params;
  const ob = obligation;
  const lines: string[] = [];
  lines.push("You are a contradiction auditor. You answer ONE question only:");
  lines.push("does the DESIGN state a rule that is the OPPOSITE of (contradicts)");
  lines.push("this obligation, or that matches one of its anti_patterns?");
  lines.push("");
  lines.push("## The obligation (ground truth)");
  lines.push(`- id: ${ob.id}   (source language=${source_language})`);
  lines.push(`- source_span: ${ob.source_span}`);
  lines.push("- expected_design_evidence (the design MUST express THESE): ");
  for (const e of ob.expected_design_evidence) lines.push(`    - ${e}`);
  lines.push("- anti_patterns (if the design matches one of these, it contradicts):");
  for (const a of ob.anti_patterns) lines.push(`    - ${a}`);
  lines.push("");
  lines.push("## Design evidence already lifted from the design doc");
  if (designEvidence.length === 0) {
    lines.push("(none — answer contradicts=false)");
  } else {
    for (const e of designEvidence) lines.push(`    - ${e}`);
  }
  lines.push("");
  lines.push("## Full DESIGN text (for context)");
  lines.push(indent(truncate(designText, 4000), "    "));
  lines.push("");
  lines.push("## Decision rules");
  lines.push("- contradicts=true ONLY when the design states a rule whose DIRECTION is");
  lines.push("  the opposite of the obligation (e.g. obligation 'antibiotics require");
  lines.push("  chief-physician review' but design 'antibiotics need no review'), OR");
  lines.push("  when the design matches an anti_pattern verbatim/near-verbatim.");
  lines.push("- A MISSING rule, a vague rule, or a weaker rule is NOT a contradiction");
  lines.push("  (those are handled by the main judge). contradicts=false in those cases.");
  lines.push("- Quote the contradicting design text verbatim in contradicting_evidence.");
  lines.push("");
  lines.push('## Output — JSON only, exactly:');
  lines.push('{');
  lines.push('  "contradicts": <true|false>,');
  lines.push('  "contradicting_evidence": ["<verbatim design excerpt>", ...],');
  lines.push('  "reason": "<one sentence>"');
  lines.push('}');
  return lines.join("\n");
}

const CONTRADICTION_SYSTEM =
  "You are a strict contradiction auditor for software design. You answer only " +
  "whether a stated design rule reverses the obligation's meaning or matches an " +
  "anti_pattern. Missing/weak rules are NOT contradictions. Respond JSON only.";

/**
 * Run the independent contradiction check. Never throws — an LLM failure is
 * treated as `contradicts=false` (fail-open for the auditor, the main judge +
 * code clamp remain the floor).
 */
export async function checkContradiction(
  client: JudgeClient,
  params: {
    obligation: GoldObligation;
    source_language: string;
    designEvidence: string[];
    designText: string;
  },
): Promise<ContradictionResult> {
  const prompt = buildContradictionPrompt(params);
  let raw: Record<string, unknown> = {};
  try {
    raw = (await client.generateJson(prompt, CONTRADICTION_SYSTEM)) ?? {};
  } catch {
    raw = {};
  }
  const contradicts = raw.contradicts === true;
  return {
    contradicts,
    contradicting_evidence: readStringArray(raw.contradicting_evidence),
    reason: typeof raw.reason === "string" ? raw.reason : "",
  };
}

// ---------------------------------------------------------------------------
// Phase 2.5 — Trace-chain truthfulness (weakness 2: fake traceability)
// ---------------------------------------------------------------------------

/**
 * A single constraint→design→test chain extracted from a traceability matrix,
 * described by text so the LLM can judge semantic truth without ID mapping.
 */
export interface TraceChain {
  /** Constraint description text (gold source_span for gold-mapped obligations). */
  constraint_description: string;
  /** Design element(s) the matrix claims implement this constraint. */
  design_element: string;
  /** Test id(s) the matrix claims test this constraint. */
  test_id: string;
}

/** Result of {@link judgeTraceChain}. */
export interface TraceChainVerdict {
  /** True when the chain (constraint→design→test) is semantically truthful. */
  chain_truthful: boolean;
  /** Reason (for audit only). */
  reason: string;
}

/**
 * Build the trace-chain truthfulness prompt. Asks the LLM to verify that, for
 * each chain the matrix asserts, (a) the mapped design element really implements
 * the constraint (not just an ID link) and (b) the mapped test really tests the
 * constraint (not a target/assertion mismatch). M2's fake traceability (chain
 * exists but points at the wrong element/test) must be caught here.
 */
export function buildTraceChainPrompt(params: {
  obligation: GoldObligation;
  source_language: string;
  chains: TraceChain[];
  designText: string;
  tests: string;
}): string {
  const { obligation, source_language, chains, designText, tests } = params;
  const ob = obligation;
  const lines: string[] = [];
  lines.push("You are a traceability-truthfulness auditor. The artifact set includes a");
  lines.push("traceability matrix that maps this obligation to design elements and tests.");
  lines.push("Your job: decide whether each claimed chain is SEMANTICALLY true, not just");
  lines.push("whether a mapping entry exists.");
  lines.push("");
  lines.push("## The obligation (ground truth)");
  lines.push(`- id: ${ob.id}   (source language=${source_language})`);
  lines.push(`- source_span: ${ob.source_span}`);
  lines.push("- expected_design_evidence: ");
  for (const e of ob.expected_design_evidence) lines.push(`    - ${e}`);
  lines.push("- expected_test_evidence: ");
  for (const e of ob.expected_test_evidence) lines.push(`    - ${e}`);
  lines.push("");
  lines.push("## Claimed traceability chains for this obligation");
  if (chains.length === 0) {
    lines.push("(no chain mapped — answer chain_truthful=false)");
  } else {
    for (let i = 0; i < chains.length; i++) {
      const c = chains[i];
      lines.push(`  chain ${i + 1}:`);
      lines.push(`    constraint: ${c.constraint_description}`);
      lines.push(`    -> design element: ${c.design_element}`);
      lines.push(`    -> test id: ${c.test_id}`);
    }
  }
  lines.push("");
  lines.push("## DESIGN text (verify the design element really implements the constraint)");
  lines.push(indent(truncate(designText, 4000), "    "));
  lines.push("");
  lines.push("## TESTS text (verify the test id really tests this constraint)");
  lines.push(indent(truncate(tests, 4000), "    "));
  lines.push("");
  lines.push("## Decision rules");
  lines.push("- chain_truthful=true ONLY when the design element genuinely implements");
  lines.push("  the constraint's behavior AND the cited test genuinely asserts that");
  lines.push("  behavior (target matches the constraint, expected_result asserts it).");
  lines.push("- chain_truthful=false when the chain exists but is semantically wrong:");
  lines.push("  the design element only mentions an ID, or the test asserts something");
  lines.push("  unrelated (e.g. claims to test allergy blocking but asserts audit-log).");
  lines.push("- If multiple chains are claimed, ALL must be true for chain_truthful=true.");
  lines.push("");
  lines.push('## Output — JSON only, exactly:');
  lines.push('{');
  lines.push('  "chain_truthful": <true|false>,');
  lines.push('  "reason": "<one sentence citing which chain/element/test is wrong>"');
  lines.push('}');
  return lines.join("\n");
}

const TRACE_CHAIN_SYSTEM =
  "You are a strict traceability auditor. You verify that each claimed " +
  "constraint→design→test chain is semantically true, not merely present. " +
  "An ID-only link or a target/assertion mismatch is NOT truthful. Respond JSON only.";

/**
 * Judge trace-chain truthfulness for one obligation. Never throws — an LLM
 * failure is treated as `chain_truthful=true` (fail-open: the main judge's
 * has_test_alignment and other rules remain the floor; we only *add* the ability
 * to flag a fake chain as untruthful).
 */
export async function judgeTraceChain(
  client: JudgeClient,
  params: {
    obligation: GoldObligation;
    source_language: string;
    chains: TraceChain[];
    designText: string;
    tests: string;
  },
): Promise<TraceChainVerdict> {
  const prompt = buildTraceChainPrompt(params);
  let raw: Record<string, unknown> = {};
  try {
    raw = (await client.generateJson(prompt, TRACE_CHAIN_SYSTEM)) ?? {};
  } catch {
    raw = {};
  }
  return {
    chain_truthful: raw.chain_truthful !== false,
    reason: typeof raw.reason === "string" ? raw.reason : "",
  };
}

// ---------------------------------------------------------------------------
// Single-obligation judging (LLM call) + Phase 2.5 two-step checks
// ---------------------------------------------------------------------------

/** Optional matrix + chains passed to {@link judgeObligation}. */
export interface ObligationMatrixInput {
  /** Chains for THIS obligation extracted from a traceability matrix (if any). */
  chains?: TraceChain[];
}

/**
 * Judge one obligation against design + tests via the LLM. Always returns a
 * rubric-enforced verdict; never throws (an LLM failure degrades to score 0).
 *
 * Phase 2.5 two-step checks (both GATED so existing 2-call tests stay green):
 *   - contradiction check runs ONLY when the main judge lifted design evidence
 *     (nothing to contradict against otherwise) — adds a second LLM call.
 *   - trace-chain check runs ONLY when a matrix with chains for this obligation
 *     was supplied — adds a third LLM call.
 */
export async function judgeObligation(
  client: JudgeClient,
  params: {
    obligation: GoldObligation;
    source_language: string;
    requirement_source: string;
    design: string;
    tests: string;
    matrix?: ObligationMatrixInput;
  },
): Promise<ObligationVerdict> {
  const prompt = buildJudgePrompt(params);
  let raw: Record<string, unknown> = {};
  try {
    raw = (await client.generateJson(prompt, JUDGE_SYSTEM)) ?? {};
  } catch {
    raw = {};
  }

  // First parse + enforce the base rubric so the hard rules (0 evidence ⇒ 0,
  // no rule ⇒ ≤1) always apply regardless of the two-step checks below.
  const verdict = enforceRubric(params.obligation, raw);

  // --- Step 2a: contradiction check (weakness 1) ---------------------------
  // Only run when the main judge actually lifted design evidence for this
  // obligation — there is nothing to contradict against when the design says
  // nothing. This gate also preserves the existing `calls === 2` contract for
  // judgeAgainstGold when artifacts are empty.
  if (verdict.extracted_design_evidence.length > 0) {
    const contradiction = await checkContradiction(client, {
      obligation: params.obligation,
      source_language: params.source_language,
      designEvidence: verdict.extracted_design_evidence,
      designText: params.design,
    });
    // Persist the reason regardless of outcome so the report can show WHY
    // the check passed/failed-open (and surface silent fail-open misses).
    verdict.contradiction_reason = contradiction.reason;
    if (contradiction.contradicts) {
      // Re-enforce with the contradiction flag so the code-side clamp (≤1)
      // applies. This is the code-side guarantee, not just the prompt.
      const reenforced = enforceRubric(params.obligation, raw, {
        has_contradiction: true,
      });
      reenforced.has_contradiction = true;
      reenforced.contradiction_reason = contradiction.reason;
      return reenforced;
    }
  }

  // --- Step 2b: trace-chain truthfulness (weakness 2) ----------------------
  // Only run when a matrix with chains for this obligation was supplied.
  const chains = params.matrix?.chains;
  if (chains && chains.length > 0) {
    const traceVerdict = await judgeTraceChain(client, {
      obligation: params.obligation,
      source_language: params.source_language,
      chains,
      designText: params.design,
      tests: params.tests,
    });
    verdict.trace_chain_truthful = traceVerdict.chain_truthful;
    verdict.chain_reason = traceVerdict.reason;
  }

  return verdict;
}

// ---------------------------------------------------------------------------
// Aggregation → QualityScores (0..100)
// ---------------------------------------------------------------------------

/** Documented weights for the final aggregate (see plan openIssues). */
export const FINAL_SCORE_WEIGHTS = {
  gold_obligation_coverage: 0.4,
  traceability_truthfulness: 0.2,
  test_effectiveness: 0.2,
  design_depth: 0.2,
} as const;

/**
 * Aggregate per-obligation verdicts into the four Phase-2 sub-scores (0..100)
 * + weighted final_score.
 *
 *   - gold_obligation_coverage : mean(score/3) over all obligations.
 *                                Hits M1 (shallow, low scores) & M5 (wrong).
 *   - design_depth             : mean of the design-basis coverage
 *                                (concrete_rule + trigger + handling) / 3.
 *                                Hits M3 (missing exception ⇒ no handling).
 *   - test_effectiveness       : fraction of obligations with test alignment.
 *                                Hits M4 (hallucinated assertion).
 *   - traceability_truthfulness: when a traceability matrix was judged,
 *                                fraction of judged chains that are
 *                                semantically truthful (constraint→design→test
 *                                all match). Without a matrix, falls back to
 *                                the fraction of rule-bearing obligations whose
 *                                tests align. Hits M2 (fake trace: chain exists
 *                                but points at the wrong element/test).
 */
export function aggregateQuality(verdicts: ObligationVerdict[]): QualityScores {
  if (verdicts.length === 0) {
    return {
      gold_obligation_coverage: null,
      traceability_truthfulness: null,
      test_effectiveness: null,
      design_depth: null,
      final_score: null,
    };
  }
  const n = verdicts.length;
  const round1 = (x: number): number => Math.round(x * 10) / 10;

  const coverage = round1(
    (verdicts.reduce((a, v) => a + v.score, 0) / (3 * n)) * 100,
  );

  const designDepth = round1(
    (verdicts.reduce((a, v) => {
      const b = v.score_basis;
      const filled = (b.has_concrete_rule ? 1 : 0) + (b.has_trigger_condition ? 1 : 0) + (b.has_handling_behavior ? 1 : 0);
      return a + filled / 3;
    }, 0) / n) * 100,
  );

  const testEffectiveness = round1(
    (verdicts.reduce((a, v) => a + (v.score_basis.has_test_alignment ? 1 : 0), 0) / n) * 100,
  );

  // Phase 2.5 (weakness 2): traceability_truthfulness now prefers the
  // semantic chain truthfulness (trace_chain_truthful) when any verdict
  // produced one — i.e. a traceability matrix was fed in. When NO verdict has
  // a chain verdict (no matrix supplied), we fall back to the legacy formula
  // (fraction of rule-bearing obligations whose tests align) so clean
  // baselines and matrix-less tests stay green.
  const withRule = verdicts.filter((v) => v.score_basis.has_concrete_rule);
  const anyChainVerdict = verdicts.some((v) => v.trace_chain_truthful !== undefined);
  let traceability: number;
  if (anyChainVerdict) {
    // Per-verdict truthfulness: a verdict with a rule is truthful iff its
    // chain is truthful (when judged) OR its tests align (no chain judged).
    // A verdict with NO rule contributes nothing to the numerator but still
    // counts in the denominator when it had a chain judged (it was claimed
    // covered yet has no real rule → untruthful).
    const judged = verdicts.filter((v) => v.trace_chain_truthful !== undefined);
    traceability =
      judged.length === 0
        ? 0
        : round1(
            (judged.reduce((a, v) => a + (v.trace_chain_truthful ? 1 : 0), 0) /
              judged.length) *
              100,
          );
  } else {
    traceability =
      withRule.length === 0
        ? 0
        : round1(
            (withRule.reduce((a, v) => a + (v.score_basis.has_test_alignment ? 1 : 0), 0) /
              withRule.length) *
              100,
          );
  }

  const final = round1(
    coverage * FINAL_SCORE_WEIGHTS.gold_obligation_coverage +
      traceability * FINAL_SCORE_WEIGHTS.traceability_truthfulness +
      testEffectiveness * FINAL_SCORE_WEIGHTS.test_effectiveness +
      designDepth * FINAL_SCORE_WEIGHTS.design_depth,
  );

  return {
    gold_obligation_coverage: coverage,
    traceability_truthfulness: traceability,
    test_effectiveness: testEffectiveness,
    design_depth: designDepth,
    final_score: final,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator: judge a whole case against its gold contract
// ---------------------------------------------------------------------------

/** Read a text/json artifact file as a string (empty string if absent). */
function readArtifactText(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Read + parse a JSON artifact file (null if absent or unparseable). */
function readArtifactJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Extract {@link TraceChain}s for one obligation from a traceability matrix.
 *
 * The matrix may use either gold obligation ids (C-001/F-005/X-001) OR
 * generated display ids (C014/F005/X001). We match by BOTH: an obligation's
 * chains come from any matrix entry whose key (display or canonical form)
 * maps to this obligation id, AND whose constraint text semantically relates
 * to the obligation's source_span. Matching is intentionally loose on ids
 * (they may differ between gold and generated matrices) and relies on the
 * LLM judge to verify semantic truth.
 *
 * The matrix carries THREE parallel bucket pairs — constraint/function/
 * exception `*ToDesign` + `*ToTests`. Which pair a given obligation reads is
 * decided by its `type` (constraint→constraint maps, functional→function maps,
 * exception→exception maps), so functional/exception obligations no longer get
 * empty chains (and thus zero traceability). Only `constraintDescriptions` is
 * populated by the matrix builder today; function/exception chains fall back
 * to `obligation.source_span` for the human description (same fallback the
 * constraint path already used).
 */
export function extractChainsForObligation(
  obligation: GoldObligation,
  matrix: Record<string, unknown> | null,
): TraceChain[] {
  if (!matrix) return [];
  const chains: TraceChain[] = [];

  // Select the bucket-appropriate (ToDesign, ToTests) maps for THIS
  // obligation type. constraintToDesign/constraintToTests also accept the
  // legacy `constraint_design`/`constraint_tests` aliases (carried by the
  // mutant's fake matrix).
  const constraintToDesign = (matrix.constraintToDesign ?? matrix.constraint_design ?? {}) as Record<string, string[]>;
  const constraintToTests = (matrix.constraintToTests ?? matrix.constraint_tests ?? {}) as Record<string, string[]>;
  const functionToDesign = (matrix.functionToDesign ?? {}) as Record<string, string[]>;
  const functionToTests = (matrix.functionToTests ?? {}) as Record<string, string[]>;
  const exceptionToDesign = (matrix.exceptionToDesign ?? {}) as Record<string, string[]>;
  const exceptionToTests = (matrix.exceptionToTests ?? {}) as Record<string, string[]>;

  let toDesign: Record<string, string[]>;
  let toTests: Record<string, string[]>;
  if (obligation.type === "functional") {
    toDesign = functionToDesign;
    toTests = functionToTests;
  } else if (obligation.type === "exception") {
    toDesign = exceptionToDesign;
    toTests = exceptionToTests;
  } else {
    toDesign = constraintToDesign;
    toTests = constraintToTests;
  }

  // Optional text descriptions for semantic matching (carried by the mutant's
  // fake matrix): constraintId → human description. Only the constraint bucket
  // populates this today; function/exception use source_span as the fallback.
  const constraintDescriptions = (matrix.constraintDescriptions ?? {}) as Record<string, string>;

  // Build the set of keys that map to THIS obligation. Gold obligations use
  // ids like "C-001"; generated matrices use display ids like "C014". We accept
  // the obligation id directly, plus a normalized id with no dash.
  const obId = obligation.id;
  const normalizedObId = obId.replace(/-/g, "");
  const candidateKeys = new Set<string>([obId, normalizedObId]);
  // Also accept keys whose stored description matches the obligation source.
  for (const [key, desc] of Object.entries(constraintDescriptions)) {
    if (desc && textOverlaps(desc, obligation.source_span)) {
      candidateKeys.add(key);
    }
  }

  for (const key of candidateKeys) {
    const designElements = toDesign[key];
    const testIds = toTests[key];
    const description = constraintDescriptions[key] ?? obligation.source_span;
    const designElement = Array.isArray(designElements) ? designElements.join(", ") : "";
    const testId = Array.isArray(testIds) ? testIds.join(", ") : "";
    if (designElement || testId) {
      chains.push({ constraint_description: description, design_element: designElement, test_id: testId });
    }
  }
  return chains;
}

/** Loose text overlap: true when any 4+ char run of a appears in b (case-folded). */
function textOverlaps(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const na = norm(a);
  const nb = norm(b);
  if (na.length < 4 || nb.length < 4) return false;
  for (let i = 0; i + 4 <= na.length; i++) {
    if (nb.includes(na.slice(i, i + 4))) return true;
  }
  return false;
}

/**
 * Judge a whole case: read design + tests from disk, run the judge for every
 * gold obligation, and return `{ verdicts, quality }`. The LLM is called once
 * per obligation (plus the Phase 2.5 two-step checks when gated on).
 *
 * Never throws — an empty design/tests file degrades verdicts to score 0 and
 * yields an all-zero quality block (which is itself a useful, honest signal).
 *
 * Phase 2.5: an optional `matrixPath` (traceability_matrix.json) is read and
 * its chains are fed per-obligation to the trace-chain truthfulness check.
 */
export async function judgeAgainstGold(
  client: JudgeClient,
  gold: GoldContract,
  params: { requirement_source: string; designPath: string; testsPath: string; matrixPath?: string },
): Promise<{ verdicts: ObligationVerdict[]; quality: QualityScores }> {
  const design = readArtifactText(params.designPath);
  const tests = readArtifactText(params.testsPath);
  const matrix = params.matrixPath ? readArtifactJson(params.matrixPath) : null;

  const verdicts: ObligationVerdict[] = [];
  for (const obligation of gold.obligations) {
    const chains = extractChainsForObligation(obligation, matrix);
    verdicts.push(
      await judgeObligation(client, {
        obligation,
        source_language: gold.source_language,
        requirement_source: params.requirement_source,
        design,
        tests,
        matrix: chains.length > 0 ? { chains } : undefined,
      }),
    );
  }
  return { verdicts, quality: aggregateQuality(verdicts) };
}
