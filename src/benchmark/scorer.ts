/**
 * Benchmark scoring — hybrid design.
 *
 *   • Deterministic, language-agnostic scoring for things that are objectively
 *     checkable from the artifacts: diagram syntax, diagram structure, and
 *     cross-artifact consistency.
 *   • LLM-as-judge for semantic coverage (did the analysis cover the expected
 *     actors / functions / entities / constraints / exceptions / processes?),
 *     which is robust to paraphrase, synonyms and translation.
 *
 * The judge is injected as a `JudgeClient`, so scoring is fully unit-testable
 * offline with a mock and needs no network unless you actually run a case.
 */
import { MermaidValidator } from "../generators/mermaid.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoldLabel {
  expected_actors?: string[];
  expected_functions?: string[];
  expected_entities?: string[];
  expected_constraints?: string[];
  expected_exceptions?: string[];
  expected_processes?: string[];
}

export interface Scores {
  coverage: number;
  diagram_syntax: number;
  diagram_structure: number;
  consistency: number;
  overall: number;
}

export interface CategoryCoverage {
  category: string;
  expected: number;
  covered: number;
  missing: string[];
}

export interface BenchmarkCaseResult {
  case_name: string;
  status: string;
  passed?: boolean;
  scores?: Partial<Scores>;
  coverage_detail?: CategoryCoverage[];
  /** The system's own final-review gate (independent of our score). */
  review_passed?: boolean;
  /** Count of unresolved blocker/major issues from the system's review. */
  review_blockers?: number;
  /** Whether the runtime persisted final outputs successfully. */
  persisted?: boolean;
  /** Runtime quality status after final review/persistence. */
  quality_status?: string;
  /** Machine-readable reasons why a scored case did not pass. */
  gate_failures?: string[];
  error?: string;
}

/** Minimal LLM surface the coverage judge needs (LLMClient satisfies it). */
export interface JudgeClient {
  generateJson(prompt: string, system?: string): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const PASS_THRESHOLD = 80;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Pull display names from a heterogeneous list (strings or {name|description}). */
export function readNames(items: unknown, preferred = "name"): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        return String(rec[preferred] ?? rec.name ?? rec.description ?? "");
      }
      return String(item ?? "");
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Language-agnostic normalisation: lowercase, drop punctuation/space, keep
 *  alphanumerics and CJK. Used only for deterministic checks. */
function normalize(text: string): string {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizedIncludes(haystack: string, needle: string): boolean {
  const n = normalize(needle);
  return n.length > 0 && normalize(haystack).includes(n);
}

// ---------------------------------------------------------------------------
// Deterministic: diagram syntax
// ---------------------------------------------------------------------------

/** Percentage of present diagrams whose Mermaid source validates. */
export function scoreDiagramSyntax(diagrams: Record<string, unknown>): number {
  const entries = Object.entries(diagrams ?? {}).filter(
    ([, v]) => typeof v === "string" && v.trim(),
  );
  if (entries.length === 0) return 0;
  const validator = new MermaidValidator();
  let passed = 0;
  for (const [name, content] of entries) {
    if (validator.validate(content as string, name).valid) passed += 1;
  }
  return round1((passed / entries.length) * 100);
}

// ---------------------------------------------------------------------------
// Deterministic: diagram structure
// ---------------------------------------------------------------------------

/** Structural soundness of activity + state diagrams (start/end/branch/states),
 *  language-agnostic. Average of whichever diagrams are present. */
export function scoreDiagramStructure(diagrams: Record<string, unknown>): number {
  const parts: number[] = [];
  const activity = String(diagrams?.activity_diagram ?? "");
  const state = String(diagrams?.state_diagram ?? "");

  if (activity.trim()) parts.push(scoreActivityStructure(activity));
  if (state.trim()) parts.push(scoreStateStructure(state));

  if (parts.length === 0) return 0;
  return round1(parts.reduce((a, b) => a + b, 0) / parts.length);
}

function scoreActivityStructure(activity: string): number {
  let score = 0;
  const hasStart = /\[\*\]|\(\[|开始|start|begin/i.test(activity);
  const hasEnd = /\[\*\]|\]\)|结束|end|finish|stop/i.test(activity);
  const hasFlow = activity.includes("-->") || activity.includes("->");
  const hasBranch = /\{[^}]+\}|\|[^|]+\||decision/i.test(activity); // diamond/guard
  if (hasStart) score += 30;
  if (hasEnd) score += 30;
  if (hasFlow) score += 20;
  if (hasBranch) score += 20;
  return Math.min(100, score);
}

