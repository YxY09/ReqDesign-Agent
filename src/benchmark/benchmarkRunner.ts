/**
 * Benchmark v2 — orchestrator.
 *
 * New framework layered on top of the four base modules (metadata,
 * resultStore, sanityGate, resume). It uses the shared RuntimeLike /
 * RuntimeFactory contract used by the production CLI path.
 *
 * Scoring: when a case has a hand-curated gold contract
 * (`benchmark/gold_contracts/<id>.json`) and the sanity gate passed, the
 * evidence-based judge (`qualityJudge.ts`) runs over the on-disk design+tests
 * and derives the four quality sub-scores. Cases without a gold contract, or
 * runs where the judge throws, fall back to all-null quality. Mutant-based
 * test effectiveness and the `repair_success_rate` /
 * `traceability_false_positive_rate` aggregates are not yet implemented.
 *
 * The review gate is recorded (review.json) but NOT folded into the quality
 * rubric — it is an independent signal in the v2 contract.
 *
 * CLI:
 *   --mode dev|eval   --n <count>   --resume   --case <id>   --only-failed
 *
 * @module benchmark/benchmarkRunner
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { AgentConfig } from "../config.js";
import { LLMClient } from "../llmClient.js";
import { setupLogger } from "../logger.js";
import type { WorkflowEvent, WorkflowEventSink } from "../workflowEvents.js";
import { createWorkflowEvent } from "../workflowEvents.js";

import type { RuntimeFactory, RuntimeLike } from "./runtimeContract.js";

import { loadGoldContract } from "./goldObligation.js";
import { judgeAgainstGold } from "./qualityJudge.js";

import {
  buildMetadata,
  type BenchmarkMetadata,
  type BenchmarkMode,
} from "./metadata.js";
import {
  DEFAULT_RESULTS_BASE_DIR,
  NULL_QUALITY,
  ResultStore,
  readJsonIfExists,
  runFilePaths,
  type BenchmarkResult,
  type QualityScores,
  type ReviewGateRecord,
  type SanityResult,
  type SummaryAggregates,
  type SummaryDocument,
  type SummaryEntry,
} from "./resultStore.js";
import { runSanityGate, type SanityGateInput } from "./sanityGate.js";
import {
  findCompletedRuns,
  findLatestBenchmarkId,
  listFailedCases,
  resolveCaseScope,
  shouldSkipRun,
} from "./resume.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Programmatic run options (CLI flags map onto these). */
export interface BenchmarkRunOptions {
  mode: BenchmarkMode;
  /** Runs-per-case. dev → forced to 1. */
  numRuns: number;
  resume: boolean;
  caseId?: string;
  onlyFailed: boolean;
  /** Optional label appended to the benchmark_id. */
  label?: string;
  /** Working tree root for git lookups (default: process.cwd()). */
  cwd?: string;
  /** Override base results dir (default: benchmark/results, gitignored). */
  resultsBaseDir?: string;
  /** Pre-existing benchmark_id to resume into (skips id generation). */
  benchmarkId?: string;
  onEvent?: WorkflowEventSink;
}

