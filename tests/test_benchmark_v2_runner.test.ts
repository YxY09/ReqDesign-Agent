/**
 * Phase-1 unit tests: benchmarkRunner.ts — end-to-end dev + eval orchestration
 * with a mock runtime factory, plus CLI parsing. No real LLM/runtime involved.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentConfig } from "../src/config.js";
import type { RuntimeFactory } from "../src/benchmark/runtimeContract.js";
import { BenchmarkRunnerV2, parseBenchmarkCliArgs } from "../src/benchmark/benchmarkRunner.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bench-v2-runner-"));
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Lay down a cases dir + gold dir with N cases. */
function seedCases(casesDir: string, goldDir: string, ids: string[]): void {
  mkdirSync(casesDir, { recursive: true });
  mkdirSync(goldDir, { recursive: true });
  for (const id of ids) {
    writeFileSync(join(casesDir, `${id}.md`), `# ${id}`, "utf8");
    writeFileSync(join(goldDir, `${id}.json`), "{}", "utf8");
  }
}

/**
 * Write the on-disk artifact layout the v2 runner scans for Layer-0 presence.
 * Mirrors OutputManager's sub-dir layout (requirement/design/diagrams/tests)
 * so scanPresentArtifacts reports a complete set for a well-formed run.
 */
function writeArtifactSet(outputDir: string, diagrams: Record<string, unknown>): void {
  mkdirSync(join(outputDir, "requirement"), { recursive: true });
  writeFileSync(join(outputDir, "requirement", "analysis.json"), "{}", "utf8");
  mkdirSync(join(outputDir, "design"), { recursive: true });
  writeFileSync(join(outputDir, "design", "system_design.md"), "# design", "utf8");
  mkdirSync(join(outputDir, "diagrams"), { recursive: true });
  for (const [name, src] of Object.entries(diagrams)) {
    if (src && String(src).trim()) {
      writeFileSync(join(outputDir, "diagrams", `${name}.mmd`), String(src), "utf8");
    }
  }
  mkdirSync(join(outputDir, "tests"), { recursive: true });
  writeFileSync(join(outputDir, "tests", "test_cases.md"), "# tests", "utf8");
}

/** Build a runtime factory whose `run()` returns a fixed well-formed state. */
function mockFactory(): { factory: RuntimeFactory; count: () => number } {
  let n = 0;
  const state = {
    requirementJson: { entities: [{ name: "User" }] },
    diagrams: {
      class_diagram: "classDiagram\n  class User",
      activity_diagram: "flowchart TD\n  A[开始] --> B{判断}",
      state_diagram: "stateDiagram-v2\n  [*] --> Open\n  Open --> [*]",
    },
    getMajorPendingTaskIds: () => [],
    finalReviewPassed: true,
    persisted: true,
    qualityStatus: "passed",
    reviewResult: {},
  };
  return {
    count: () => n,
    factory: () => ({
      run: (_goal: string, _inputPath: string, outputDir: string) => {
        n += 1;
        writeArtifactSet(outputDir, state.diagrams);
        return Promise.resolve(state);
      },
      cancel: () => {},
    }),
  };
}