function scoreStateStructure(state: string): number {
  let score = 0;
  const hasInitial = state.includes("[*]") || /\binitial\b|开始|start/i.test(state);
  const hasTransition = state.includes("-->");
  const stateNames = new Set(
    [...state.matchAll(/(\S+)\s*-->\s*(\S+)/g)]
      .flatMap((m) => [m[1], m[2]])
      .filter((s) => s && s !== "[*]" && s.length > 1),
  );
  if (hasInitial) score += 35;
  if (hasTransition) score += 25;
  if (stateNames.size >= 3) score += 40;
  else if (stateNames.size >= 2) score += 25;
  return Math.min(100, score);
}

// ---------------------------------------------------------------------------
// Deterministic: cross-artifact consistency
// ---------------------------------------------------------------------------

/** True when text contains CJK characters (Chinese/Japanese/Korean). */
function hasCjk(text: string): boolean {
  return /[一-鿿㐀-䶿\u{20000}-\u{2a6df}]/u.test(text);
}

/** Do the entities identified in the analysis also appear in the class diagram
 *  (and core ones in the behavioural diagrams)? Pure structural check.
 *
 *  Cross-language note: when entity names are ASCII (English) but diagrams are
 *  written in Chinese, the behavioural-diagram check is skipped — the class
 *  diagram check already confirms structural coverage and the literal name
 *  will not appear in Chinese prose. */
export function scoreConsistency(
  result: Record<string, unknown>,
  diagrams: Record<string, unknown>,
): number {
  const entities = readNames(result?.entities);
  if (entities.length === 0) return 100;

  const classDiagram = String(diagrams?.class_diagram ?? "");
  const activity = String(diagrams?.activity_diagram ?? "");
  const state = String(diagrams?.state_diagram ?? "");

  let score = 100;
  for (const entity of entities) {
    if (!normalizedIncludes(classDiagram, entity)) score -= 10;
  }
  for (const core of entities.slice(0, 3)) {
    const coreIsAsciiOnly = Array.from(core).every(c => c.charCodeAt(0) < 128);
    if (activity && !normalizedIncludes(activity, core)) {
      if (!coreIsAsciiOnly || !hasCjk(activity)) score -= 5;
    }
    if (state && !normalizedIncludes(state, core)) {
      if (!coreIsAsciiOnly || !hasCjk(state)) score -= 3;
    }
  }
  return round1(Math.max(0, score));
}

// ---------------------------------------------------------------------------
// LLM-judge: semantic coverage
// ---------------------------------------------------------------------------

interface CoverageCategory {
  goldKey: keyof GoldLabel;
  label: string;
  resultField: string;
  preferred: string;
}

const COVERAGE_CATEGORIES: CoverageCategory[] = [
  { goldKey: "expected_actors", label: "actors", resultField: "actors", preferred: "name" },
  { goldKey: "expected_functions", label: "functions", resultField: "functions", preferred: "name" },
  { goldKey: "expected_entities", label: "entities", resultField: "entities", preferred: "name" },
  { goldKey: "expected_constraints", label: "constraints", resultField: "constraints", preferred: "description" },
  { goldKey: "expected_exceptions", label: "exceptions", resultField: "exceptions", preferred: "description" },
  { goldKey: "expected_processes", label: "processes", resultField: "business_processes", preferred: "name" },
];

const JUDGE_SYSTEM =
  "You are a strict, fair evaluator for software requirements analysis. " +
  "For each EXPECTED item you decide whether the SYSTEM OUTPUT covers it. " +
  "An item is covered if the output expresses the same thing — paraphrase, " +
  "synonym, abbreviation, or a different language all count as covered. " +
  "Respond with JSON only, no prose.";

export function buildCoveragePrompt(
  gold: GoldLabel,
  result: Record<string, unknown>,
): { prompt: string; activeCategories: CoverageCategory[] } {
  const active = COVERAGE_CATEGORIES.filter(
    (c) => (gold[c.goldKey] ?? []).length > 0,
  );

  const outputLines = active.map((c) => {
    const names = readNames(result?.[c.resultField], c.preferred);
    return `${c.label}: ${names.length ? names.join("; ") : "(none)"}`;
  });

  const expectedLines = active.map((c) => {
    const items = (gold[c.goldKey] ?? []).map((e, i) => `  ${i + 1}. ${e}`).join("\n");
    return `${c.label}:\n${items}`;
  });

  const prompt = [
    "Mark each EXPECTED item as covered or missing by the SYSTEM OUTPUT.",
    "",
    "# SYSTEM OUTPUT",
    ...outputLines,
    "",
    "# EXPECTED (ground truth)",
    ...expectedLines,
    "",
    "Return JSON exactly in this shape, listing the expected items verbatim:",
    '{ "<category>": { "covered": ["<expected item>", ...], "missing": ["<expected item>", ...] }, ... }',
    "Only include the categories shown above.",
  ].join("\n");

  return { prompt, activeCategories: active };
}

/** Run the LLM coverage judge. Returns an aggregate 0-100 plus per-category
 *  detail. Categories with no expected items are skipped (not penalised). */