/** Result of {@link BenchmarkRunnerV2.run}. */
export interface BenchmarkRunReport {
  metadata: BenchmarkMetadata;
  summary: SummaryDocument;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class BenchmarkRunnerV2 {
  private readonly logger = setupLogger("reqdesign.benchmark.v2");

  constructor(
    private readonly config: AgentConfig,
    private readonly casesDir: string,
    private readonly goldDir: string,
    private readonly runtimeFactory: RuntimeFactory,
  ) {}

  // -----------------------------------------------------------------------
  // Case discovery
  // -----------------------------------------------------------------------

  /** Discover case ids: `<casesDir>/<id>.md` with a matching `<goldDir>/<id>.json`. */
  discoverCases(): string[] {
    if (!existsSync(this.casesDir)) {
      throw new Error(`案例目录不存在: ${this.casesDir}`);
    }
    const ids: string[] = [];
    for (const filename of readdirSync(this.casesDir).sort()) {
      if (!filename.endsWith(".md")) continue;
      const id = filename.replace(/\.md$/i, "");
      if (existsSync(join(this.goldDir, `${id}.json`))) {
        ids.push(id);
      } else {
        this.logger.warn(`案例 ${id} 缺少 gold label 文件,跳过`);
      }
    }
    return ids;
  }

  // -----------------------------------------------------------------------
  // Main entry
  // -----------------------------------------------------------------------

  async run(opts: BenchmarkRunOptions): Promise<BenchmarkRunReport> {
    const cwd = opts.cwd ?? process.cwd();
    const mode: BenchmarkMode = opts.mode === "eval" ? "eval" : "dev";
    const numRuns = mode === "dev" ? 1 : Math.max(1, opts.numRuns);

    // --- resume id resolution (Problem 1) -------------------------------
    // `--resume` MUST NOT silently start a fresh run. Require an explicit id;
    // accept the keyword `latest` to auto-resume the most recent run.
    let benchmarkId = opts.benchmarkId;
    if (opts.resume && !benchmarkId) {
      throw new Error(
        "--resume 需要配合 --benchmark-id <id>(或 --benchmark-id latest 自动续最近一次)",
      );
    }
    if (opts.resume && benchmarkId === "latest") {
      const latest = findLatestBenchmarkId(opts.resultsBaseDir ?? DEFAULT_RESULTS_BASE_DIR);
      if (!latest) {
        throw new Error(
          `--benchmark-id latest 未找到任何历史 run:${opts.resultsBaseDir ?? DEFAULT_RESULTS_BASE_DIR}`,
        );
      }
      benchmarkId = latest;
    }

    // --- metadata + store ------------------------------------------------
    const discovered = this.discoverCases();
    const failedCaseIds = opts.resume
      ? listFailedCases(join(opts.resultsBaseDir ?? DEFAULT_RESULTS_BASE_DIR, benchmarkId ?? "", "cases"))
      : new Set<string>();

    const scopedCaseIds = resolveCaseScope({
      discoveredCaseIds: discovered,
      failedCaseIds,
      opts: { ...opts, numRuns },
    });

    let metadata: BenchmarkMetadata;
    let store: ResultStore;

    if (opts.resume && benchmarkId) {
      // Resume into an existing run dir: load its metadata.json.
      const { metadata: metaPath } = runFilePaths(
        opts.resultsBaseDir ?? DEFAULT_RESULTS_BASE_DIR,
        benchmarkId,
      );
      const loaded = readJsonIfExists<BenchmarkMetadata>(metaPath);
      if (!loaded) {
        throw new Error(`--resume 指定的 benchmark_id 无 metadata.json: ${benchmarkId}`);
      }
      metadata = loaded;
      store = new ResultStore({ baseDir: opts.resultsBaseDir, benchmarkId });
    } else {
      metadata = buildMetadata({
        cwd,
        mode,
        numRuns,
        caseIds: scopedCaseIds,
        config: this.config,
        label: opts.label,
      });
      store = new ResultStore({ baseDir: opts.resultsBaseDir, benchmarkId: metadata.benchmark_id });
      store.writeMetadata(metadata);
    }

    this.emit(opts.onEvent, {
      kind: "benchmark_started",
      message: `v2 benchmark ${metadata.benchmark_id} started`,
      status: "running",
      data: { benchmarkId: metadata.benchmark_id, mode, numRuns, cases: scopedCaseIds.length },
    });

    // --- summary (resume-aware) -----------------------------------------
    let summary: SummaryDocument = store.loadPartialSummary() ?? store.emptySummary(metadata);
    summary.num_runs = numRuns;
    summary.mode = mode;

    // --- execute ---------------------------------------------------------
    for (const caseId of scopedCaseIds) {
      const completedRuns = opts.resume
        ? findCompletedRuns(store.caseDir(caseId))
        : new Set<number>();
      for (let runId = 0; runId < numRuns; runId++) {
        if (shouldSkipRun(runId, completedRuns, {
          ...opts,
          numRuns,
        })) {
          this.logger.info(`跳过已完成 run: ${caseId}/run_${runId}`);
          continue;
        }
        const result = await this.executeCase(caseId, runId, store, opts.onEvent);
        summary = appendEntry(summary, result);
        store.writePartialSummary(summary);
      }
    }

    // --- finalize --------------------------------------------------------
    summary.completed = true;
    if (mode === "eval") {
      summary.aggregates = computeAggregates(summary.entries);
    }
    store.writeFinalSummary(summary);

    this.emit(opts.onEvent, {
      kind: "benchmark_completed",
      message: `v2 benchmark ${metadata.benchmark_id} done`,
      status: "completed",
      data: { benchmarkId: metadata.benchmark_id, completed: true },
    });

    return { metadata, summary };
  }

  // -----------------------------------------------------------------------
  // Single case×run
  // -----------------------------------------------------------------------

  /**
   * Execute one run of one case end-to-end:
   *   pipeline (runtime.run, with timeout race) → sanity gate → quality
   *   placeholder → atomic write → return canonical result.
   *
   * Applies the benchmark timeout policy and writes the v2 result layout.
   */
  private async executeCase(
    caseId: string,
    runId: number,
    store: ResultStore,
    onEvent?: WorkflowEventSink,
  ): Promise<BenchmarkResult> {
    const casePath = join(this.casesDir, `${caseId}.md`);
    const caseOutputDir = store.caseRunDir(caseId, runId);
    const runtime = this.runtimeFactory(this.config);
    const timeoutSeconds = this.config.benchmark.caseTimeoutSeconds;

    this.emit(onEvent, {
      kind: "benchmark_case_started",
      message: `v2 running ${caseId}/run_${runId}`,
      caseName: caseId,
      data: { caseId, runId, casePath },
    });

    // --- run pipeline (timeout race mirrors legacy runCase) -------------
    // The setTimeout MUST be cleared on both success and timeout, otherwise
    // the pending timer pins the event loop open for up to caseTimeoutSeconds
    // (default 3600s) per case — very visible in multi-case eval runs.
    let raw: Awaited<ReturnType<RuntimeLike["run"]>>;
    try {
      const runPromise = runtime.run("design", casePath, caseOutputDir);
      if (timeoutSeconds > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`benchmark case timeout after ${timeoutSeconds}s`)),
            timeoutSeconds * 1000,
          );
        });
        try {
          raw = await Promise.race([runPromise, timeoutPromise]);
        } catch (err: unknown) {
          if (err instanceof Error && err.message.startsWith("benchmark case timeout")) {
            runtime.cancel("benchmark case timeout");
          }
          throw err;
        } finally {
          if (timer) clearTimeout(timer);
        }
      } else {
        raw = await runPromise;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // Pipeline failure ⇒ invalid run, quality stays null.
      const sanity: SanityResult = { passed: false, errors: [`pipeline error: ${message}`] };
      const review: ReviewGateRecord = {
        passed: false,
        score: null,
        open_major_issues: 0,
        quality_status: "error",
        persisted: false,
      };
      const result: BenchmarkResult = {
        case_id: caseId,
        run_id: runId,
        status: "invalid",
        sanity,
        review_gate: review,
        quality: { ...NULL_QUALITY },
        major_misses: [message],
        warnings: [],
      };
      store.writeRun({ result, sanity, review, quality: result.quality });
      this.emit(onEvent, {
        kind: "benchmark_case_completed",
        message: `v2 ${caseId}/run_${runId} errored`,
        caseName: caseId,
        status: "error",
        data: { caseId, runId, status: "invalid", error: message },
      });
      return result;
    }

    // --- sanity gate ----------------------------------------------------
    // presentArtifacts is derived from a disk scan of the run output dir so
    // the Layer-0 gate checks the *actual* pipeline output (requirement /
    // design / diagrams / tests sub-dirs), not a hardcoded list. The runtime
    // exposes requirement/diagrams in-memory but NOT design/tests, so the disk
    // scan is the single source of truth for completeness (Problem 2).
    const requirement = (raw.requirementJson ?? {}) as Record<string, unknown>;
    const diagrams = (raw.diagrams ?? {}) as Record<string, unknown>;
    const sanityInput: SanityGateInput = {
      requirement,
      diagrams: Object.fromEntries(
        Object.entries(diagrams).map(([k, v]) => [k, typeof v === "string" ? v : ""]),
      ),
      presentArtifacts: scanPresentArtifacts(caseOutputDir),
    };
    const sanity = runSanityGate(sanityInput);
    const status = sanity.passed ? "valid" : "invalid";

    // --- review gate (recorded separately, NOT folded into quality) -----
    const openMajor = raw.getMajorPendingTaskIds().length;
    const review: ReviewGateRecord = {
      passed: Boolean(raw.finalReviewPassed),
      score: null, // review gate has no numeric score in the v2 contract
      open_major_issues: openMajor,
      quality_status: String(raw.qualityStatus ?? "unknown"),
      persisted: Boolean(raw.persisted),
    };

    // --- quality (evidence-based judge) -------------------------------
    // When the sanity gate passed AND a gold contract exists for this case,
    // run the evidence-based judge over the on-disk design+tests and derive
    // the four sub-scores. Wrapped in try/catch so ANY judge failure (missing
    // gold, LLM error, malformed output) falls back to NULL_QUALITY — keeping
    // runs stable for cases without a hand-curated gold.
    let quality: QualityScores = { ...NULL_QUALITY };
    if (sanity.passed) {
      try {
        quality = await this.judgeQuality(caseId, caseOutputDir);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`judge failed for ${caseId}/run_${runId}, falling back to null quality: ${msg}`);
        quality = { ...NULL_QUALITY };
      }
    }

    const majorMisses: string[] = [];
    if (!sanity.passed) majorMisses.push("sanity gate failed");

    const result: BenchmarkResult = {
      case_id: caseId,
      run_id: runId,
      status,
      sanity,
      review_gate: review,
      quality,
      major_misses: majorMisses,
      warnings: [],
    };

    store.writeRun({ result, sanity, review, quality });

    this.emit(onEvent, {
      kind: "benchmark_case_completed",
      message: `v2 ${caseId}/run_${runId} ${status}`,
      caseName: caseId,
      status: status === "valid" ? "completed" : "failed",
      data: { caseId, runId, status, sanityPassed: sanity.passed },
    });
    return result;
  }

  // -----------------------------------------------------------------------
  // Quality judge
  // -----------------------------------------------------------------------

  /**
   * Resolve the gold contract path for a case. Sibling of the cases dir:
   * `<casesDir>/../gold_contracts/<caseId>.json`. Returns `null` when no
   * contract exists or it is malformed.
   */
  private resolveGoldContract(caseId: string) {
    const goldContractPath = join(this.casesDir, "..", "gold_contracts", `${caseId}.json`);
    return loadGoldContract(goldContractPath);
  }

  /**
   * Run the evidence-based judge for one (already-produced) run.
   *
   * Returns {@link NULL_QUALITY} when no gold contract exists for the case so
   * the runner stays a no-op for cases without a hand-curated contract. Reads
   * design+tests from the run's output dir and the case source from the cases
   * dir.
   */
  private async judgeQuality(caseId: string, caseOutputDir: string): Promise<QualityScores> {
    const gold = this.resolveGoldContract(caseId);
    if (!gold) {
      // No gold contract → keep all-null quality.
      return { ...NULL_QUALITY };
    }
    const requirementSource = (() => {
      try {
        return readFileSync(join(this.casesDir, `${caseId}.md`), "utf8");
      } catch {
        return "";
      }
    })();
    const judge = new LLMClient(this.config) as unknown as import("./scorer.js").JudgeClient;
    const { quality } = await judgeAgainstGold(judge, gold, {
      requirement_source: requirementSource,
      designPath: join(caseOutputDir, "design", "system_design.md"),
      testsPath: join(caseOutputDir, "tests", "test_cases.json"),
      // Feed the traceability matrix to the judge so it can verify
      // chain truthfulness. The matrix is optional; absent ⇒ the judge falls
      // back to has_test_alignment.
      matrixPath: join(caseOutputDir, "traces", "traceability_matrix.json"),
    });
    return quality;
  }

  // -----------------------------------------------------------------------
  // Event helper
  // -----------------------------------------------------------------------

  private emit(
    sink: WorkflowEventSink | undefined,
    event: Partial<WorkflowEvent> & Pick<WorkflowEvent, "kind" | "message">,
  ): void {
    sink?.(createWorkflowEvent({ scope: "benchmark", ...event }));
  }
}

