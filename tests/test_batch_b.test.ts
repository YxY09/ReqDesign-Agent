/**
 * Batch B tests: analysisMode + source_ref verification.
 *
 * Covers:
 *   1. Task.analysisMode field and _parseResponse enum validation
 *   2. _verifySourceRefs in AnalyzeMerger
 *   3. Prompt updates (analysisMode and source_text)
 */

import { describe, it, expect } from "vitest";
import {
  type Task,
  createTask,
  createExecutionPlan,
} from "../src/shared/types.js";
import { PlanningTool } from "../src/tools/planning.js";
import { AnalyzeMerger } from "../src/generators/merge.js";
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
      analysisMode: "domain",
    });
    expect(task.analysisMode).toBe("domain");
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

  it("sets analysisMode to undefined for unknown values", () => {
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
    expect(plan.tasks[0].analysisMode).toBeUndefined();
  });

  it("parses analysisMode (camelCase) from LLM response", () => {
    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-d",
          type: "analyze",
          description: "domain analysis via camelCase",
          depends_on: [],
          context_hints: {},
          analysisMode: "domain",
        },
      ],
    };
    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks[0].analysisMode).toBe("domain");
  });

  it("prefers snake_case analysis_mode when both present", () => {
    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-1",
          type: "analyze",
          description: "both modes - snake_case wins",
          depends_on: [],
          context_hints: {},
          analysis_mode: "domain",
          analysisMode: "unknown",
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

  // context_hints fallback for analysisMode
  it("reads analysisMode from context_hints when top-level missing", () => {
    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-d",
          type: "analyze",
          description: "domain analysis",
          depends_on: [],
          context_hints: { analysisMode: "domain" },
        },
      ],
    };
    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks[0].analysisMode).toBe("domain");
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
          description: "both - top-level wins",
          depends_on: [],
          context_hints: { analysisMode: "unknown" },
          analysis_mode: "domain",
        },
      ],
    };
    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks[0].analysisMode).toBe("domain");
  });

  it("treats analysisMode case-insensitively — 'DOMAIN' is parsed", () => {
    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-d",
          type: "analyze",
          description: "uppercase domain",
          depends_on: [],
          context_hints: {},
          analysis_mode: "DOMAIN",
        },
      ],
    };
    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks[0].analysisMode).toBe("domain");
  });

  it("sets non-domain analysisMode to undefined", () => {
    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-x",
          type: "analyze",
          description: "constrained analysis",
          depends_on: [],
          context_hints: {},
          analysis_mode: "constraints",
        },
      ],
    };
    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks[0].analysisMode).toBeUndefined();
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
          description: "domain analysis",
          depends_on: [],
          context_hints: {},
          analysis_mode: "domain",
        },
      ],
      drop_task_ids: [],
    };
    const mutation = planner._parseReplanResponse(response);
    expect(mutation.updateTasks).toHaveLength(1);
    expect(mutation.updateTasks[0].analysisMode).toBe("domain");
  });

  it("sets analysisMode to undefined for unknown values in replan", () => {
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
    expect(mutation.addTasks[0].analysisMode).toBeUndefined();
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
          id: "analyze-d",
          type: "analyze",
          description: "domain analysis",
          depends_on: [],
          context_hints: { analysisMode: "domain" },
        },
      ],
      update_tasks: [],
      drop_task_ids: [],
    };
    const mutation = planner._parseReplanResponse(response);
    expect(mutation.addTasks).toHaveLength(1);
    expect(mutation.addTasks[0].analysisMode).toBe("domain");
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

  it("requirement_analysis.md includes source_text in constraint format", () => {
    const content = readPrompt("requirement_analysis.md");
    expect(content).toContain("source_text");
  });

  it("test_case.md requires test case per exception (BUG-12)", () => {
    const content = readPrompt("test_case.md");
    // Must explicitly require each exception gets its own test case
    expect(content).toContain("每个异常");
    // Must prioritize security and performance exceptions
    expect(content).toContain("优先覆盖安全相关和性能相关的异常");
  });
});