export async function judgeCoverage(
  llm: JudgeClient,
  gold: GoldLabel,
  result: Record<string, unknown>,
): Promise<{ score: number; detail: CategoryCoverage[] }> {
  const { prompt, activeCategories } = buildCoveragePrompt(gold, result);
  if (activeCategories.length === 0) return { score: 0, detail: [] };

  let verdict: Record<string, unknown> = {};
  try {
    verdict = (await llm.generateJson(prompt, JUDGE_SYSTEM)) ?? {};
  } catch {
    verdict = {};
  }

  const detail: CategoryCoverage[] = [];
  for (const c of activeCategories) {
    const expected = gold[c.goldKey] ?? [];
    const node = verdict[c.label];
    const coveredRaw = readJudgeList(node, "covered");
    // Trust the gold list, not the model's free text: an expected item counts
    // as covered only if the judge echoed it back under "covered".
    const covered = expected.filter((e) =>
      coveredRaw.some((cv) => normalize(cv) === normalize(e)),
    );
    const missing = expected.filter((e) => !covered.includes(e));
    detail.push({ category: c.label, expected: expected.length, covered: covered.length, missing });
  }

  const perCategoryPct = detail
    .filter((d) => d.expected > 0)
    .map((d) => (d.covered / d.expected) * 100);
  const score = perCategoryPct.length
    ? round1(perCategoryPct.reduce((a, b) => a + b, 0) / perCategoryPct.length)
    : 0;

  return { score, detail };
}

function readJudgeList(node: unknown, key: string): string[] {
  if (!node || typeof node !== "object") return [];
  const v = (node as Record<string, unknown>)[key];
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? "").trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

const WEIGHTS = {
  coverage: 0.5,
  diagram_syntax: 0.2,
  diagram_structure: 0.15,
  consistency: 0.15,
} as const;

export function computeOverall(s: Omit<Scores, "overall">): number {
  const overall =
    s.coverage * WEIGHTS.coverage +
    s.diagram_syntax * WEIGHTS.diagram_syntax +
    s.diagram_structure * WEIGHTS.diagram_structure +
    s.consistency * WEIGHTS.consistency;
  return round1(overall);
}

function isPassing(overall: number): boolean {
  return overall >= PASS_THRESHOLD;
}

export interface CaseGateInput {
  overall: number;
  openMajorIssues: number;
  finalReviewPassed: boolean;
  persisted: boolean;
  qualityStatus: string;
}

export function caseGateFailures(input: CaseGateInput): string[] {
  const failures: string[] = [];
  if (!isPassing(input.overall)) {
    failures.push(`overall score below ${PASS_THRESHOLD}`);
  }
  if (input.openMajorIssues > 0) {
    failures.push(`${input.openMajorIssues} unresolved major/blocker issue(s)`);
  }
  if (!input.finalReviewPassed) {
    failures.push("final review did not pass");
  }
  if (input.qualityStatus !== "passed") {
    failures.push(`quality status is ${input.qualityStatus || "unknown"}`);
  }
  if (!input.persisted) {
    failures.push("outputs were not persisted");
  }
  return failures;
}

/**
 * A case only counts as passed if the score clears the bar AND the runtime's
 * own quality gates passed through final persistence.
 */
export function casePassed(input: CaseGateInput): boolean {
  return caseGateFailures(input).length === 0;
}

/** Combine an already-computed coverage score with deterministic scoring over
 *  the produced artifacts into a full Scores object. */
export function combineScores(params: {
  coverage: number;
  result: Record<string, unknown>;
  diagrams: Record<string, unknown>;
}): Scores {
  const diagram_syntax = scoreDiagramSyntax(params.diagrams);
  const diagram_structure = scoreDiagramStructure(params.diagrams);
  const consistency = scoreConsistency(params.result, params.diagrams);
  const overall = computeOverall({
    coverage: params.coverage,
    diagram_syntax,
    diagram_structure,
    consistency,
  });
  return { coverage: params.coverage, diagram_syntax, diagram_structure, consistency, overall };
}

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const SUMMARY_METRICS: Array<keyof Scores> = [
  "coverage",
  "diagram_syntax",
  "diagram_structure",
  "consistency",
  "overall",
];

export function computeRunSummary(results: BenchmarkCaseResult[]): Record<string, unknown> {
  const success = results.filter((r) => r.status === "success");
  if (success.length === 0) {
    return { passed: 0, failed: 0, error: results.length, avg_scores: {} };
  }
  const passed = success.filter((r) => r.passed).length;
  const avgScores: Record<string, number> = {};
  for (const metric of SUMMARY_METRICS) {
    const vals = success.map((r) => r.scores?.[metric] ?? 0);
    avgScores[metric] = round1(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return {
    passed,
    failed: success.length - passed,
    error: results.length - success.length,
    avg_scores: avgScores,
  };
}