// ---------------------------------------------------------------------------
// Artifact presence scan (module-private)
// ---------------------------------------------------------------------------

/**
 * Scan a run output dir and report which {@link REQUIRED_ARTIFACTS} categories
 * are present on disk. Mirrors the OutputManager layout
 * (requirement/design/diagrams/tests sub-dirs) so the Layer-0 gate's
 * completeness check reflects the *actual* pipeline output rather than a
 * hardcoded list.
 *
 *   - requirement : requirement/analysis.json
 *   - design      : design/system_design.md
 *   - diagrams    : diagrams/ with at least one *.mmd file
 *   - tests       : tests/test_cases.{md,json}
 */
function scanPresentArtifacts(outputDir: string): string[] {
  const present: string[] = [];
  if (existsSync(join(outputDir, "requirement", "analysis.json"))) {
    present.push("requirement");
  }
  if (existsSync(join(outputDir, "design", "system_design.md"))) {
    present.push("design");
  }
  // diagrams category requires at least one non-empty .mmd file — an empty
  // diagrams/ dir does NOT count (matches the gate's empty-diagram rule).
  const diagramsDir = join(outputDir, "diagrams");
  if (existsSync(diagramsDir)) {
    let hasMmd = false;
    try {
      hasMmd = readdirSync(diagramsDir).some((f) => f.endsWith(".mmd"));
    } catch {
      hasMmd = false;
    }
    if (hasMmd) present.push("diagrams");
  }
  if (
    existsSync(join(outputDir, "tests", "test_cases.md")) ||
    existsSync(join(outputDir, "tests", "test_cases.json"))
  ) {
    present.push("tests");
  }
  return present;
}

