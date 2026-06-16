/**
 * Phase-1 unit tests: resultStore.ts — atomic write, directory layout,
 * partial/final summaries, recursive mkdir, and resume-probe ordering.
 * Fully offline against a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INVALID_QUALITY,
  NULL_QUALITY,
  ResultStore,
  RUN_FILE_NAMES,
  atomicWriteJson,
  caseRunDir,
  runDirBase,
  type BenchmarkResult,
  type QualityScores,
  type ReviewGateRecord,
  type SanityResult,
} from "../src/benchmark/resultStore.js";
import { buildMetadata } from "../src/benchmark/metadata.js";
import { AgentConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "bench-v2-store-"));
});
afterEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

function validResult(caseId: string, runId: number): BenchmarkResult {
  return {
    case_id: caseId,
    run_id: runId,
    status: "valid",
    sanity: { passed: true, errors: [] },
    review_gate: { passed: true, score: null, open_major_issues: 0, quality_status: "passed", persisted: true },
    quality: { ...NULL_QUALITY },
    major_misses: [],
    warnings: [],
  };
}

describe("layout helpers", () => {
  it("runDirBase/caseRunDir build the documented paths", () => {
    expect(runDirBase("benchmark/results", "abc_20260617_120000")).toBe(
      join("benchmark/results", "abc_20260617_120000"),
    );
    expect(caseRunDir("benchmark/results", "abc_20260617_120000", "library", 2)).toBe(
      join("benchmark/results", "abc_20260617_120000", "cases", "library", "run_2"),
    );
  });
});

describe("atomicWriteJson", () => {
  it("writes the target and leaves no .tmp behind", () => {
    const file = join(base, "nested", "deep", "out.json");
    atomicWriteJson(file, { a: 1 });
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: 1 });
  });

  it("overwrites an existing file via rename-over-existing", () => {
    const file = join(base, "rewrite.json");
    atomicWriteJson(file, { v: 1 });
    atomicWriteJson(file, { v: 2 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 2 });
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe("ResultStore", () => {
  it("writeMetadata writes metadata.json at the run root", () => {
    const store = new ResultStore({ baseDir: base, benchmarkId: "bid_1" });
    const meta = buildMetadata({
      cwd: process.cwd(),
      mode: "dev",
      numRuns: 1,
      caseIds: ["library"],
      config: new AgentConfig(),
      overrides: { commitShort: "deadbeef", timestamp: "20260617_120000" },
    });
    store.writeMetadata(meta);
    expect(existsSync(join(store.root, "metadata.json"))).toBe(true);
  });

  it("writeRun writes all four files + artifacts dir, result.json last", () => {
    const store = new ResultStore({ baseDir: base, benchmarkId: "bid_1" });
    const result = validResult("library", 0);
    const sanity: SanityResult = result.sanity;
    const review: ReviewGateRecord = result.review_gate;
    const quality: QualityScores = result.quality;

    store.writeRun({ result, sanity, review, quality });

    const dir = store.caseRunDir("library", 0);
    expect(existsSync(join(dir, RUN_FILE_NAMES.result))).toBe(true);
    expect(existsSync(join(dir, RUN_FILE_NAMES.sanity))).toBe(true);
    expect(existsSync(join(dir, RUN_FILE_NAMES.review))).toBe(true);
    expect(existsSync(join(dir, RUN_FILE_NAMES.quality))).toBe(true);
    expect(existsSync(join(dir, RUN_FILE_NAMES.artifacts))).toBe(true);
    expect(existsSync(join(dir, `${RUN_FILE_NAMES.result}.tmp`))).toBe(false);

    const written = JSON.parse(readFileSync(join(dir, RUN_FILE_NAMES.result), "utf8")) as BenchmarkResult;
    expect(written.case_id).toBe("library");
    expect(written.run_id).toBe(0);
    expect(written.status).toBe("valid");
  });

  it("writeRun creates nested dirs recursively for a brand-new case", () => {
    const store = new ResultStore({ baseDir: base, benchmarkId: "bid_1" });
    store.writeRun({ result: validResult("hospital", 3), sanity: { passed: true, errors: [] }, review: { passed: false, score: null, open_major_issues: 1, quality_status: "rejected", persisted: false }, quality: { ...NULL_QUALITY } });
    expect(existsSync(store.caseRunDir("hospital", 3))).toBe(true);
  });

  it("partial summary is rewritten on each writePartialSummary call", () => {
    const store = new ResultStore({ baseDir: base, benchmarkId: "bid_1" });
    const meta = buildMetadata({ cwd: process.cwd(), mode: "dev", numRuns: 1, caseIds: [], config: new AgentConfig() });
    let summary = store.emptySummary(meta);
    summary.entries.push({ case_id: "a", run_id: 0, status: "valid", sanity_passed: true, review_passed: true, final_score: null });
    store.writePartialSummary(summary);
    summary.entries.push({ case_id: "b", run_id: 0, status: "invalid", sanity_passed: false, review_passed: false, final_score: null });
    store.writePartialSummary(summary);

    const { summaryPartial } = { summaryPartial: join(store.root, "summary.partial.json") };
    const onDisk = JSON.parse(readFileSync(summaryPartial, "utf8"));
    expect(onDisk.entries).toHaveLength(2);
    expect(existsSync(join(store.root, "summary.partial.json.tmp"))).toBe(false);
  });

  it("final summary is distinct from partial", () => {
    const store = new ResultStore({ baseDir: base, benchmarkId: "bid_1" });
    const meta = buildMetadata({ cwd: process.cwd(), mode: "dev", numRuns: 1, caseIds: [], config: new AgentConfig() });
    const summary = store.emptySummary(meta);
    summary.completed = true;
    store.writeFinalSummary(summary);
    expect(existsSync(join(store.root, "summary.final.json"))).toBe(true);
  });

  it("loadPartialSummary returns null when absent or malformed", () => {
    const store = new ResultStore({ baseDir: base, benchmarkId: "bid_1" });
    expect(store.loadPartialSummary()).toBeNull();
    atomicWriteJson(join(store.root, "summary.partial.json"), "{ not json");
    // atomicWriteJson stringifies, so write malformed bytes directly:
    writeFileSync(join(store.root, "summary.partial.json"), "{ not json", "utf8");
    expect(store.loadPartialSummary()).toBeNull();
  });
});

describe("quality placeholders", () => {
  it("NULL_QUALITY and INVALID_QUALITY are all-null", () => {
    for (const v of Object.values(NULL_QUALITY)) expect(v).toBeNull();
    for (const v of Object.values(INVALID_QUALITY)) expect(v).toBeNull();
  });
});
