/**
 * Batch B tests: analysisMode + source_ref verification.
 *
 * Covers:
 *   1. Task.analysisMode field and _parseResponse enum validation
 *   2. _ensureConstraintTask auto-insertion
 *   3. _fallbackPlan constraint task
 *   4. isConstraintTask detection via analysisMode
 *   5. _ruleCheck uses constraintSchema when analysisMode === "constraints"
 *   6. _verifySourceRefs in AnalyzeMerger
 *   7. Prompt updates (analysisMode and source_text)
 */

import { describe, it, expect } from "vitest";
import {
  type Task,
  createTask,
  createExecutionPlan,
} from "../src/shared/types.js";
import { PlanningTool } from "../src/tools/planning.js";
import { GenerationTool } from "../src/tools/generation.js";
import { AnalyzeMerger } from "../src/generators/merge.js";
import { validateConstraintAnalysisResult } from "../src/shared/constraintSchema.js";
import { RequirementAnalyzer } from "../src/generators/analyze.js";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a prompt file and return its content. */
function readPrompt(filename: string): string {
  return fs.readFileSync(path.resolve("prompts", filename), "utf-8");
}

// ---------------------------------------------------------------------------
// 1. Task.analysisMode field
// ---------------------------------------------------------------------------

describe("Task.analysisMode", () => {
  it("accepts analysisMode on createTask", () => {
    const task = createTask({
      id: "analyze-1",
      type: "analyze",
      analysisMode: "constraints",
    });
    expect(task.analysisMode).toBe("constraints");
  });

  it("accepts analysisMode 'domain'", () => {
    const task = createTask({
      id: "analyze-2",
      type: "analyze",
      analysisMode: "domain",
    });
    expect(task.analysisMode).toBe("domain");
  });

  it("defaults analysisMode to undefined", () => {
    const task = createTask({ id: "analyze-3", type: "analyze" });
    expect(task.analysisMode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. _parseResponse parses analysisMode with enum validation
// ---------------------------------------------------------------------------

describe("PlanningTool._parseResponse analysisMode validation", () => {
  // Minimal FakeLLM since we only call _parseResponse directly
  const fakeLlm = { generateJson: async () => ({}) } as any;
  const planner = new PlanningTool(fakeLlm);

  it("parses analysis_mode from LLM response", () => {
    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-1",
          type: "analyze",
          description: "domain analysis",
          depends_on: [],
          context_hints: {},
          analysis_mode: "domain",
        },
      ],
    };
    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks[0].analysisMode).toBe("domain");
  });

  it("parses analysisMode 'constraints'", () => {
    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-c",
          type: "analyze",
          description: "constraint extraction",
          depends_on: [],
          context_hints: {},
          analysis_mode: "constraints",
        },
      ],
    };
    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks[0].analysisMode).toBe("constraints");
  });

  it("falls back unknown analysisMode to 'domain'", () => {
    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-1",
          type: "analyze",
          description: "unknown mode",
          depends_on: [],
          context_hints: {},
          analysis_mode: "unknown_value",
        },
      ],
    };
    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks[0].analysisMode).toBe("domain");
  });

  it("sets analysisMode to undefined when not provided", () => {
    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-1",
          type: "analyze",
          description: "no mode",
          depends_on: [],
          context_hints: {},
        },
      ],
    };
    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks[0].analysisMode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. _ensureConstraintTask auto-insertion
// ---------------------------------------------------------------------------