// ---------------------------------------------------------------------------
// Summary helpers (module-private)
// ---------------------------------------------------------------------------

function appendEntry(summary: SummaryDocument, result: BenchmarkResult): SummaryDocument {
  const entry: SummaryEntry = {
    case_id: result.case_id,
    run_id: result.run_id,
    status: result.status,
    sanity_passed: result.sanity.passed,
    review_passed: result.review_gate.passed,
    final_score: result.quality.final_score,
  };
  return { ...summary, entries: [...summary.entries, entry] };
}

/**
 * Eval-mode aggregates over all entries. Means/stds ignore null scores.
 * Rates are computed over all runs.
 */
function computeAggregates(entries: SummaryEntry[]): SummaryAggregates {
  const total = entries.length;
  const scored = entries.filter((e) => typeof e.final_score === "number");
  const scores = scored.map((e) => e.final_score as number);

  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const std =
    scores.length > 0 && mean !== null
      ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length)
      : null;

  const validRuns = entries.filter((e) => e.status === "valid").length;
  const reviewPassed = entries.filter((e) => e.review_passed).length;
  const majorMissed = entries.filter(
    // A run "missed a major obligation" when it was invalid (sanity failed).
    (e) => e.status === "invalid",
  ).length;

  return {
    final_score_mean: mean === null ? null : round1(mean),
    final_score_std: std === null ? null : round1(std),
    valid_run_rate: total ? round1((validRuns / total) * 100) : 0,
    review_pass_rate: total ? round1((reviewPassed / total) * 100) : 0,
    // Not yet implemented: repair_success_rate / traceability_false_positive_rate
    // need mutant-driven / trace-chain signals that are not computed today.
    repair_success_rate: null,
    major_obligation_miss_rate: total ? round1((majorMissed / total) * 100) : 0,
    traceability_false_positive_rate: null,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Parse argv into {@link BenchmarkRunOptions}. Returns `null` if `--help`. */
export function parseBenchmarkCliArgs(argv: string[]): BenchmarkRunOptions | null {
  const opts: BenchmarkRunOptions = {
    mode: "dev",
    numRuns: 1,
    resume: false,
    onlyFailed: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      i += 1;
      return v;
    };
    switch (arg) {
      case "--help":
      case "-h":
        return null;
      case "--mode": {
        const m = next();
        if (m !== "dev" && m !== "eval") throw new Error(`--mode 必须是 dev 或 eval,收到: ${m}`);
        opts.mode = m;
        break;
      }
      case "--n": {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1) throw new Error(`--n 必须是正整数,收到: ${argv[i]}`);
        opts.numRuns = n;
        break;
      }
      case "--resume":
        opts.resume = true;
        break;
      case "--case":
        opts.caseId = next();
        break;
      case "--only-failed":
        opts.onlyFailed = true;
        break;
      case "--label":
        opts.label = next();
        break;
      case "--benchmark-id":
        opts.benchmarkId = next();
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }
  return opts;
}
