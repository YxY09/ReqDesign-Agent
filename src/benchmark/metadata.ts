/**
 * Benchmark v2 — Layer 0 metadata.
 *
 * Generates a deterministic-but-unique `benchmark_id` and the `metadata.json`
 * describing a benchmark run. Everything here is pure plumbing: it reads git
 * state from the working tree (with a graceful non-git fallback) and the model
 * name from the agent config. No judge / gold / mutant logic lives here.
 *
 * @module benchmark/metadata
 */

import { execFileSync } from "node:child_process";
import type { AgentConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Versioning constants
// ---------------------------------------------------------------------------

/** Bumped whenever the on-disk result/metadata layout changes. */
export const RUNNER_VERSION = "benchmark-v2";

/**
 * Identifies the scoring contract. The evidence-based quality judge
 * (`qualityJudge.ts`) scores the four sub-scores against gold obligations;
 * cases without a hand-curated gold contract fall back to all-null
 * placeholders. Kept here so metadata records the scoring contract in use.
 */
export const SCORING_VERSION = "quality-v1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** dev = one run per case; eval = N runs per case with aggregation. */
export type BenchmarkMode = "dev" | "eval";

/**
 * On-disk metadata.json shape. New fields should be additive and versioned
 * via {@link RUNNER_VERSION}.
 */
export interface BenchmarkMetadata {
  benchmark_id: string;
  commit_short: string;
  timestamp: string;
  git_dirty: boolean;
  mode: BenchmarkMode;
  num_runs: number;
  case_ids: string[];
  scoring_version: string;
  /** LLM model used for the judge; sourced from config.llm.model. */
  judge_model: string;
  runner_version: string;
}

// ---------------------------------------------------------------------------
// Git helpers (with graceful non-git fallback)
// ---------------------------------------------------------------------------

/**
 * Run a git command in `cwd`, returning trimmed stdout. Returns `null` when git
 * is unavailable or `cwd` is not a git repository, so callers can fall back.
 */
function git(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return out.trim();
  } catch {
    return null;
  }
}

/** Short commit hash of HEAD, or `"unknown"` outside a git repo. */
export function getCommitShort(cwd: string): string {
  return git(cwd, ["rev-parse", "--short", "HEAD"]) ?? "unknown";
}

/** True when `git status --porcelain` reports any change (or git is absent → safe default true). */
export function isGitDirty(cwd: string): boolean {
  const out = git(cwd, ["status", "--porcelain"]);
  // If git is unavailable we cannot prove cleanliness → treat as dirty.
  if (out === null) return true;
  return out.length > 0;
}

// ---------------------------------------------------------------------------
// benchmark_id + timestamp
// ---------------------------------------------------------------------------

/** `YYYYMMDD_HHMMSS` in the local timezone, padded. */
export function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Build a benchmark_id: `{commit_short}_{timestamp}[_{label}]`.
 *
 * - `commit_short` defaults to git HEAD but falls back to `"nogit"`.
 * - `timestamp` is {@link formatTimestamp}.
 * - `label` is optional (e.g. `"phase1"`); when provided it is appended after
 *   the timestamp with a `_` separator. Whitespace is replaced by `_`.
 */
export function generateBenchmarkId(
  opts: { commitShort?: string; timestamp?: string; label?: string } = {},
): string {
  const commit = opts.commitShort ?? "nogit";
  const ts = opts.timestamp ?? formatTimestamp();
  const label = (opts.label ?? "").trim();
  // Sanitize: keep the separator stable and drop stray separators/whitespace.
  const labelPart = label ? `_${label.replace(/[\s/\\]+/g, "_")}` : "";
  return `${commit}_${ts}${labelPart}`;
}

// ---------------------------------------------------------------------------
// Metadata assembly
// ---------------------------------------------------------------------------

/**
 * Assemble a complete {@link BenchmarkMetadata}.
 *
 * @param cwd          working tree used for git lookups (commit / dirty flag).
 * @param mode         dev | eval.
 * @param numRuns      runs-per-case (dev → 1).
 * @param caseIds      ordered list of case ids included in this benchmark.
 * @param config       agent config; `judge_model` is read from `config.llm.model`.
 * @param label        optional benchmark_id label suffix.
 * @param overrides    test hook: force `commitShort`/`timestamp` for determinism.
 */
export function buildMetadata(params: {
  cwd: string;
  mode: BenchmarkMode;
  numRuns: number;
  caseIds: string[];
  config: AgentConfig;
  label?: string;
  overrides?: { commitShort?: string; timestamp?: string };
}): BenchmarkMetadata {
  const commitShort = params.overrides?.commitShort ?? getCommitShort(params.cwd);
  const timestamp = params.overrides?.timestamp ?? formatTimestamp();
  const benchmarkId = generateBenchmarkId({
    commitShort,
    timestamp,
    label: params.label,
  });
  return {
    benchmark_id: benchmarkId,
    commit_short: commitShort,
    timestamp,
    git_dirty: isGitDirty(params.cwd),
    mode: params.mode,
    num_runs: params.numRuns,
    case_ids: [...params.caseIds],
    scoring_version: SCORING_VERSION,
    judge_model: params.config.llm.model,
    runner_version: RUNNER_VERSION,
  };
}
