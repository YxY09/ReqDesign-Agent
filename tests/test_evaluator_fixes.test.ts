import { describe, it, expect, vi } from "vitest";
import { EvaluatorAgent } from "../src/agents/evaluator.js";
import { createIssue } from "../src/agents/types.js";
import type { Issue } from "../src/agents/types.js";

// ---------------------------------------------------------------------------
// Mock LLM stubs
// ---------------------------------------------------------------------------

/** Returns empty issues from LLM. */
function noopLlm() {
  return {
    generateJson: vi.fn().mockResolvedValue({ issues: [] }),
    _streamTag: "",
    get streamTag() { return this._streamTag; },
    set streamTag(v: string) { this._streamTag = v; },
  } as any;
}

/** Returns an issue targeting a sibling diagram field (should be filtered). */
function siblingLeakLlm() {
  return {
    generateJson: vi.fn().mockResolvedValue({
      issues: [
        {
          severity: "major",
          target_task_id: "direct_class_diagram",
          target_task_type: "diagrams",
          target_field: "activity_diagram",
          description: "should not inspect sibling diagram",
          suggestion: "do not report this",
        },
      ],
    }),
    _streamTag: "",
    get streamTag() { return this._streamTag; },
    set streamTag(v: string) { this._streamTag = v; },
  } as any;
}

/** Throws on generateJson. */
function failingLlm() {
  return {
    generateJson: vi.fn().mockRejectedValue(new Error("invalid review json")),
    _streamTag: "",
    get streamTag() { return this._streamTag; },
    set streamTag(v: string) { this._streamTag = v; },
  } as any;
}

// ---------------------------------------------------------------------------
// Tests: _buildFixes — fix-task mapping
// ---------------------------------------------------------------------------

describe("EvaluatorAgent._buildFixes", () => {
  it("prefers explicit targetTaskType", () => {
    const issues: Issue[] = [
      createIssue({
        severity: "major",
        targetTaskId: "analyze-1",
        targetTaskType: "diagrams",
        targetField: "diagrams.class_diagram",
        description: "missing class diagram",
        suggestion: "regenerate class diagram",
      }),
    ];

    const fixes = EvaluatorAgent._buildFixes(issues);

    expect(fixes).toHaveLength(1);
    expect(fixes[0].type).toBe("diagrams");
    expect(fixes[0].dependsOn).toEqual(["analyze-1"]);
    expect(fixes[0].id).toMatch(/^analyze-1-fix-/);
  });

  it("falls back to field inference when no explicit type", () => {
    const issues: Issue[] = [
      createIssue({
        severity: "major",
        targetTaskId: "design-1",
        targetTaskType: "",
        targetField: "design_text",
        description: "design is empty",
        suggestion: "regenerate design",
      }),
    ];

    const fixes = EvaluatorAgent._buildFixes(issues);

    expect(fixes).toHaveLength(1);
    expect(fixes[0].type).toBe("design");
    expect(fixes[0].dependsOn).toEqual(["design-1"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: scoped snapshots
// ---------------------------------------------------------------------------

describe("EvaluatorAgent evaluate — scoped snapshots", () => {
  it("keeps exact task_id in evaluated_revisions", async () => {
    const evaluator = new EvaluatorAgent(noopLlm());

    const verdict = await evaluator.evaluate(
      "simple requirement",
      {},
      "",
      {},
      "",
      {
        direct_class_diagram: {
          type: "diagrams",
          revision: 1,
          self_check_passed: true,
          self_correct_rounds: 0,
          size: 12,
        },
      },
      {
        direct_class_diagram: {
          task_id: "direct_class_diagram",
          type: "diagrams",
          revision: 1,
          content: { class_diagram: "INVALID\nA-->B" },
        },
      },
      "design",
      true,
      ["direct_class_diagram"],
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.evaluatedRevisions).toEqual({ direct_class_diagram: 1 });
    expect(
      verdict.issues.some((i) => i.targetTaskId === "direct_class_diagram"),
    ).toBe(true);
  });

  it("filters sibling diagram fields not present in snapshot", async () => {
    const evaluator = new EvaluatorAgent(siblingLeakLlm());

    const verdict = await evaluator.evaluate(
      "simple requirement",
      {},
      "",
      {},
      "",
      { direct_class_diagram: { type: "diagrams", revision: 1 } },
      {
        direct_class_diagram: {
          task_id: "direct_class_diagram",
          type: "diagrams",
          revision: 1,
          content: { class_diagram: "classDiagram\nclass A" },
        },
      },
      "design",
      true,
      ["direct_class_diagram"],
    );

    expect(verdict.passed).toBe(true);
    expect(verdict.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: direct mode detection
// ---------------------------------------------------------------------------

describe("EvaluatorAgent evaluate — direct mode detection", () => {
  it("analyze snapshot is not auto-detected as direct mode", async () => {
    const evaluator = new EvaluatorAgent(noopLlm());
    const seen: Record<string, unknown> = {};

    // Override private _llmReviewSnapshots to capture isDirectMode argument
    (evaluator as any)._llmReviewSnapshots = vi.fn(
      async (
        _req: string,
        _snapshots: Record<string, unknown>,
        isDirectMode: boolean,
      ) => {
        seen.isDirectMode = isDirectMode;
        return [[], null];
      },
    );

    const verdict = await evaluator.evaluate(
      "complex requirement",
      {},
      "",
      {},
      "",
      { "analyze-1": { type: "analyze", revision: 1 } },
      {
        "analyze-1": {
          task_id: "analyze-1",
          type: "analyze",
          revision: 1,
          content: { actors: ["A"], functions: ["F"], entities: ["E"] },
        },
      },
      "design",
      false,
      ["analyze-1"],
    );

    expect(verdict.passed).toBe(true);
    expect(seen.isDirectMode).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: LLM failure handling
// ---------------------------------------------------------------------------

describe("EvaluatorAgent evaluate — LLM failure", () => {
  it("propagates LLM error instead of silently passing", async () => {
    const evaluator = new EvaluatorAgent(failingLlm());

    await expect(
      evaluator.evaluate(
        "simple requirement",
        {},
        "",
        {},
        "",
        { "design-1": { type: "design", revision: 1 } },
        {
          "design-1": {
            task_id: "design-1",
            type: "design",
            revision: 1,
            content: "design text",
          },
        },
        "design",
        false,
        ["design-1"],
      ),
    ).rejects.toThrow("invalid review json");
  });
});