describe("BenchmarkRunnerV2 — dev mode", () => {
  it("runs each case once and writes the v2 result tree", async () => {
    const casesDir = join(root, "cases");
    const goldDir = join(root, "gold");
    seedCases(casesDir, goldDir, ["library", "hospital"]);

    const { factory, count } = mockFactory();
    const runner = new BenchmarkRunnerV2(new AgentConfig(), casesDir, goldDir, factory);

    const report = await runner.run({
      mode: "dev",
      numRuns: 1,
      resume: false,
      onlyFailed: false,
      resultsBaseDir: root,
      cwd: process.cwd(),
      label: "test",
    });

    // dev mode forces numRuns = 1
    expect(report.metadata.mode).toBe("dev");
    expect(report.metadata.num_runs).toBe(1);
    expect(report.summary.completed).toBe(true);
    expect(report.summary.entries).toHaveLength(2);
    expect(count()).toBe(2);

    // Both runs valid (well-formed mock) and quality still null (Phase-1 placeholder).
    for (const e of report.summary.entries) {
      expect(e.status).toBe("valid");
      expect(e.final_score).toBeNull();
    }

    // On-disk artifacts exist.
    const bid = report.metadata.benchmark_id;
    const resultPath = join(root, bid, "cases", "library", "run_0", "result.json");
    expect(existsSync(resultPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(onDisk.quality.final_score).toBeNull();
  });

  it("marks a run invalid when the sanity gate fails", async () => {
    const casesDir = join(root, "cases");
    const goldDir = join(root, "gold");
    seedCases(casesDir, goldDir, ["bad"]);

    // Factory returns a state with a dangling entity → sanity gate fails.
    const badState = {
      requirementJson: { entities: [{ name: "Phantom" }] },
      diagrams: { class_diagram: "classDiagram\n  class Real" },
      getMajorPendingTaskIds: () => [],
      finalReviewPassed: true,
      persisted: true,
      qualityStatus: "passed",
      reviewResult: {},
    };
    const factory: RuntimeFactory = () => ({
      run: (_goal: string, _inputPath: string, outputDir: string) => {
        // Full artifact set on disk → the ONLY sanity failure is the dangling
        // entity, not missing artifacts.
        writeArtifactSet(outputDir, badState.diagrams);
        return Promise.resolve(badState);
      },
      cancel: () => {},
    });

    const runner = new BenchmarkRunnerV2(new AgentConfig(), casesDir, goldDir, factory);
    const report = await runner.run({
      mode: "dev",
      numRuns: 1,
      resume: false,
      onlyFailed: false,
      resultsBaseDir: root,
    });
    expect(report.summary.entries[0].status).toBe("invalid");
    expect(report.summary.entries[0].sanity_passed).toBe(false);
  });
});

describe("BenchmarkRunnerV2 — eval mode", () => {
  it("runs N times per case and computes aggregates", async () => {
    const casesDir = join(root, "cases");
    const goldDir = join(root, "gold");
    seedCases(casesDir, goldDir, ["c1"]);

    const { factory, count } = mockFactory();
    const runner = new BenchmarkRunnerV2(new AgentConfig(), casesDir, goldDir, factory);

    const report = await runner.run({
      mode: "eval",
      numRuns: 3,
      resume: false,
      onlyFailed: false,
      resultsBaseDir: root,
    });
    expect(report.metadata.num_runs).toBe(3);
    expect(report.summary.entries).toHaveLength(3);
    expect(count()).toBe(3);
    expect(report.summary.aggregates).toBeDefined();
    expect(report.summary.aggregates!.valid_run_rate).toBe(100);
    // final scores are null in Phase 1 → mean/std null.
    expect(report.summary.aggregates!.final_score_mean).toBeNull();
  });
});

describe("BenchmarkRunnerV2 — resume", () => {
  it("skips already-completed runs when resume is true", async () => {
    const casesDir = join(root, "cases");
    const goldDir = join(root, "gold");
    seedCases(casesDir, goldDir, ["c1"]);

    const { factory, count } = mockFactory();
    const runner = new BenchmarkRunnerV2(new AgentConfig(), casesDir, goldDir, factory);

    const first = await runner.run({
      mode: "dev",
      numRuns: 1,
      resume: false,
      onlyFailed: false,
      resultsBaseDir: root,
    });
    const bid = first.metadata.benchmark_id;

    // Second run resumes into the same dir → no new runtime invocations.
    const { factory: factory2, count: count2 } = mockFactory();
    const runner2 = new BenchmarkRunnerV2(new AgentConfig(), casesDir, goldDir, factory2);
    const second = await runner2.run({
      mode: "dev",
      numRuns: 1,
      resume: true,
      onlyFailed: false,
      resultsBaseDir: root,
      benchmarkId: bid,
    });
    expect(second.metadata.benchmark_id).toBe(bid);
    expect(count2()).toBe(0);
    void count;
  });

  it("throws when --resume is given without --benchmark-id (no silent fresh run)", async () => {
    const casesDir = join(root, "cases");
    const goldDir = join(root, "gold");
    seedCases(casesDir, goldDir, ["c1"]);

    const { factory } = mockFactory();
    const runner = new BenchmarkRunnerV2(new AgentConfig(), casesDir, goldDir, factory);

    // Problem 1: previously this silently started a fresh run (new id,
    // discarding the resume intent). It must now throw a clear error.
    await expect(
      runner.run({
        mode: "dev",
        numRuns: 1,
        resume: true,
        onlyFailed: false,
        resultsBaseDir: root,
        // benchmarkId intentionally omitted
      }),
    ).rejects.toThrow(/--resume.*--benchmark-id/);
  });

  it("--benchmark-id latest resumes into the most recent run dir", async () => {
    const casesDir = join(root, "cases");
    const goldDir = join(root, "gold");
    seedCases(casesDir, goldDir, ["c1"]);

    // Create two prior runs with distinct metadata timestamps; the later one
    // must be selected by `latest`.
    const olderId = "abc_20240101_000000";
    const newerId = "abc_20240617_120000";
    for (const id of [olderId, newerId]) {
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(
        join(root, id, "metadata.json"),
        JSON.stringify({ benchmark_id: id, timestamp: id.split("_").slice(1).join("_") }),
        "utf8",
      );
    }

    const { factory, count } = mockFactory();
    const runner = new BenchmarkRunnerV2(new AgentConfig(), casesDir, goldDir, factory);
    const report = await runner.run({
      mode: "dev",
      numRuns: 1,
      resume: true,
      onlyFailed: false,
      resultsBaseDir: root,
      benchmarkId: "latest",
    });
    expect(report.metadata.benchmark_id).toBe(newerId);
    // No completed runs in the selected dir → it re-runs the case.
    expect(count()).toBe(1);
  });

  it("--benchmark-id latest throws when no prior runs exist", async () => {
    const casesDir = join(root, "cases");
    const goldDir = join(root, "gold");
    seedCases(casesDir, goldDir, ["c1"]);

    const { factory } = mockFactory();
    const runner = new BenchmarkRunnerV2(new AgentConfig(), casesDir, goldDir, factory);

    await expect(
      runner.run({
        mode: "dev",
        numRuns: 1,
        resume: true,
        onlyFailed: false,
        resultsBaseDir: root,
        benchmarkId: "latest",
      }),
    ).rejects.toThrow(/latest.*未找到/);
  });
});

describe("parseBenchmarkCliArgs", () => {
  it("parses dev defaults", () => {
    const opts = parseBenchmarkCliArgs([])!;
    expect(opts.mode).toBe("dev");
    expect(opts.numRuns).toBe(1);
    expect(opts.resume).toBe(false);
  });

  it("parses --mode eval --n 5 --resume --case x --only-failed", () => {
    const opts = parseBenchmarkCliArgs([
      "--mode", "eval", "--n", "5", "--resume", "--case", "x", "--only-failed",
    ])!;
    expect(opts.mode).toBe("eval");
    expect(opts.numRuns).toBe(5);
    expect(opts.resume).toBe(true);
    expect(opts.caseId).toBe("x");
    expect(opts.onlyFailed).toBe(true);
  });

  it("returns null for --help", () => {
    expect(parseBenchmarkCliArgs(["--help"])).toBeNull();
  });

  it("rejects invalid --mode", () => {
    expect(() => parseBenchmarkCliArgs(["--mode", "nope"])).toThrow(/dev 或 eval/);
  });

  it("rejects non-positive --n", () => {
    expect(() => parseBenchmarkCliArgs(["--n", "0"])).toThrow(/正整数/);
  });

  it("rejects unknown args", () => {
    expect(() => parseBenchmarkCliArgs(["--bogus"])).toThrow(/未知参数/);
  });
});
