/**
 * Benchmark v2 — result storage with atomic writes + incremental summaries.
 *
 * Directory layout (under a caller-chosen base dir, default `benchmark/results`):
 *
 *   {base}/{benchmark_id}/
 *   ├── metadata.json          run-level metadata (written once)
 *   ├── summary.partial.json   updated after every run (resumable progress)
 *   ├── summary.final.json     written once at the end of the benchmark
 *   └── cases/
 *       └── {case_id}/
 *           ├── run_0/
 *           │   ├── result.json     canonical per-run result (see BenchmarkResult)
 *           │   ├── sanity.json     Layer-0 sanity gate output
 *           │   ├── review.json     review-gate record (separate from quality)
 *           │   ├── quality.json    Phase-1 placeholder; Phase-2 rubric scores
 *           │   └── artifacts/      runtime-produced artifacts (copied in)
 *           ├── run_1/ ...
 *           └── ...
 *
 * All JSON writes are atomic: write to `path.tmp` then `renameSync` over the
 * final path. `result.json` is the resume probe — it is written last, so a
 * run is only considered complete once a valid, non-`.tmp` result.json exists.
 *
 * @module benchmark/resultStore
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { RUNNER_VERSION, SCORING_VERSION, type BenchmarkMetadata } from "./metadata.js";

// ---------------------------------------------------------------------------
// Quality scores (Phase-1 placeholders)
// ---------------------------------------------------------------------------

/**
 * The four Phase-2 quality sub-scores. Phase 1 leaves every field `null` and
 * records a `TODO(Phase2)`; once the rubric lands they become 0-100 numbers.
 */
export interface QualityScores {
  /** Layer 1 — Gold Obligation coverage (Phase 2). */
  gold_obligation_coverage: number | null;
  /** Layer 2 — Traceability Truthfulness (Phase 2). */
  traceability_truthfulness: number | null;
  /** Layer 3 — Test Effectiveness (mutant / Phase 2). */
  test_effectiveness: number | null;
  /** Layer 4 — Design Depth (rubric / Phase 2). */
  design_depth: number | null;
  /** Aggregate of the four sub-scores (Phase 2). */
  final_score: number | null;
}

/** All-null quality block (Phase-1 valid-but-unscored). */
export const NULL_QUALITY: QualityScores = {
  gold_obligation_coverage: null,
  traceability_truthfulness: null,
  test_effectiveness: null,
  design_depth: null,
  final_score: null,
};

/**
 * Quality block for an *invalid* run (failed the sanity gate). Identical to
 * {@link NULL_QUALITY} today; kept as a distinct symbol so Phase-2 invalid
 * handling can diverge from "valid-but-not-judged" without touching call sites.
 */
export const INVALID_QUALITY: QualityScores = { ...NULL_QUALITY };

// ---------------------------------------------------------------------------
// Sanity gate output
// ---------------------------------------------------------------------------

/** Layer-0 deterministic sanity gate result. */
export interface SanityResult {
  passed: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Review gate (recorded separately from quality — NOT folded into final_score)
// ---------------------------------------------------------------------------

/**
 * The pipeline's own final-review gate. Phase 1 records it but explicitly does
 * NOT weight it into {@link QualityScores} (per the v2 design: the review gate
 * is an independent signal, decoupled from the quality rubric).
 */
export interface ReviewGateRecord {
  passed: boolean;
  /** null in Phase 1 — the review has no numeric score in the v2 contract. */
  score: number | null;
  open_major_issues: number;
  quality_status: string;
  persisted: boolean;
}

// ---------------------------------------------------------------------------
// Canonical per-run result
// ---------------------------------------------------------------------------

export type RunStatus = "valid" | "invalid";

/**
 * Canonical `result.json`. `status === "invalid"` ⇒ quality is all-null
 * (sanity gate failed). `status === "valid"` ⇒ quality may still be all-null
 * in Phase 1 (judge not implemented yet).
 */
export interface BenchmarkResult {
  case_id: string;
  run_id: number;
  status: RunStatus;
  sanity: SanityResult;
  review_gate: ReviewGateRecord;
  quality: QualityScores;
  major_misses: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Summary documents
// ---------------------------------------------------------------------------

/** One row per case×run, used in both partial and final summaries. */
export interface SummaryEntry {
  case_id: string;
  run_id: number;
  status: RunStatus;
  sanity_passed: boolean;
  review_passed: boolean;
  final_score: number | null;
}

/**
 * `summary.partial.json` / `summary.final.json`. `partial` is rewritten after
 * every run; `final` adds eval-mode aggregate statistics and `completed: true`.
 */
export interface SummaryDocument {
  benchmark_id: string;
  mode: string;
  num_runs: number;
  completed: boolean;
  entries: SummaryEntry[];
  /** Present only in the final summary (eval mode) — mean/std/rates. */
  aggregates?: SummaryAggregates;
}

export interface SummaryAggregates {
  final_score_mean: number | null;
  final_score_std: number | null;
  valid_run_rate: number;
  review_pass_rate: number;
  repair_success_rate: number | null;
  major_obligation_miss_rate: number;
  traceability_false_positive_rate: number | null;
}

// ---------------------------------------------------------------------------
// Directory layout helpers
// ---------------------------------------------------------------------------

/** Default base dir for the result tree (gitignored via `.gitignore`). */
export const DEFAULT_RESULTS_BASE_DIR = "benchmark/results";

/** `{base}/{benchmark_id}` — root of a single benchmark run. */
export function runDirBase(baseDir: string, benchmarkId: string): string {
  return join(baseDir, benchmarkId);
}

/** `{base}/{benchmark_id}/cases/{caseId}` — all runs for one case. */
export function caseDir(baseDir: string, benchmarkId: string, caseId: string): string {
  return join(runDirBase(baseDir, benchmarkId), "cases", caseId);
}

/** `{base}/{benchmark_id}/cases/{caseId}/run_{n}` — a single run. */
export function caseRunDir(
  baseDir: string,
  benchmarkId: string,
  caseId: string,
  runId: number,
): string {
  return join(caseDir(baseDir, benchmarkId, caseId), `run_${runId}`);
}

/** File names inside a run directory. Exported for resume.ts reuse. */
export const RUN_FILE_NAMES = {
  result: "result.json",
  sanity: "sanity.json",
  review: "review.json",
  quality: "quality.json",
  artifacts: "artifacts",
} as const;

/** Paths to the three top-level summary/metadata files of a run. */
export function runFilePaths(baseDir: string, benchmarkId: string) {
  const root = runDirBase(baseDir, benchmarkId);
  return {
    root,
    metadata: join(root, "metadata.json"),
    summaryPartial: join(root, "summary.partial.json"),
    summaryFinal: join(root, "summary.final.json"),
  } as const;
}

// ---------------------------------------------------------------------------
// Atomic JSON write
// ---------------------------------------------------------------------------

/**
 * Write `value` as pretty-printed JSON to `filePath` atomically: write to
 * `filePath + ".tmp"` then `renameSync` over the target. Creates parent
 * directories as needed.
 *
 * The `.tmp` file is intentionally a sibling of the target so the rename is a
 * same-volume move (required for Windows `renameSync` to replace an existing
 * file). `result.json` is the resume probe, so callers must write it *last*.
 */
export function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// ResultStore
// ---------------------------------------------------------------------------

/**
 * Owns the on-disk layout for a single benchmark run. Pure I/O orchestration —
 * no scoring/judge logic. Safe to instantiate against a temp dir in tests.
 */
export class ResultStore {
  readonly benchmarkId: string;
  private readonly baseDir: string;

