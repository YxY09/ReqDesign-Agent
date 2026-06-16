/**
 * Phase-1 unit tests: resume.ts — complete/.tmp/malformed/missing detection,
 * skip logic, and failed-case listing. Fully offline against a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findCompletedRuns,
  findLatestBenchmarkId,
  isRunComplete,
  listFailedCases,
  resolveCaseScope,
  shouldSkipRun,
} from "../src/benchmark/resume.js";
import { RUN_FILE_NAMES } from "../src/benchmark/resultStore.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bench-v2-resume-"));
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeResult(dir: string, payload: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, RUN_FILE_NAMES.result), JSON.stringify(payload), "utf8");
}

describe("isRunComplete", () => {
  it("is true for a well-formed result.json", () => {
    const dir = join(root, "run_0");
    writeResult(dir, { case_id: "a", run_id: 0, status: "valid" });
    expect(isRunComplete(dir)).toBe(true);
  });

  it("is false when result.json is missing", () => {
    const dir = join(root, "run_0");
    mkdirSync(dir, { recursive: true });
    expect(isRunComplete(dir)).toBe(false);
  });

  it("is false when a .tmp leftover exists (interrupted write)", () => {
    const dir = join(root, "run_0");
    writeResult(dir, { case_id: "a", run_id: 0, status: "valid" });
    writeFileSync(join(dir, `${RUN_FILE_NAMES.result}.tmp`), "partial", "utf8");
    expect(isRunComplete(dir)).toBe(false);
  });

  it("is false when result.json is malformed JSON", () => {
    const dir = join(root, "run_0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, RUN_FILE_NAMES.result), "{ broken", "utf8");
    expect(isRunComplete(dir)).toBe(false);
  });

  it("is false when the shape lacks status/case_id/run_id", () => {
    const dir = join(root, "run_0");
    writeResult(dir, { foo: "bar" });
    expect(isRunComplete(dir)).toBe(false);
  });
});

describe("findCompletedRuns", () => {
  it("collects only the run ids whose result.json is complete", () => {
    const caseDir = join(root, "library");
    writeResult(join(caseDir, "run_0"), { case_id: "library", run_id: 0, status: "valid" });
    mkdirSync(join(caseDir, "run_1"), { recursive: true }); // empty → incomplete
    writeResult(join(caseDir, "run_2"), { case_id: "library", run_id: 2, status: "invalid" });
    expect(findCompletedRuns(caseDir)).toEqual(new Set([0, 2]));
  });

  it("returns empty set for a missing case dir", () => {
    expect(findCompletedRuns(join(root, "nope"))).toEqual(new Set());
  });
});

describe("shouldSkipRun", () => {
  const opts = (resume: boolean) => ({ resume, onlyFailed: false, numRuns: 3, caseId: undefined });

  it("never skips when resume is false", () => {
    expect(shouldSkipRun(0, new Set([0]), opts(false))).toBe(false);
  });

  it("skips completed runs when resume is true", () => {
    expect(shouldSkipRun(0, new Set([0]), opts(true))).toBe(true);
    expect(shouldSkipRun(1, new Set([0]), opts(true))).toBe(false);
  });
});

describe("listFailedCases", () => {
  it("lists cases whose every completed run is invalid", () => {
    // caseA: one valid run → not failed
    writeResult(join(root, "caseA", "run_0"), { case_id: "caseA", run_id: 0, status: "valid" });
    // caseB: two invalid runs → failed
    writeResult(join(root, "caseB", "run_0"), { case_id: "caseB", run_id: 0, status: "invalid" });
    writeResult(join(root, "caseB", "run_1"), { case_id: "caseB", run_id: 1, status: "invalid" });
    // caseC: never ran → not failed (just absent)
    expect(listFailedCases(root)).toEqual(new Set(["caseB"]));
  });

  it("returns empty set when the cases root is missing", () => {
    expect(listFailedCases(join(root, "nope"))).toEqual(new Set());
  });
});

describe("findLatestBenchmarkId", () => {
  it("returns null when the results base dir is missing", () => {
    expect(findLatestBenchmarkId(join(root, "nope"))).toBeNull();
  });

  it("returns null when there are no run dirs", () => {
    expect(findLatestBenchmarkId(root)).toBeNull();
  });

  it("picks the run whose metadata.json has the greatest timestamp", () => {
    for (const [id, ts] of [
      ["runA_20240101_000000", "20240101_000000"],
      ["runB_20240617_120000", "20240617_120000"],
      ["runC_20240315_080000", "20240315_080000"],
    ] as const) {
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(
        join(root, id, "metadata.json"),
        JSON.stringify({ benchmark_id: id, timestamp: ts }),
        "utf8",
      );
    }
    expect(findLatestBenchmarkId(root)).toBe("runB_20240617_120000");
  });

  it("ignores dirs without metadata.json (stray sub-dirs never win latest)", () => {
    // Only one real run (has metadata.json); the stray dir without metadata
    // is ignored even though its name would sort later.
    mkdirSync(join(root, "real_20240101_000000"), { recursive: true });
    writeFileSync(
      join(root, "real_20240101_000000", "metadata.json"),
      JSON.stringify({ benchmark_id: "real_20240101_000000", timestamp: "20240101_000000" }),
      "utf8",
    );
    mkdirSync(join(root, "zzz_stray"), { recursive: true });
    expect(findLatestBenchmarkId(root)).toBe("real_20240101_000000");
  });
});

describe("resolveCaseScope", () => {
  const opts = (o: Partial<{ resume: boolean; onlyFailed: boolean; caseId: string; numRuns: number }> = {}) => ({
    resume: false,
    onlyFailed: false,
    numRuns: 1,
    ...o,
  });

  it("returns all discovered cases by default", () => {
    expect(
      resolveCaseScope({ discoveredCaseIds: ["a", "b", "c"], failedCaseIds: new Set(), opts: opts() }),
    ).toEqual(["a", "b", "c"]);
  });

  it("--case narrows to a single id", () => {
    expect(
      resolveCaseScope({ discoveredCaseIds: ["a", "b"], failedCaseIds: new Set(), opts: opts({ caseId: "b" }) }),
    ).toEqual(["b"]);
  });

  it("--only-failed intersects with failed set", () => {
    expect(
      resolveCaseScope({
        discoveredCaseIds: ["a", "b", "c"],
        failedCaseIds: new Set(["b"]),
        opts: opts({ onlyFailed: true }),
      }),
    ).toEqual(["b"]);
  });

  it("--case + --only-failed combine", () => {
    expect(
      resolveCaseScope({
        discoveredCaseIds: ["a", "b", "c"],
        failedCaseIds: new Set(["b", "c"]),
        opts: opts({ onlyFailed: true, caseId: "b" }),
      }),
    ).toEqual(["b"]);
    // a case that is --case but NOT failed → filtered out by only-failed
    expect(
      resolveCaseScope({
        discoveredCaseIds: ["a", "b", "c"],
        failedCaseIds: new Set(["b", "c"]),
        opts: opts({ onlyFailed: true, caseId: "a" }),
      }),
    ).toEqual([]);
  });
});
