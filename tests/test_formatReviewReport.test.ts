/**
 * Tests for formatReviewReport – Markdown report generation from reviewResult.
 *
 * Covers:
 * - Empty issues → summary with zeros
 * - Issues grouped by severity
 * - Single issue formatting (description, suggestion, scope)
 * - Missing/null fields handled gracefully
 */
import { describe, it, expect } from "vitest";
import { formatReviewReport } from "../src/formatReviewReport.js";

describe("formatReviewReport", () => {
  it("produces a summary with zeros when there are no issues", () => {
    const result = {
      passed: true,
      issues: [],
    };

    const md = formatReviewReport(result);

    expect(md).toContain("# Review Report");
    expect(md).toContain("Total issues: 0");
    expect(md).toContain("Blockers: 0");
    expect(md).toContain("Major: 0");
    expect(md).toContain("Minor: 0");
    expect(md).toContain("## Issues");
  });

  it("counts issues by severity correctly", () => {
    const result = {
      passed: false,
      issues: [
        { severity: "blocker", description: "b1", suggestion: "" },
        { severity: "blocker", description: "b2", suggestion: "" },
        { severity: "major", description: "m1", suggestion: "" },
        { severity: "minor", description: "n1", suggestion: "" },
        { severity: "minor", description: "n2", suggestion: "" },
        { severity: "minor", description: "n3", suggestion: "" },
      ],
    };

    const md = formatReviewReport(result);

    expect(md).toContain("Total issues: 6");
    expect(md).toContain("Blockers: 2");
    expect(md).toContain("Major: 1");
    expect(md).toContain("Minor: 3");
  });

  it("formats each issue with severity, description, suggestion, and scope", () => {
    const result = {
      passed: false,
      issues: [
        {
          severity: "blocker",
          description: "Critical security flaw",
          suggestion: "Add authentication",
          scope: "systemic",
        },
        {
          severity: "major",
          description: "Missing error handling",
          suggestion: "Add try-catch",
          scope: "local",
        },
      ],
    };

    const md = formatReviewReport(result);

    expect(md).toContain("[BLOCKER] Critical security flaw");
    expect(md).toContain("Add authentication");
    expect(md).toContain("Scope: systemic");
    expect(md).toContain("[MAJOR] Missing error handling");
    expect(md).toContain("Add try-catch");
    expect(md).toContain("Scope: local");
  });

  it("handles issues with missing optional fields gracefully", () => {
    const result = {
      passed: true,
      issues: [
        {
          severity: "minor",
          description: "Typo in documentation",
        },
      ],
    };

    const md = formatReviewReport(result);

    expect(md).toContain("[MINOR] Typo in documentation");
    // Should not throw, just omit missing fields
    expect(md).not.toContain("undefined");
  });

  it("handles empty reviewResult object", () => {
    const md = formatReviewReport({});

    expect(md).toContain("# Review Report");
    expect(md).toContain("Total issues: 0");
    expect(md).toContain("Blockers: 0");
    expect(md).toContain("Major: 0");
    expect(md).toContain("Minor: 0");
  });

  it("handles null reviewResult gracefully", () => {
    const md = formatReviewReport(null as unknown as Record<string, unknown>);

    expect(md).toContain("# Review Report");
    expect(md).toContain("Total issues: 0");
  });

  it("ignores issues with unknown severity", () => {
    const result = {
      passed: true,
      issues: [
        { severity: "unknown", description: "weird issue", suggestion: "" },
        { severity: "blocker", description: "real issue", suggestion: "" },
      ],
    };

    const md = formatReviewReport(result);

    expect(md).toContain("Total issues: 2");
    expect(md).toContain("Blockers: 1");
    // Unknown severity issues still appear in the issue list but not in summary counts
    expect(md).toContain("weird issue");
  });

  it("includes target info when present", () => {
    const result = {
      passed: false,
      issues: [
        {
          severity: "major",
          description: "Bad output",
          suggestion: "Fix it",
          target: "TASK-001",
          targetType: "task",
        },
      ],
    };

    const md = formatReviewReport(result);

    expect(md).toContain("[MAJOR] Bad output");
    expect(md).toContain("Target: TASK-001 (task)");
  });
});
