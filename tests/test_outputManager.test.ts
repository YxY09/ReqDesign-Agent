/**
 * Tests for OutputManager summary report generation.
 *
 * Ported from tests/test_output_manager.py.
 */
import { describe, it, expect, afterEach } from "vitest";
import { OutputManager } from "../src/outputManager.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp output directory for each test. */
function makeTempDir(): string {
  const base = join(process.cwd(), ".tmp-test-output");
  // Use a unique subdir per invocation to avoid collisions
  const dir = join(base, `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OutputManager – summary report", () => {
  let tempDir: string;

  afterEach(() => {
    // Clean up temp directories
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("summary report uses current review schema", () => {
    tempDir = makeTempDir();
    const manager = new OutputManager(tempDir);

    manager.saveAll(
      {
        actors: [{ name: "Patient" }],
        functions: [{ id: "F001", name: "Register" }],
        entities: [{ name: "Patient" }],
        constraints: [],
        exceptions: [],
      },
      "requirement",
      "design",
      {},
      "tests",
      {
        passed: true,
        issues: [
          { severity: "major", description: "missing response format" },
          { severity: "minor", description: "wording" },
        ],
      },
    );

    const summary = readFileSync(join(tempDir, "summary_report.md"), {
      encoding: "utf-8",
    });

    expect(summary).toContain("- 综合得分: 未提供");
    expect(summary).toContain("- 审查通过: 是");
    expect(summary).toContain("- 问题总数: 2");
    expect(summary).toContain("- 问题分布: blocker=0, major=1, minor=1");
  });

  it("summary report lists unresolved issues as known limitations (accept-with-annotation)", () => {
    tempDir = makeTempDir();
    const manager = new OutputManager(tempDir);

    manager.saveAll(
      { actors: [], functions: [], entities: [], constraints: [], exceptions: [] },
      "requirement",
      "design",
      {},
      "tests",
      {
        passed: true,
        issues: [
          { severity: "minor", description: "命名风格不一致" },
          {
            severity: "major",
            target: "design-1",
            targetType: "design",
            description: "未覆盖取消流程的补偿逻辑",
            suggestion: "补充补偿与回滚处理",
          },
        ],
      },
    );

    const summary = readFileSync(join(tempDir, "summary_report.md"), {
      encoding: "utf-8",
    });

    expect(summary).toContain("## 已知局限（未解决的评审意见）");
    expect(summary).toContain("未覆盖取消流程的补偿逻辑");
    expect(summary).toContain("建议：补充补偿与回滚处理");
    expect(summary).toContain("命名风格不一致");
    // Ordered blocker → major → minor: the major issue precedes the minor one.
    expect(summary.indexOf("未覆盖取消流程的补偿逻辑")).toBeLessThan(
      summary.indexOf("命名风格不一致"),
    );
  });

  it("summary report omits the known-limitations section when there are no issues", () => {
    tempDir = makeTempDir();
    const manager = new OutputManager(tempDir);

    manager.saveAll(
      { actors: [], functions: [], entities: [], constraints: [], exceptions: [] },
      "requirement",
      "design",
      {},
      "tests",
      { passed: true, issues: [] },
    );

    const summary = readFileSync(join(tempDir, "summary_report.md"), {
      encoding: "utf-8",
    });

    expect(summary).not.toContain("## 已知局限");
  });

  it("saveAll writes review/report.md with formatted content (not empty)", () => {
    tempDir = makeTempDir();
    const manager = new OutputManager(tempDir);

    manager.saveAll(
      {
        actors: [],
        functions: [],
        entities: [],
        constraints: [],
        exceptions: [],
      },
      "requirement",
      "design",
      {},
      "tests",
      {
        passed: false,
        issues: [
          { severity: "blocker", description: "critical flaw", suggestion: "Fix it" },
          { severity: "minor", description: "typo" },
        ],
      },
    );

    const report = readFileSync(join(tempDir, "review", "report.md"), {
      encoding: "utf-8",
    });

    expect(report).toContain("# Review Report");
    expect(report).toContain("Total issues: 2");
    expect(report).toContain("Blockers: 1");
    expect(report).toContain("Minor: 1");
    expect(report).toContain("[BLOCKER] critical flaw");
    expect(report).toContain("[MINOR] typo");
    expect(report).toContain("Fix it");
  });
});
