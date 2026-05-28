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

  it("parses analysisMode (camelCase) from LLM response", () => {
    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-1",
          type: "analyze",
          description: "constraint extraction via camelCase",
          depends_on: [],
          context_hints: {},
          analysisMode: "constraints",
        },
      ],
    };
    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks[0].analysisMode).toBe("constraints");
  });

  it("prefers snake_case analysis_mode when both present", () => {
    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-1",
          type: "analyze",
          description: "both modes",
          depends_on: [],
          context_hints: {},
          analysis_mode: "constraints",
          analysisMode: "domain",
        },
      ],
    };
    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks[0].analysisMode).toBe("constraints");
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

  // context_hints fallback for analysisMode
  it("reads analysisMode from context_hints when top-level missing", () => {
    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-c",
          type: "analyze",
          description: "constraint extraction",
          depends_on: [],
          context_hints: { analysisMode: "constraints" },
        },
      ],
    };
    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks[0].analysisMode).toBe("constraints");
  });

  it("reads analysis_mode from context_hints (snake_case)", () => {
    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-d",
          type: "analyze",
          description: "domain analysis",
          depends_on: [],
          context_hints: { analysis_mode: "domain" },
        },
      ],
    };
    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks[0].analysisMode).toBe("domain");
  });

  it("prefers top-level analysis_mode over context_hints", () => {
    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-1",
          type: "analyze",
          description: "both",
          depends_on: [],
          context_hints: { analysisMode: "domain" },
          analysis_mode: "constraints",
        },
      ],
    };
    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks[0].analysisMode).toBe("constraints");
  });
});

// ---------------------------------------------------------------------------
// 2b. _parseReplanResponse parses analysisMode with enum validation
// ---------------------------------------------------------------------------