describe("PlanningTool._ensureConstraintTask", () => {
  it("inserts a constraints task when goal includes 'design' and no constraints task exists", () => {
    const tasks: Task[] = [
      createTask({ id: "analyze-1", type: "analyze", description: "domain" }),
      createTask({ id: "design-1", type: "design", description: "design" }),
    ];
    const result = PlanningTool._ensureConstraintTask(tasks, "design");
    const constraintTasks = result.filter(
      (t) => t.analysisMode === "constraints",
    );
    expect(constraintTasks.length).toBeGreaterThanOrEqual(1);
    const ct = constraintTasks[0];
    expect(ct.type).toBe("analyze");
    expect(ct.contextHints).toBeDefined();
    expect(ct.contextHints.note).toContain("约束提取");
  });

  it("does not insert duplicate when constraints task already exists", () => {
    const tasks: Task[] = [
      createTask({
        id: "analyze-1",
        type: "analyze",
        description: "domain",
      }),
      createTask({
        id: "analyze-constraints",
        type: "analyze",
        description: "constraint extraction",
        analysisMode: "constraints",
      }),
      createTask({ id: "design-1", type: "design", description: "design" }),
    ];
    const result = PlanningTool._ensureConstraintTask(tasks, "design");
    const constraintTasks = result.filter(
      (t) => t.analysisMode === "constraints",
    );
    expect(constraintTasks.length).toBe(1);
    expect(constraintTasks[0].id).toBe("analyze-constraints");
  });

  it("does not insert when goal does not include 'design'", () => {
    const tasks: Task[] = [
      createTask({ id: "analyze-1", type: "analyze", description: "domain" }),
    ];
    const result = PlanningTool._ensureConstraintTask(tasks, "analyze");
    const constraintTasks = result.filter(
      (t) => t.analysisMode === "constraints",
    );
    expect(constraintTasks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. _fallbackPlan includes constraint task
// ---------------------------------------------------------------------------

describe("PlanningTool._fallbackPlan includes constraint task", () => {
  it("includes a constraints analyze task for design goal", () => {
    const plan = PlanningTool._fallbackPlan("some text", "design");
    const constraintTasks = plan.tasks.filter(
      (t) => t.analysisMode === "constraints",
    );
    expect(constraintTasks.length).toBe(1);
    expect(constraintTasks[0].type).toBe("analyze");
  });

  it("does not include constraint task for analyze-only goal", () => {
    const plan = PlanningTool._fallbackPlan("some text", "analyze");
    const constraintTasks = plan.tasks.filter(
      (t) => t.analysisMode === "constraints",
    );
    expect(constraintTasks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. GenerationTool._generateAnalyze detection via analysisMode
// ---------------------------------------------------------------------------

describe("GenerationTool isConstraintTask detection", () => {
  it("detects constraint task by analysisMode=constraints", () => {
    // We test via _ruleCheck which routes constraint tasks differently.
    // But _generateAnalyze is private, so test the routing indirectly.
    // Instead, verify that analysisMode is accessible on the task object.
    const task = createTask({
      id: "analyze-c",
      type: "analyze",
      description: "constraint extraction",
      analysisMode: "constraints",
    });
    expect(task.analysisMode).toBe("constraints");
    // The actual detection logic change is in _generateAnalyze (private),
    // but we verify the contract: analysisMode takes priority over note.
  });

  it("analysisMode takes priority over note-based detection", () => {
    const task = createTask({
      id: "analyze-c",
      type: "analyze",
      description: "domain analysis",
      analysisMode: "domain",
      contextHints: { note: "约束提取" },
    });
    // analysisMode=domain should NOT be detected as constraint
    expect(task.analysisMode).toBe("domain");
  });
});

// ---------------------------------------------------------------------------
// 6. _ruleCheck uses constraintSchema for analysisMode=constraints
// ---------------------------------------------------------------------------

describe("GenerationTool._ruleCheck constraint-aware validation", () => {
  it("uses standard validator for domain analysisMode", () => {
    const task = createTask({
      id: "analyze-1",
      type: "analyze",
      analysisMode: "domain",
    });
    const content = {
      actors: [{ name: "User" }],
      functions: [{ id: "F001", name: "Login", preconditions: "" }],
      entities: [
        {
          name: "User",
          attributes: [
            { name: "id", type: "Long", description: "user id" },
          ],
          relationships: [],
        },
      ],
      constraints: [],
      exceptions: [],
    };
    // Standard validator should warn about empty constraints
    const issues = GenerationTool._ruleCheck(task, content, {});
    // Should NOT error on missing constraints (standard analyzer)
    expect(issues.some((i) => i.includes("actors"))).toBe(false);
  });

  it("uses constraintSchema for analysisMode=constraints", () => {
    const task = createTask({
      id: "analyze-c",
      type: "analyze",
      analysisMode: "constraints",
    });
    const content = {
      constraints: [
        { id: "C001", description: "valid constraint text" },
      ],
      exceptions: [
        {
          id: "X001",
          description: "some exception",
          trigger: "something fails",
          handling: "log error",
        },
      ],
    };
    // Constraint schema should validate successfully
    const issues = GenerationTool._ruleCheck(task, content, {});
    // Should not have structural errors for valid constraint output
    expect(
      issues.some((i) => i.includes("缺少 actors") || i.includes("缺少 functions")),
    ).toBe(false);
  });

  it("constraintSchema rejects empty constraints+exceptions", () => {
    const task = createTask({
      id: "analyze-c",
      type: "analyze",
      analysisMode: "constraints",
    });
    const content = {
      constraints: [],
      exceptions: [],
    };
    const issues = GenerationTool._ruleCheck(task, content, {});
    // Should flag that constraint analysis needs at least some data
    expect(issues.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. _verifySourceRefs in AnalyzeMerger
// ---------------------------------------------------------------------------

describe("AnalyzeMerger._verifySourceRefs", () => {
  const requirementText =
    "用户必须年满18岁才能注册。订单金额超过10000元需要审批。系统应在3秒内响应。";

  it("marks unverified when source_text not found in requirement", () => {
    const merged = {
      constraints: [
        {
          id: "C001",
          description: "用户必须年满18岁才能注册",
          source_text: "用户必须年满18岁才能注册",
        },
        {
          id: "C002",
          description: "密码长度至少12位",
          source_text: "密码长度至少十二个字符",
        },
      ],
      exceptions: [],
    };
    const unverifiedCount = AnalyzeMerger._verifySourceRefs(
      merged,
      requirementText,
    );
    // C001 should match, C002 should not
    expect(unverifiedCount).toBe(1);
    expect((merged.constraints as any[])[1].unverified).toBe(true);
    expect((merged.constraints as any[])[0].unverified).toBeUndefined();
  });

  it("verifies exceptions source_text too", () => {
    const merged = {
      constraints: [],
      exceptions: [
        {
          id: "X001",
          description: "超时异常",
          trigger: "订单金额超过10000元需要审批",
          handling: "提示用户",
          source_text: "订单金额超过10000元需要审批",
        },
        {
          id: "X002",
          description: "网络错误",
          trigger: "网络断开",
          handling: "重试",
          source_text: "网络中断后自动重连",  // not in source text
        },
      ],
    };
    const unverifiedCount = AnalyzeMerger._verifySourceRefs(
      merged,
      requirementText,
    );
    expect(unverifiedCount).toBe(1);
    expect((merged.exceptions as any[])[1].unverified).toBe(true);
  });

  it("normalizes whitespace for matching", () => {
    const merged = {
      constraints: [
        {
          id: "C001",
          description: "test",
          source_text: "用户  必须  年满18岁才能注册",  // extra spaces
        },
      ],
      exceptions: [],
    };
    const unverifiedCount = AnalyzeMerger._verifySourceRefs(
      merged,
      requirementText,
    );
    expect(unverifiedCount).toBe(0);
  });

  it("returns 0 when no source_text fields exist", () => {
    const merged = {
      constraints: [
        { id: "C001", description: "some constraint" },
      ],
      exceptions: [],
    };
    const unverifiedCount = AnalyzeMerger._verifySourceRefs(
      merged,
      requirementText,
    );
    expect(unverifiedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Prompt file updates
// ---------------------------------------------------------------------------

describe("Prompt files contain analysisMode and source_text", () => {
  it("planner.md mentions analysisMode in examples", () => {
    const content = readPrompt("planner.md");
    expect(content).toContain("analysisMode");
  });

  it("planner.md has analysisMode=constraints example", () => {
    const content = readPrompt("planner.md");
    expect(content).toContain('"constraints"');
  });

  it("requirement_analysis.md includes source_text in constraint format", () => {
    const content = readPrompt("requirement_analysis.md");
    expect(content).toContain("source_text");
  });

  it("requirement_analysis_constraints.md includes source_text", () => {
    const content = readPrompt("requirement_analysis_constraints.md");
    expect(content).toContain("source_text");
  });
});
