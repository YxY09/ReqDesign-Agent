/**
 * Benchmark v2 — Direct-LLM baseline vs Agent compare runner.
 *
 * For each case: run the direct-LLM {@link runBaseline} (single turn, no
 * scaffolding) AND the Agent pipeline (multi-stage), then score BOTH sides
 * with the SAME {@link judgeAgainstGold} evidence-based judge against the
 * case's {@link GoldContract}. Output a per-case + aggregate comparison
 * report (baseline score vs agent score + the delta on every quality
 * dimension) so the value of the Agent's multi-stage mechanism is measured.
 *
 * Design notes:
 *   - **Symmetric scoring**: both sides write Agent-aligned artifacts and are
 *     graded by the same `judgeAgainstGold` call → the only difference is the
 *     producer, never the judge.
 *   - **Honest on failure**: a side whose artifacts are missing/truncated gets
 *     a null quality; the delta treats null as 0 so a broken side is never
 *     hidden behind a skip.
 *   - **Incremental atomic writes**: each case is scored + flushed to disk
 *     immediately (atomic temp+rename) so a crash never loses finished cases.
 *   - **--case scoping**: run a single case id to support batching the slow
 *     Agent runs (20-40 min each) across separate invocations.
 *   - **No-commit-safe default**: reports go under `benchmark/results/compare/`
 *     (already gitignored) rather than top-level `results/`, so the compare
 *     output can never be accidentally committed.
 *
 * This module is NOT wired into `main.ts` here (out of scope). It exposes
 * `parseCompareCliArgs` + `runCompare` ready for CLI wiring.
 *
 * @module benchmark/compareRunner
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentConfig } from "../config.js";
import { LLMClient } from "../llmClient.js";
import { setupLogger } from "../logger.js";
import { MultiAgentRuntime } from "../runtime.js";

import { runBaseline } from "./baselineRunner.js";
import { loadGoldContract, type GoldContract } from "./goldObligation.js";
import { judgeAgainstGold } from "./qualityJudge.js";
import type { JudgeClient } from "./judgeClient.js";
import type { QualityScores } from "./resultStore.js";
import { atomicWriteJson } from "./resultStore.js";
import { formatTimestamp } from "./metadata.js";
import type { RuntimeFactory, RuntimeLike } from "./runtimeContract.js";


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The four quality dimensions compared per case. */
const QUALITY_DIMENSIONS = [
  "gold_obligation_coverage",
  "traceability_truthfulness",
  "test_effectiveness",
  "design_depth",
  "final_score",
] as const;
type QualityDimension = (typeof QUALITY_DIMENSIONS)[number];

/** One side (baseline or agent) scored result for a case. */
export interface SideScore {
  /** Quality sub-scores (null when artifacts incomplete / judge failed). */
  quality: QualityScores;
  /** True when the side's artifacts were produced and judge ran. */
  scored: boolean;
  /** Error message when the side failed to run/produce artifacts. */
  error?: string;
  /** Directory holding the side's Agent-aligned artifacts. */
  output_dir: string;
}

/** Per-case comparison entry. */
export interface CompareCaseEntry {
  case_id: string;
  baseline: SideScore;
  agent: SideScore;
  /** Per-dimension delta = agent - baseline (null → 0). */
  delta: Record<QualityDimension, number>;
}

/** Aggregate comparison across all cases. */
export interface CompareAggregate {
  /** Mean per-dimension delta across cases (agent - baseline). */
  mean_delta: Record<QualityDimension, number>;
  /** Mean per-dimension baseline score. */
  mean_baseline: Record<QualityDimension, number>;
  /** Mean per-dimension agent score. */
  mean_agent: Record<QualityDimension, number>;
  /** Cases where agent beat baseline on final_score. */
  agent_wins: number;
  /** Cases where baseline beat agent on final_score. */
  baseline_wins: number;
  /** Cases tied on final_score. */
  ties: number;
  total_cases: number;
}

/** Full compare report written to disk. */
export interface CompareReport {
  run_id: string;
  timestamp: string;
  judge_model: string;
  cases: CompareCaseEntry[];
  aggregate: CompareAggregate;
}