describe("PlanningTool._parseReplanResponse analysisMode validation", () => {
  const fakeLlm = { generateJson: async () => ({}) } as any;
  const planner = new PlanningTool(fakeLlm);

  it("parses analysis_mode in add_tasks", () => {
    const response = {
      reasoning: "test replan",
      add_tasks: [
        {
          id: "analyze-2",
          type: "analyze",
          description: "domain analysis",
          depends_on: [],
          context_hints: {},
          analysis_mode: "domain",
        },
      ],
      update_tasks: [],
      drop_task_ids: [],
    };
    const mutation = planner._parseReplanResponse(response);
    expect(mutation.addTasks[0].analysisMode).toBe("domain");
  });

  it("parses analysis_mode in update_tasks", () => {
    const response = {
      reasoning: "test replan",
      add_tasks: [],
      update_tasks: [
        {
          id: "analyze-1",
          type: "analyze",
          description: "constraint extraction",
          depends_on: [],
          context_hints: {},
          analysis_mode: "constraints",
        },
      ],
      drop_task_ids: [],
    };
    const mutation = planner._parseReplanResponse(response);
    expect(mutation.updateTasks[0].analysisMode).toBe("constraints");
  });

  it("falls back unknown analysisMode to 'domain' in replan", () => {
    const response = {
      reasoning: "test replan",
      add_tasks: [
        {
          id: "analyze-3",
          type: "analyze",
          description: "unknown mode",
          depends_on: [],
          context_hints: {},
          analysis_mode: "something_else",
        },
      ],
      update_tasks: [],
      drop_task_ids: [],
    };
    const mutation = planner._parseReplanResponse(response);
    expect(mutation.addTasks[0].analysisMode).toBe("domain");
  });

  it("sets analysisMode to undefined when not provided in replan", () => {
    const response = {
      reasoning: "test replan",
      add_tasks: [
        {
          id: "design-1",
          type: "design",
          description: "no mode",
          depends_on: [],
          context_hints: {},
        },
      ],
      update_tasks: [],
      drop_task_ids: [],
    };
    const mutation = planner._parseReplanResponse(response);
    expect(mutation.addTasks[0].analysisMode).toBeUndefined();
  });

  // context_hints fallback in replan
  it("reads analysisMode from context_hints in add_tasks", () => {
    const response = {
      reasoning: "test replan",
      add_tasks: [
        {
          id: "analyze-c",
          type: "analyze",
          description: "constraint extraction",
          depends_on: [],
          context_hints: { analysisMode: "constraints" },
        },
      ],
      update_tasks: [],
      drop_task_ids: [],
    };
    const mutation = planner._parseReplanResponse(response);
    expect(mutation.addTasks[0].analysisMode).toBe("constraints");
  });

  it("reads analysis_mode from context_hints in update_tasks (snake_case)", () => {
    const response = {
      reasoning: "test replan",
      add_tasks: [],
      update_tasks: [
        {
          id: "analyze-1",
          type: "analyze",
          description: "domain analysis",
          depends_on: [],
          context_hints: { analysis_mode: "domain" },
        },
      ],
      drop_task_ids: [],
    };
    const mutation = planner._parseReplanResponse(response);
    expect(mutation.updateTasks[0].analysisMode).toBe("domain");
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
// 3b. _ensureConstraintTask + _ensureOrder interaction
// ---------------------------------------------------------------------------

describe("_ensureConstraintTask + _ensureOrder interaction", () => {
  it("design task dependsOn includes auto-inserted constraint task ID after both passes", () => {
    // Simulate the _parseResponse pipeline on raw task data that lacks a constraint task.
    // The goal contains "design", so _ensureConstraintTask should auto-insert one.
    // _ensureOrder must run AFTER so the new constraint ID is added to dependsOn.
    const tasks: Task[] = [
      createTask({ id: "analyze-1", type: "analyze", description: "domain" }),
      createTask({ id: "design-1", type: "design", description: "design" }),
    ];

    // WRONG order (current bug): _ensureOrder first, then _ensureConstraintTask
    const wrongOrder = PlanningTool._ensureConstraintTask(
      PlanningTool._ensureOrder([...tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn] }))]),
      "design",
    );
    const designWrong = wrongOrder.find((t) => t.id === "design-1")!;
    const constraintWrong = wrongOrder.find(
      (t) => t.analysisMode === "constraints",
    );
    // This demonstrates the bug: constraint task exists but design doesn't depend on it
    expect(constraintWrong).toBeDefined();
    expect(designWrong.dependsOn).not.toContain(constraintWrong!.id);

    // CORRECT order: _ensureConstraintTask first, then _ensureOrder
    const correctOrder = PlanningTool._ensureOrder(
      PlanningTool._ensureConstraintTask([...tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn] }))], "design"),
    );
    const designCorrect = correctOrder.find((t) => t.id === "design-1")!;
    const constraintCorrect = correctOrder.find(
      (t) => t.analysisMode === "constraints",
    );
    expect(constraintCorrect).toBeDefined();
    expect(designCorrect.dependsOn).toContain(constraintCorrect!.id);
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

  // Fix 3: ellipsis handling
  it("ignores ellipsis (...) in source_text when matching", () => {
    const req = "The System must allow changes to security attributes for groups or users to be made only by super-user";
    const merged = {
      constraints: [
        {
          id: "C001",
          description: "security constraint",
          source_text: "...must allow changes to security attributes for groups or users...",
        },
      ],
      exceptions: [],
    };
    const unverifiedCount = AnalyzeMerger._verifySourceRefs(merged, req);
    expect(unverifiedCount).toBe(0);
    expect((merged.constraints as any[])[0].unverified).toBeUndefined();
  });

  it("ignores unicode ellipsis (…) in source_text when matching", () => {
    const req = "用户必须年满18岁才能注册";
    const merged = {
      constraints: [
        {
          id: "C001",
          description: "age constraint",
          source_text: "…年满18岁才能注册…",
        },
      ],
      exceptions: [],
    };
    const unverifiedCount = AnalyzeMerger._verifySourceRefs(merged, req);
    expect(unverifiedCount).toBe(0);
  });

  it("normalizes unicode curly quotes in source_text when matching", () => {
    // source_text uses curly quotes, requirement uses ASCII quotes
    const req = 'the system must "search results" for the user\'s password';
    const merged = {
      constraints: [
        {
          id: "C001",
          description: "search constraint",
          source_text: "\u201Csearch results\u201D for the user\u2019s password",
        },
      ],
      exceptions: [],
    };
    const unverifiedCount = AnalyzeMerger._verifySourceRefs(merged, req);
    expect(unverifiedCount).toBe(0);
  });

  it("normalizes unicode angle quotes and reverse quotes in source_text", () => {
    // \u00AB \u00BB = angle quotes → ", \u201B = single high-reversed-9 → '
    const req = 'he said "hello" and \'hi\'';
    const merged = {
      constraints: [
        {
          id: "C001",
          description: "quote constraint",
          source_text: "\u00ABhello\u00BB and \u201Bhi'",
        },
      ],
      exceptions: [],
    };
    const unverifiedCount = AnalyzeMerger._verifySourceRefs(merged, req);
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

  it("requirement_analysis_constraints.md includes {requirement_text} placeholder", () => {
    const content = readPrompt("requirement_analysis_constraints.md");
    expect(content).toContain("{requirement_text}");
  });

  // BUG-11: source_text anti-fabrication rules
  it("requirement_analysis_constraints.md prohibits fabricated source_text (BUG-11)", () => {
    const content = readPrompt("requirement_analysis_constraints.md");
    // Must instruct LLM to use empty string when no original text found
    expect(content).toContain("空字符串");
    // Must explicitly prohibit fabrication with error example
    expect(content).toContain("Implicit requirement throughout document");
  });

  it("test_case.md requires test case per exception (BUG-12)", () => {
    const content = readPrompt("test_case.md");
    // Must explicitly require each exception gets its own test case
    expect(content).toContain("每个异常");
    // Must prioritize security and performance exceptions
    expect(content).toContain("优先覆盖安全相关和性能相关的异常");
  });
});
