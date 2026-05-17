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
});