  constructor(params: { baseDir?: string; benchmarkId: string }) {
    this.baseDir = params.baseDir ?? DEFAULT_RESULTS_BASE_DIR;
    this.benchmarkId = params.benchmarkId;
  }

  /** Root directory of this benchmark run. */
  get root(): string {
    return runDirBase(this.baseDir, this.benchmarkId);
  }

  /** Directory holding all runs for `caseId`. */
  caseDir(caseId: string): string {
    return caseDir(this.baseDir, this.benchmarkId, caseId);
  }

  /** Directory holding a single `runId` for `caseId`. */
  caseRunDir(caseId: string, runId: number): string {
    return caseRunDir(this.baseDir, this.benchmarkId, caseId, runId);
  }

  /** Write the run metadata.json (once, at benchmark start). */
  writeMetadata(meta: BenchmarkMetadata): void {
    const { metadata } = runFilePaths(this.baseDir, this.benchmarkId);
    atomicWriteJson(metadata, meta);
  }

  /**
   * Write a single run's complete result set atomically. `result.json` is
   * written last so the resume probe only sees fully-written runs.
   *
   * @param result   canonical result.json content
   * @param sanity   Layer-0 sanity gate output (also written as sanity.json)
   * @param review   review-gate record (review.json, separate from quality)
   * @param quality  quality block (quality.json; Phase-1 placeholder)
   */
  writeRun(params: {
    result: BenchmarkResult;
    sanity: SanityResult;
    review: ReviewGateRecord;
    quality: QualityScores;
  }): void {
    const dir = this.caseRunDir(params.result.case_id, params.result.run_id);
    mkdirSync(join(dir, RUN_FILE_NAMES.artifacts), { recursive: true });
    atomicWriteJson(join(dir, RUN_FILE_NAMES.sanity), params.sanity);
    atomicWriteJson(join(dir, RUN_FILE_NAMES.review), params.review);
    atomicWriteJson(join(dir, RUN_FILE_NAMES.quality), params.quality);
    // result.json LAST — it is the resume probe.
    atomicWriteJson(join(dir, RUN_FILE_NAMES.result), params.result);
  }

  /** Rewrite `summary.partial.json` after each run (resumable progress). */
  writePartialSummary(summary: SummaryDocument): void {
    const { summaryPartial } = runFilePaths(this.baseDir, this.benchmarkId);
    atomicWriteJson(summaryPartial, summary);
  }

  /** Write `summary.final.json` once the whole benchmark is done. */
  writeFinalSummary(summary: SummaryDocument): void {
    const { summaryFinal } = runFilePaths(this.baseDir, this.benchmarkId);
    atomicWriteJson(summaryFinal, summary);
  }

  /** Build a fresh (empty) summary document for this benchmark. */
  emptySummary(meta: BenchmarkMetadata): SummaryDocument {
    return {
      benchmark_id: meta.benchmark_id,
      mode: meta.mode,
      num_runs: meta.num_runs,
      completed: false,
      entries: [],
    };
  }

  /**
   * Load an existing `summary.partial.json` (for resume). Returns `null` when
   * absent or malformed (so a fresh partial is started instead of crashing).
   */
  loadPartialSummary(): SummaryDocument | null {
    const { summaryPartial } = runFilePaths(this.baseDir, this.benchmarkId);
    return readJsonIfExists<SummaryDocument>(summaryPartial);
  }
}

// ---------------------------------------------------------------------------
// Shared JSON read helper
// ---------------------------------------------------------------------------

/** Read+parse JSON if the file exists; return `null` if missing or malformed. */
export function readJsonIfExists<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Re-exported for summary builders that stamp runner/scoring versions. */
export { RUNNER_VERSION, SCORING_VERSION };