/** Programmatic compare run options. */
export interface CompareRunOptions {
  /** Restrict to a single case id (null/undefined = all cases with gold). */
  caseId?: string;
  /** Output root for compare reports (default: benchmark/results — gitignored). */
  resultsBaseDir?: string;
  /** Optional explicit run id (default: timestamp). */
  runId?: string;
  /** Override the cases dir (default: benchmark/cases). */
  casesDir?: string;
  /** Override the gold_contracts dir (default: benchmark/gold_contracts). */
  goldDir?: string;
  /** Test hook: injected baseline LLM (skips real LLM). */
  baselineLlm?: { generateJson(prompt: string, system?: string): Promise<Record<string, unknown>> };
  /** Test hook: injected judge client (skips real LLM judge). */
  judge?: JudgeClient;
  /** Test hook: injected runtime factory for the agent side. */
  runtimeFactory?: RuntimeFactory;
  /** Skip the agent side (only baseline). Test/perf hook. */
  skipAgent?: boolean;
  /** Skip the baseline side (only agent). Test/perf hook. */
  skipBaseline?: boolean;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

/** Default results base (gitignored via `.gitignore` → no-commit-safe). */
export const DEFAULT_COMPARE_RESULTS_BASE_DIR = "benchmark/results";

/** Default cases / gold dirs (repo layout). */
export const DEFAULT_CASES_DIR = "benchmark/cases";
export const DEFAULT_GOLD_DIR = "benchmark/gold_contracts";

/** Parsed CLI options for the compare runner. */
export interface CompareCliOptions {
  caseId?: string;
  resultsBaseDir?: string;
  runId?: string;
  casesDir?: string;
  goldDir?: string;
  skipAgent?: boolean;
  skipBaseline?: boolean;
}

/**
 * Parse compare CLI args. Supports:
 *   --case <id>           restrict to one case id
 *   --results-base <dir>  override results base dir
 *   --run-id <id>         override run id
 *   --cases-dir <dir>     override cases dir
 *   --gold-dir <dir>      override gold_contracts dir
 *   --skip-agent          run baseline only
 *   --skip-baseline       run agent only
 *   --help / -h           returns null
 */
export function parseCompareCliArgs(argv: string[]): CompareCliOptions | null {
  const opts: CompareCliOptions = {};
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
      case "--case":
        opts.caseId = next();
        break;
      case "--results-base":
        opts.resultsBaseDir = next();
        break;
      case "--run-id":
        opts.runId = next();
        break;
      case "--cases-dir":
        opts.casesDir = next();
        break;
      case "--gold-dir":
        opts.goldDir = next();
        break;
      case "--skip-agent":
        opts.skipAgent = true;
        break;
      case "--skip-baseline":
        opts.skipBaseline = true;
        break;
      default:
        throw new Error(`unknown compare argument: ${arg}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Case discovery
// ---------------------------------------------------------------------------

/**
 * Discover case ids that have BOTH a `.md` requirement AND a Phase-2 gold
 * contract (a contract is required to score, so cases without one are skipped
 * with a warning rather than crashing the whole compare run).
 */
export function discoverCompareCases(casesDir: string, goldDir: string): string[] {
  const ids: string[] = [];
  const files = existsSync(casesDir) ? readdirSync(casesDir).sort() : [];
  for (const filename of files) {
    if (!filename.endsWith(".md")) continue;
    const id = filename.replace(/\.md$/i, "");
    if (existsSync(join(goldDir, `${id}.json`))) {
      ids.push(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Scoring a side (symmetric — same judge for baseline and agent)
// ---------------------------------------------------------------------------

/**
 * Score one side's Agent-aligned artifacts against the gold contract.
 *
 * Reads design/system_design.md + tests/test_cases.json (+ optional traces)
 * from `outputDir` and runs {@link judgeAgainstGold}. Returns a null-quality
 * {@link SideScore} when the artifacts are absent/incomplete so the caller can
 * compute an honest delta (null → 0).
 */
export async function scoreSide(
  judge: JudgeClient,
  gold: GoldContract,
  params: { caseId: string; outputDir: string; requirementSource: string; side?: "baseline" | "agent" | string },
): Promise<SideScore> {
  const scoreLogger = setupLogger("reqdesign.benchmark.compare.score");
  const { outputDir, requirementSource, caseId } = params;
  const side = params.side ?? "unknown";
  const designPath = join(outputDir, "design", "system_design.md");
  const testsPath = join(outputDir, "tests", "test_cases.json");
  const matrixPath = join(outputDir, "traces", "traceability_matrix.json");
  const designExists = existsSync(designPath);
  const testsExists = existsSync(testsPath);
  const matrixExists = existsSync(matrixPath);
  const startedAt = Date.now();

  // Sanity: if the two judge-critical files are missing, mark unscored with
  // all-null quality (the delta step will treat this as 0).
  if (!designExists || !testsExists) {
    const error = `missing judge-critical artifacts (design/tests) under ${outputDir}`;
    scoreLogger.warn(
      `scoreSide skipped case=${caseId} side=${side} design_exists=${designExists} tests_exists=${testsExists} output_dir=${outputDir}`,
    );
    return {
      quality: NULL_SCORES,
      scored: false,
      error,
      output_dir: outputDir,
    };
  }

  scoreLogger.info(
    `scoreSide start case=${caseId} side=${side} output_dir=${outputDir} design_bytes=${artifactBytes(designPath) ?? "unknown"} tests_bytes=${artifactBytes(testsPath) ?? "unknown"} matrix_bytes=${matrixExists ? (artifactBytes(matrixPath) ?? "unknown") : "absent"}`,
  );

  try {
    const { quality } = await judgeAgainstGold(judge, gold, {
      requirement_source: requirementSource,
      designPath,
      testsPath,
      matrixPath: matrixExists ? matrixPath : undefined,
    });
    scoreLogger.info(
      `scoreSide done case=${caseId} side=${side} elapsed_ms=${Date.now() - startedAt} coverage=${quality.gold_obligation_coverage ?? "null"} trace=${quality.traceability_truthfulness ?? "null"} tests=${quality.test_effectiveness ?? "null"} depth=${quality.design_depth ?? "null"} final=${quality.final_score ?? "null"}`,
    );
    return { quality, scored: true, output_dir: outputDir };
  } catch (err: unknown) {
    const message = `judge failed for ${caseId}: ${err instanceof Error ? err.message : String(err)}`;
    scoreLogger.warn(
      `scoreSide failed case=${caseId} side=${side} elapsed_ms=${Date.now() - startedAt} error=${message}`,
    );
    return {
      quality: NULL_SCORES,
      scored: false,
      error: message,
      output_dir: outputDir,
    };
  }
}

function artifactBytes(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
/** All-null quality block (matches QualityScores null semantics). */
const NULL_SCORES: QualityScores = {
  gold_obligation_coverage: null,
  traceability_truthfulness: null,
  test_effectiveness: null,
  design_depth: null,
  final_score: null,
};

/** Treat a null dimension as 0 for delta math (honest: a broken side is 0, not skipped). */
function scoreOrZero(value: number | null): number {
  return typeof value === "number" ? value : 0;
}

/** Compute the per-dimension delta between agent and baseline sides. */
export function computeDelta(
  baseline: SideScore,
  agent: SideScore,
): Record<QualityDimension, number> {
  const delta = {} as Record<QualityDimension, number>;
  for (const dim of QUALITY_DIMENSIONS) {
    delta[dim] = round1(
      scoreOrZero(agent.quality[dim]) - scoreOrZero(baseline.quality[dim]),
    );
  }
  return delta;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Report persistence (incremental + atomic)
// ---------------------------------------------------------------------------

/** Paths inside a compare run directory. */
export function compareRunPaths(resultsBaseDir: string, runId: string) {
  const root = join(resultsBaseDir, "compare", runId);
  return {
    root,
    reportJson: join(root, "compare_report.json"),
    reportMd: join(root, "compare_report.md"),
    partialJson: join(root, "compare_report.partial.json"),
  } as const;
}

/**
 * Load an existing partial report (for incremental resume). Returns null when
 * no partial exists (first case) or it is malformed (start fresh).
 */
export function loadPartialReport(path: string): CompareReport | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") return parsed as CompareReport;
  } catch {
    /* fall through to null */
  }
  return null;
}

/**
 * Write the (partial or final) report atomically: serialize, write `.tmp`,
 * rename over the target. Also rewrites the markdown rendering each time.
 */
export function writeReport(
  paths: { reportJson: string; reportMd: string },
  report: CompareReport,
): void {
  atomicWriteJson(paths.reportJson, report);
  writeFileSync(paths.reportMd, renderCompareReportMd(report), "utf8");
}

/** Render the compare report as a Markdown table for human review. */
export function renderCompareReportMd(report: CompareReport): string {
  const lines: string[] = [];
  lines.push("# Baseline vs Agent 对比报告");
  lines.push("");
  lines.push(`- run_id: ${report.run_id}`);
  lines.push(`- timestamp: ${report.timestamp}`);
  lines.push(`- judge_model: ${report.judge_model}`);
  lines.push(`- cases: ${report.cases.length}`);
  lines.push("");
  lines.push("## 各案例对比");
  lines.push("");
  lines.push("| Case | Side | Coverage | Traceability | TestEff | DesignDepth | FinalScore |");
  lines.push("|------|------|----------|--------------|---------|-------------|------------|");
  for (const c of report.cases) {
    const fmt = (v: number | null): string => (typeof v === "number" ? String(v) : "-");
    const b = c.baseline.quality;
    const a = c.agent.quality;
    lines.push(
      `| ${c.case_id} | baseline | ${fmt(b.gold_obligation_coverage)} | ${fmt(b.traceability_truthfulness)} | ${fmt(b.test_effectiveness)} | ${fmt(b.design_depth)} | ${fmt(b.final_score)} |`,
    );
    lines.push(
      `| | agent | ${fmt(a.gold_obligation_coverage)} | ${fmt(a.traceability_truthfulness)} | ${fmt(a.test_effectiveness)} | ${fmt(a.design_depth)} | ${fmt(a.final_score)} |`,
    );
    lines.push(
      `| | **delta** | ${c.delta.gold_obligation_coverage} | ${c.delta.traceability_truthfulness} | ${c.delta.test_effectiveness} | ${c.delta.design_depth} | ${c.delta.final_score} |`,
    );
  }
  lines.push("");
  lines.push("## 汇总");
  lines.push("");
  const agg = report.aggregate;
  lines.push(`- agent_wins: ${agg.agent_wins} / baseline_wins: ${agg.baseline_wins} / ties: ${agg.ties} (on final_score, over ${agg.total_cases} cases)`);
  lines.push("");
  lines.push("| Dimension | MeanBaseline | MeanAgent | MeanDelta(Agent-Baseline) |");
  lines.push("|-----------|--------------|-----------|---------------------------|");
  for (const dim of QUALITY_DIMENSIONS) {
    lines.push(
      `| ${dim} | ${agg.mean_baseline[dim]} | ${agg.mean_agent[dim]} | ${agg.mean_delta[dim]} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Aggregate per-case deltas into the compare report's aggregate block. */
export function aggregateCompare(cases: CompareCaseEntry[]): CompareAggregate {
  const n = cases.length;
  const zero = () => ({ ...EMPTY_DIMENSIONS }) as Record<QualityDimension, number>;
  const sums = {
    baseline: zero(),
    agent: zero(),
    delta: zero(),
  };
  let agentWins = 0;
  let baselineWins = 0;
  let ties = 0;

  for (const c of cases) {
    for (const dim of QUALITY_DIMENSIONS) {
      sums.baseline[dim] += scoreOrZero(c.baseline.quality[dim]);
      sums.agent[dim] += scoreOrZero(c.agent.quality[dim]);
      sums.delta[dim] += c.delta[dim];
    }
    const diff = c.delta.final_score;
    if (diff > 0) agentWins++;
    else if (diff < 0) baselineWins++;
    else ties++;
  }

  const mean = (map: Record<QualityDimension, number>): Record<QualityDimension, number> => {
    const out = zero();
    for (const dim of QUALITY_DIMENSIONS) out[dim] = n > 0 ? round1(map[dim] / n) : 0;
    return out;
  };

  return {
    mean_delta: mean(sums.delta),
    mean_baseline: mean(sums.baseline),
    mean_agent: mean(sums.agent),
    agent_wins: agentWins,
    baseline_wins: baselineWins,
    ties,
    total_cases: n,
  };
}

/** Empty dimensions record (all 0). */
const EMPTY_DIMENSIONS: Record<QualityDimension, number> = {
  gold_obligation_coverage: 0,
  traceability_truthfulness: 0,
  test_effectiveness: 0,
  design_depth: 0,
  final_score: 0,
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the baseline-vs-agent comparison.
 *
 * For each discoverable case (or just `opts.caseId`):
 *   1. Run the baseline (single LLM turn) → Agent-aligned artifacts.
 *   2. Run the agent (multi-stage runtime) → Agent-aligned artifacts.
 *   3. Score both sides with the same gold judge.
 *   4. Compute the delta and incrementally flush the report to disk.
 *
 * Agent runs are slow (20-40 min each). The report is rewritten after EVERY
 * case so a crash mid-run never loses completed cases; use `--case <id>` to
 * batch one case at a time across separate invocations.
 *
 * @param config Agent config (LLM provider + per-case timeout).
 * @param opts   Run options (CLI-derived or programmatic).
 * @returns The final {@link CompareReport}.
 */
export async function runCompare(config: AgentConfig, opts: CompareRunOptions = {}): Promise<CompareReport> {
  const logger = setupLogger("reqdesign.benchmark.compare");
  const casesDir = opts.casesDir ?? DEFAULT_CASES_DIR;
  const goldDir = opts.goldDir ?? DEFAULT_GOLD_DIR;
  const resultsBaseDir = opts.resultsBaseDir ?? DEFAULT_COMPARE_RESULTS_BASE_DIR;
  const runId = opts.runId ?? formatTimestamp();
  const paths = compareRunPaths(resultsBaseDir, runId);
  mkdirSync(paths.root, { recursive: true });

  // --- resolve case scope -------------------------------------------------
  let caseIds = discoverCompareCases(casesDir, goldDir);
  if (opts.caseId) {
    caseIds = caseIds.filter((id) => id === opts.caseId);
    if (caseIds.length === 0) {
      throw new Error(
        `--case ${opts.caseId} matched no case with a gold contract under ${goldDir}`,
      );
    }
  }

  // --- resume: load any already-scored cases from a prior partial ---------
  const existing = loadPartialReport(paths.partialJson);
  const prior = new Map<string, CompareCaseEntry>();
  if (existing) {
    for (const c of existing.cases) prior.set(c.case_id, c);
  }

  const judge: JudgeClient = opts.judge ?? (new LLMClient(config) as unknown as JudgeClient);
  const runtimeFactory = opts.runtimeFactory ?? defaultRuntimeFactory;

  const cases: CompareCaseEntry[] = existing ? [...existing.cases] : [];

  for (const caseId of caseIds) {
    // Skip a case we already scored in a prior partial (incremental resume).
    if (prior.has(caseId)) {
      logger.info(`skipping already-scored case ${caseId}`);
      continue;
    }

    const entry = await runCompareCase(config, {
      caseId,
      casesDir,
      goldDir,
      runRoot: paths.root,
      judge,
      runtimeFactory,
      baselineLlm: opts.baselineLlm,
      skipAgent: opts.skipAgent,
      skipBaseline: opts.skipBaseline,
    });

    // Merge into the cases list (replace if present) and flush immediately.
    const idx = cases.findIndex((c) => c.case_id === caseId);
    if (idx >= 0) cases[idx] = entry;
    else cases.push(entry);

    const partial: CompareReport = {
      run_id: runId,
      timestamp: new Date().toISOString(),
      judge_model: config.llm.model,
      cases: [...cases],
      aggregate: aggregateCompare(cases),
    };
    writeReport({ reportJson: paths.partialJson, reportMd: paths.reportMd }, partial);
    logger.info(`case ${caseId} scored and flushed (baseline final=${entry.baseline.quality.final_score} agent final=${entry.agent.quality.final_score})`);
  }

  // --- finalize -----------------------------------------------------------
  const report: CompareReport = {
    run_id: runId,
    timestamp: new Date().toISOString(),
    judge_model: config.llm.model,
    cases,
    aggregate: aggregateCompare(cases),
  };
  writeReport({ reportJson: paths.reportJson, reportMd: paths.reportMd }, report);

  return report;
}

/** Run + score ONE case's baseline and agent sides. */
async function runCompareCase(
  config: AgentConfig,
  params: {
    caseId: string;
    casesDir: string;
    goldDir: string;
    runRoot: string;
    judge: JudgeClient;
    runtimeFactory: RuntimeFactory;
    baselineLlm?: { generateJson(prompt: string, system?: string): Promise<Record<string, unknown>> };
    skipAgent?: boolean;
    skipBaseline?: boolean;
  },
): Promise<CompareCaseEntry> {
  const { caseId, casesDir, goldDir, runRoot } = params;
  const logger = setupLogger("reqdesign.benchmark.compare.case");
  const casePath = join(casesDir, `${caseId}.md`);
  const gold = loadGoldContract(join(goldDir, `${caseId}.json`));
  if (!gold) {
    throw new Error(`no valid gold contract for case ${caseId} under ${goldDir}`);
  }
  const requirementSource = (() => {
    try {
      return readFileSync(casePath, "utf8");
    } catch {
      return "";
    }
  })();

  const baselineDir = join(runRoot, caseId, "baseline");
  const agentDir = join(runRoot, caseId, "agent");

  // --- baseline side ------------------------------------------------------
  let baseline: SideScore;
  if (params.skipBaseline) {
    baseline = { quality: NULL_SCORES, scored: false, error: "skipped", output_dir: baselineDir };
  } else {
    try {
      const result = await runBaseline({
        config,
        casePath,
        outputDir: baselineDir,
        llm: params.baselineLlm,
      });
      baseline = result.parsed
        ? await scoreSide(params.judge, gold, { caseId, outputDir: baselineDir, requirementSource, side: "baseline" })
        : {
            quality: NULL_SCORES,
            scored: false,
            error: result.error ?? "baseline did not produce parseable output",
            output_dir: baselineDir,
          };
    } catch (err: unknown) {
      baseline = {
        quality: NULL_SCORES,
        scored: false,
        error: `baseline run failed: ${err instanceof Error ? err.message : String(err)}`,
        output_dir: baselineDir,
      };
    }
  }

  // --- agent side ---------------------------------------------------------
  let agent: SideScore;
  if (params.skipAgent) {
    agent = { quality: NULL_SCORES, scored: false, error: "skipped", output_dir: agentDir };
  } else {
    agent = await runAgentSide(config, {
      caseId,
      casePath,
      agentDir,
      gold,
      requirementSource,
      judge: params.judge,
      runtimeFactory: params.runtimeFactory,
    });
  }

  const delta = computeDelta(baseline, agent);
  if (!baseline.scored) logger.warn(`baseline not scored for ${caseId}: ${baseline.error ?? "?"}`);
  if (!agent.scored) logger.warn(`agent not scored for ${caseId}: ${agent.error ?? "?"}`);

  return { case_id: caseId, baseline, agent, delta };
}

/**
 * Run the Agent pipeline for one case and score its artifacts. The runtime
 * writes the Agent-aligned layout directly into `agentDir`.
 */
async function runAgentSide(
  config: AgentConfig,
  params: {
    caseId: string;
    casePath: string;
    agentDir: string;
    gold: GoldContract;
    requirementSource: string;
    judge: JudgeClient;
    runtimeFactory: RuntimeFactory;
  },
): Promise<SideScore> {
  const { caseId, casePath, agentDir, gold, requirementSource, judge, runtimeFactory } = params;
  const logger = setupLogger("reqdesign.benchmark.compare.agent");
  const runtime: RuntimeLike = runtimeFactory(config);
  const timeoutSeconds = config.benchmark.caseTimeoutSeconds;

  try {
    // Timeout race mirrors the v2 runner: clear the timer on both paths so it
    // never pins the event loop open.
    if (timeoutSeconds > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`agent case timeout after ${timeoutSeconds}s`)),
          timeoutSeconds * 1000,
        );
      });
      try {
        await Promise.race([runtime.run("design", casePath, agentDir), timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } else {
      await runtime.run("design", casePath, agentDir);
    }
  } catch (err: unknown) {
    return {
      quality: NULL_SCORES,
      scored: false,
      error: `agent run failed: ${err instanceof Error ? err.message : String(err)}`,
      output_dir: agentDir,
    };
  }

  try {
    return await scoreSide(judge, gold, { caseId, outputDir: agentDir, requirementSource, side: "agent" });
  } catch (err: unknown) {
    logger.warn(`agent score failed for ${caseId}: ${err instanceof Error ? err.message : String(err)}`);
    return {
      quality: NULL_SCORES,
      scored: false,
      error: `agent score failed: ${err instanceof Error ? err.message : String(err)}`,
      output_dir: agentDir,
    };
  }
}

/** Default runtime factory: real MultiAgentRuntime (slow, real Agent pipeline). */
function defaultRuntimeFactory(config: AgentConfig): RuntimeLike {
  return new MultiAgentRuntime(config);
}
