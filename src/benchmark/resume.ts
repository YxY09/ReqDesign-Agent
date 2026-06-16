/**
 * Benchmark v2 — resume / skip logic.
 *
 * A run is considered *complete* when its `result.json` exists, is valid JSON,
 * parses to an object with the expected `status` field, and is not a leftover
 * `.tmp` write. The probe deliberately reads `result.json` (the last file the
 * ResultStore writes), so a partially-written run directory is never mistaken
 * for a finished one.
 *
 * Resume modes:
 *   --resume        reuse an existing benchmark_id dir; skip completed runs
 *   --case <id>     only run the named case (still respects --resume)
 *   --only-failed   only re-run cases whose completed runs are invalid
 *   --n <count>     eval-mode runs-per-case
 *
 * @module benchmark/resume
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { RUN_FILE_NAMES, readJsonIfExists, type BenchmarkResult } from "./resultStore.js";
import type { BenchmarkMetadata } from "./metadata.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ResumeOptions {
  /** When true, skip runs that already have a complete result.json. */
  resume: boolean;
  /** Restrict execution to a single case id (undefined = all cases). */
  caseId?: string;
  /** When true, only re-run cases whose existing result is invalid. */
  onlyFailed: boolean;
  /** eval-mode runs-per-case (dev mode forces 1). */
  numRuns: number;
}

// ---------------------------------------------------------------------------
// Completion probe
// ---------------------------------------------------------------------------

/**
 * Is `caseRunDir` a *complete* run? True iff `result.json` exists, parses as a
 * well-formed {@link BenchmarkResult}-shaped object, and was not left as a
 * `.tmp` file. Malformed JSON and `.tmp` leftovers both count as incomplete.
 */
export function isRunComplete(caseRunDirPath: string): boolean {
  const resultPath = join(caseRunDirPath, RUN_FILE_NAMES.result);
  // A leftover .tmp means the atomic write was interrupted → not complete.
  if (existsSync(`${resultPath}.tmp`)) return false;
  if (!existsSync(resultPath)) return false;
  const parsed = readJsonIfExists<BenchmarkResult>(resultPath);
  if (!parsed) return false; // missing or malformed JSON
  // Shape check: a real result always carries these top-level fields.
  return (
    typeof parsed.case_id === "string" &&
    typeof parsed.run_id === "number" &&
    (parsed.status === "valid" || parsed.status === "invalid")
  );
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/**
 * Return the set of completed run ids for a case directory. Reads
 * `cases/{caseId}/run_{n}/result.json` for each `run_*` subdir.
 */
export function findCompletedRuns(caseDirPath: string): Set<number> {
  const completed = new Set<number>();
  if (!existsSync(caseDirPath)) return completed;
  let entries: string[];
  try {
    entries = readdirSync(caseDirPath);
  } catch {
    return completed;
  }
  for (const entry of entries) {
    const m = /^run_(\d+)$/.exec(entry);
    if (!m) continue;
    const runId = Number(m[1]);
    if (isRunComplete(join(caseDirPath, entry))) {
      completed.add(runId);
    }
  }
  return completed;
}

/**
 * Case ids under a benchmark root whose every completed run is invalid
 * (i.e. failed the sanity gate). Used by `--only-failed` to scope re-runs.
 *
 * A case with no completed runs is NOT considered "failed" here (it simply
 * hasn't run yet) — `--only-failed` only narrows cases that *did* run and all
 * came back invalid.
 */
export function listFailedCases(casesRoot: string): Set<string> {
  const failed = new Set<string>();
  if (!existsSync(casesRoot)) return failed;
  let entries: string[];
  try {
    entries = readdirSync(casesRoot);
  } catch {
    return failed;
  }
  for (const caseId of entries) {
    const completed = findCompletedRuns(join(casesRoot, caseId));
    if (completed.size === 0) continue; // never ran → not "failed"
    let anyValid = false;
    for (const runId of completed) {
      const result = readJsonIfExists<BenchmarkResult>(
        join(casesRoot, caseId, `run_${runId}`, RUN_FILE_NAMES.result),
      );
      if (result?.status === "valid") {
        anyValid = true;
        break;
      }
    }
    if (!anyValid) failed.add(caseId);
  }
  return failed;
}

// ---------------------------------------------------------------------------
// Latest-run resolution (--benchmark-id latest)
// ---------------------------------------------------------------------------

/**
 * Find the most recent benchmark run id under `baseDir`.
 *
 * Used by `--benchmark-id latest`: enumerates the run sub-directories of the
 * results base dir and returns the one with the greatest timestamp. Only
 * directories containing a readable `metadata.json` (i.e. real benchmark runs)
 * are considered, so stray sub-dirs (e.g. a co-located `cases/` or `gold/`)
 * never win the `latest` resolution. The timestamp is read from each run's
 * `metadata.json` (`timestamp` field, `YYYYMMDD_HHMMSS`, fixed-width and
 * lexicographically sortable).
 *
 * Returns `null` when `baseDir` does not exist or contains no run dirs.
 */
export function findLatestBenchmarkId(baseDir: string): string | null {
  if (!existsSync(baseDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  let best: { id: string; ts: string } | null = null;
  for (const id of entries) {
    // Only consider real benchmark runs: a dir without metadata.json is not
    // a resumable run (and its name may sort arbitrarily relative to real
    // run ids), so skip it rather than falling back to the dir name.
    const meta = readJsonIfExists<BenchmarkMetadata>(join(baseDir, id, "metadata.json"));
    if (!meta) continue;
    const ts = meta.timestamp ?? id;
    if (best === null || ts > best.ts) {
      best = { id, ts };
    }
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------------------
// Skip decision
// ---------------------------------------------------------------------------

/**
 * Should `runId` be skipped (already complete & resuming)?
 *
 * `opts.resume === false` always returns `false` (fresh run, nothing skipped).
 * The completion set is precomputed by the caller via {@link findCompletedRuns}.
 */
export function shouldSkipRun(
  runId: number,
  completedRuns: Set<number>,
  opts: ResumeOptions,
): boolean {
  if (!opts.resume) return false;
  return completedRuns.has(runId);
}

/**
 * Resolve the effective list of case ids to run given resume options and the
 * set of case ids discovered on disk / from the metadata.
 *
 * - `--case <id>`: intersect down to that one case.
 * - `--only-failed`: intersect down to cases listed by {@link listFailedCases}.
 */
export function resolveCaseScope(params: {
  discoveredCaseIds: string[];
  failedCaseIds: Set<string>;
  opts: ResumeOptions;
}): string[] {
  let ids = params.discoveredCaseIds;
  if (params.opts.caseId) {
    ids = ids.filter((id) => id === params.opts.caseId);
  }
  if (params.opts.onlyFailed) {
    ids = ids.filter((id) => params.failedCaseIds.has(id));
  }
  return ids;
}
