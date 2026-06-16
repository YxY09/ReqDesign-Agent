/**
 * Phase-1 unit tests: metadata.ts — benchmark_id format, timestamp, git
 * fallback, and metadata field assembly. Fully offline.
 */
import { describe, it, expect } from "vitest";
import { AgentConfig } from "../src/config.js";
import {
  RUNNER_VERSION,
  SCORING_VERSION,
  buildMetadata,
  formatTimestamp,
  generateBenchmarkId,
  getCommitShort,
  isGitDirty,
} from "../src/benchmark/metadata.js";

describe("formatTimestamp", () => {
  it("produces YYYYMMDD_HHMMSS with zero-padding", () => {
    const ts = formatTimestamp(new Date(2026, 5, 17, 9, 5, 3));
    expect(ts).toBe("20260617_090503");
  });
});

describe("generateBenchmarkId", () => {
  it("is commit_timestamp without a label", () => {
    expect(generateBenchmarkId({ commitShort: "a13f9c2", timestamp: "20260617_153022" })).toBe(
      "a13f9c2_20260617_153022",
    );
  });

  it("appends an optional label after an underscore", () => {
    expect(
      generateBenchmarkId({ commitShort: "a13f9c2", timestamp: "20260617_153022", label: "phase1" }),
    ).toBe("a13f9c2_20260617_153022_phase1");
  });

  it("replaces whitespace/slashes in the label", () => {
    expect(
      generateBenchmarkId({ commitShort: "abc", timestamp: "t", label: "my label/x" }),
    ).toBe("abc_t_my_label_x");
  });

  it("omits the label segment when label is empty/whitespace", () => {
    expect(generateBenchmarkId({ commitShort: "abc", timestamp: "t", label: "   " })).toBe("abc_t");
  });

  it("falls back to 'nogit' when commitShort is absent", () => {
    expect(generateBenchmarkId({ timestamp: "t" })).toMatch(/^nogit_t$/);
  });
});

describe("git helpers", () => {
  it("returns a short hash inside this repo", () => {
    const commit = getCommitShort(process.cwd());
    expect(commit).toMatch(/^[0-9a-f]{4,}$/);
  });

  it("isGitDirty returns a boolean", () => {
    expect(typeof isGitDirty(process.cwd())).toBe("boolean");
  });

  it("getCommitShort returns 'unknown' for a non-git directory", () => {
    // A fresh temp path under tmp is not a git repo.
    const fake = `${process.cwd()}/.tmp-not-a-git-dir-${Date.now()}`;
    expect(getCommitShort(fake)).toBe("unknown");
  });

  it("isGitDirty defaults to true when git is unavailable", () => {
    const fake = `${process.cwd()}/.tmp-not-a-git-dir-${Date.now()}`;
    expect(isGitDirty(fake)).toBe(true);
  });
});

describe("buildMetadata", () => {
  const config = new AgentConfig({ llm: { model: "DeepSeek-V3" } as never });

  it("assembles all required fields with the right shapes", () => {
    const meta = buildMetadata({
      cwd: process.cwd(),
      mode: "dev",
      numRuns: 1,
      caseIds: ["library", "hospital"],
      config,
      label: "phase1",
      overrides: { commitShort: "a13f9c2", timestamp: "20260617_153022" },
    });

    expect(meta.benchmark_id).toBe("a13f9c2_20260617_153022_phase1");
    expect(meta.commit_short).toBe("a13f9c2");
    expect(meta.timestamp).toBe("20260617_153022");
    expect(meta.mode).toBe("dev");
    expect(meta.num_runs).toBe(1);
    expect(meta.case_ids).toEqual(["library", "hospital"]);
    expect(meta.scoring_version).toBe(SCORING_VERSION);
    expect(meta.runner_version).toBe(RUNNER_VERSION);
    expect(meta.judge_model).toBe("DeepSeek-V3");
    expect(typeof meta.git_dirty).toBe("boolean");
  });

  it("copies case_ids defensively", () => {
    const ids = ["a"];
    const meta = buildMetadata({
      cwd: process.cwd(),
      mode: "eval",
      numRuns: 3,
      caseIds: ids,
      config,
    });
    ids.push("b");
    expect(meta.case_ids).toEqual(["a"]);
  });
});
