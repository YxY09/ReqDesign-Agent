/**
 * Phase 2.5 tests: Constraint reference-only mode.
 *
 * Tests that:
 * 1. Prompts instruct the LLM to use constraintRef from available_constraints
 *    and put new constraints into missingConstraintCandidates.
 * 2. PlanningTool injects availableConstraints into analyze task contextHints.
 * 3. preMerge collects missingConstraintCandidates from artifacts.
 */

import { describe, it, expect, vi } from "vitest";
import { PlanningTool } from "../src/tools/planning.js";
import { AnalyzeMerger, canonicalizeConstraintsPipeline } from "../src/generators/merge.js";
import { RequirementAnalyzer } from "../src/generators/analyze.js";
import { createTask } from "../src/shared/types.js";
import type { Task } from "../src/shared/types.js";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake LLM that throws if called (we only test static/unit methods). */
const fakeLlm = {
  generateJson: async () => { throw new Error("LLM should not be called"); },
  generate: async () => { throw new Error("LLM should not be called"); },
  streamTag: "",
} as any;

function makeMerger(): AnalyzeMerger {
  return new AnalyzeMerger(fakeLlm);
}

// ---------------------------------------------------------------------------
// 1. Prompt content checks
// ---------------------------------------------------------------------------

describe("Phase 2.5: prompt constraint-ref instructions", () => {
  const promptsDir = path.resolve("prompts");

  it("requirement_analysis.md mentions constraintRef and missingConstraintCandidates", () => {
    const content = fs.readFileSync(path.join(promptsDir, "requirement_analysis.md"), "utf-8");
    expect(content).toContain("constraintRef");
    expect(content).toContain("missingConstraintCandidates");
    expect(content).toContain("available_constraints");
  });

});

// ---------------------------------------------------------------------------
// 2. PlanningTool: availableConstraints injection into contextHints
// ---------------------------------------------------------------------------

describe("Phase 2.5: PlanningTool availableConstraints injection", () => {
  it("_buildUserPrompt includes extracted constraint candidates for planning", () => {
    const prompt = PlanningTool._buildUserPrompt(
      "some requirement",
      "design",
      undefined,
      undefined,
      [
        {
          description: "Users must be authenticated",
          sourceText: "用户必须登录后操作",
          sectionId: "SEC_AUTH",
          relatedFunctionCandidates: ["FUN_LOGIN"],
        },
      ],
    );

    expect(prompt).toContain("约束候选注册表");
    expect(prompt).toContain("C_RULE_001");
    expect(prompt).toContain("Users must be authenticated");
    expect(prompt).toContain("SEC_AUTH");
    expect(prompt).toContain("missingConstraintCandidates");
  });

  it("_parseResponse propagates availableConstraints from contextHints", () => {
    const planner = new PlanningTool(fakeLlm);

    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-1",
          type: "analyze",
          description: "extract requirements",
          depends_on: [],
          context_hints: {
            assignedSections: ["s1"],
            availableConstraints: [
              { constraintRef: "C_RULE_001", description: "Users must be authenticated", sourceText: "原文" },
            ],
          },
        },
      ],
    };

    const plan = planner._parseResponse(response, "design");
    const task = plan.tasks.find((t) => t.id === "analyze-1");
    expect(task).toBeDefined();
    expect(task!.contextHints.availableConstraints).toBeDefined();
    const constraints = task!.contextHints.availableConstraints as Array<Record<string, unknown>>;
    expect(constraints).toHaveLength(1);
    expect(constraints[0].constraintRef).toBe("C_RULE_001");
  });
});

// ---------------------------------------------------------------------------
// 3. preMerge collects missingConstraintCandidates
// ---------------------------------------------------------------------------

describe("Phase 2.5: preMerge collects missingConstraintCandidates", () => {
  it("collects missingConstraintCandidates from all artifacts into the merged result", () => {
    const merger = makeMerger();

    const a1 = {
      taskId: "analyze-1",
      content: {
        project_name: "Test",
        project_overview: "Test project",
        actors: [],
        functions: [],
        entities: [],
        constraints: [],
        exceptions: [],
        non_functional_requirements: [],
        business_processes: [],
        proposeNewEntities: [],
        proposeNewFunctions: [],
        missingConstraintCandidates: [
          { description: "New constraint from artifact 1", sourceText: "some text" },
        ],
      },
    };

    const a2 = {
      taskId: "analyze-2",
      content: {
        project_name: "Test",
        project_overview: "Test project",
        actors: [],
        functions: [],
        entities: [],
        constraints: [],
        exceptions: [],
        non_functional_requirements: [],
        business_processes: [],
        proposeNewEntities: [],
        proposeNewFunctions: [],
        missingConstraintCandidates: [
          { description: "New constraint from artifact 2", sourceText: "other text" },
        ],
      },
    };

    const merged = merger.preMerge([a1, a2]);
    const candidates = merged.missingConstraintCandidates as Array<Record<string, unknown>>;
    expect(candidates).toBeDefined();
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.description)).toContain("New constraint from artifact 1");
    expect(candidates.map((c) => c.description)).toContain("New constraint from artifact 2");
  });

  it("deduplicates missingConstraintCandidates by description", () => {
    const merger = makeMerger();

    const a1 = {
      taskId: "analyze-1",
      content: {
        project_name: "Test",
        project_overview: "Test",
        actors: [],
        functions: [],
        entities: [],
        constraints: [],
        exceptions: [],
        non_functional_requirements: [],
        business_processes: [],
        proposeNewEntities: [],
        proposeNewFunctions: [],
        missingConstraintCandidates: [
          { description: "Duplicate constraint", sourceText: "text1" },
        ],
      },
    };

    const a2 = {
      taskId: "analyze-2",
      content: {
        project_name: "Test",
        project_overview: "Test",
        actors: [],
        functions: [],
        entities: [],
        constraints: [],
        exceptions: [],
        non_functional_requirements: [],
        business_processes: [],
        proposeNewEntities: [],
        proposeNewFunctions: [],
        missingConstraintCandidates: [
          { description: "Duplicate constraint", sourceText: "text2" },
        ],
      },
    };

    const merged = merger.preMerge([a1, a2]);
    const candidates = merged.missingConstraintCandidates as Array<Record<string, unknown>>;
    expect(candidates).toHaveLength(1);
  });

  it("returns empty array for missingConstraintCandidates when no artifacts provide them", () => {
    const merger = makeMerger();

    const a1 = {
      taskId: "analyze-1",
      content: {
        project_name: "Test",
        project_overview: "Test",
        actors: [],
        functions: [],
        entities: [],
        constraints: [],
        exceptions: [],
        non_functional_requirements: [],
        business_processes: [],
        proposeNewEntities: [],
        proposeNewFunctions: [],
      },
    };

    const merged = merger.preMerge([a1]);
    expect(merged.missingConstraintCandidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. RequirementAnalyzer substitutes {available_constraints} in template
// ---------------------------------------------------------------------------

describe("Phase 2.5: RequirementAnalyzer {available_constraints} substitution", () => {
  it("replaces {available_constraints} with formatted constraint list", async () => {
    let capturedPrompt = "";
    const spyLlm = {
      generateJson: vi.fn(async (prompt: string, _sys: string) => {
        capturedPrompt = prompt;
        return {
          actors: [{ name: "User" }],
          functions: [{ id: "F001", name: "Test" }],
          entities: [],
          constraints: [],
          exceptions: [],
          non_functional_requirements: [],
          business_processes: [],
        };
      }),
      generate: async () => { throw new Error("not used"); },
      streamTag: "",
    } as any;

    const analyzer = new RequirementAnalyzer(spyLlm, "requirement_analysis.md");
    const constraintsText = [
      "- C_RULE_001: Users must be authenticated (source text 1)",
      "- C_RULE_002: Password min 8 chars (source text 2)",
    ].join("\n");

    await analyzer.analyze("test requirement", 1, undefined, undefined, constraintsText);

    expect(capturedPrompt).not.toContain("{available_constraints}");
    expect(capturedPrompt).toContain("- C_RULE_001: Users must be authenticated (source text 1)");
    expect(capturedPrompt).toContain("- C_RULE_002: Password min 8 chars (source text 2)");
  });

  it("replaces {available_constraints} with fallback text when no constraints provided", async () => {
    let capturedPrompt2 = "";
    const spyLlm2 = {
      generateJson: vi.fn(async (prompt: string, _sys: string) => {
        capturedPrompt2 = prompt;
        return {
          actors: [{ name: "User" }],
          functions: [{ id: "F001", name: "Test" }],
          entities: [],
          constraints: [],
          exceptions: [],
          non_functional_requirements: [],
          business_processes: [],
        };
      }),
      generate: async () => { throw new Error("not used"); },
      streamTag: "",
    } as any;

    const analyzer2 = new RequirementAnalyzer(spyLlm2, "requirement_analysis.md");
    const fallbackText = "（系统尚未预提取约束，请自行提取并编号）";

    await analyzer2.analyze("test requirement", 1, undefined, undefined, fallbackText);

    expect(capturedPrompt2).not.toContain("{available_constraints}");
    expect(capturedPrompt2).toContain("（系统尚未预提取约束，请自行提取并编号）");
  });

  it("leaves {available_constraints} unreplaced when no text is passed", async () => {
    let capturedPrompt3 = "";
    const spyLlm3 = {
      generateJson: vi.fn(async (prompt: string, _sys: string) => {
        capturedPrompt3 = prompt;
        return {
          actors: [{ name: "User" }],
          functions: [{ id: "F001", name: "Test" }],
          entities: [],
          constraints: [],
          exceptions: [],
          non_functional_requirements: [],
          business_processes: [],
        };
      }),
      generate: async () => { throw new Error("not used"); },
      streamTag: "",
    } as any;

    const analyzer3 = new RequirementAnalyzer(spyLlm3, "requirement_analysis.md");

    // No availableConstraintsText passed (undefined)
    await analyzer3.analyze("test requirement", 1);

    // {available_constraints} should remain as literal in template
    expect(capturedPrompt3).toContain("{available_constraints}");
  });
});

// ---------------------------------------------------------------------------
// 5. canonicalizeConstraintsPipeline writes related_functions (snake_case)
//    so downstream consumers (testPlanBuilder.findConstraintsForFunction,
//    deriveModuleFromConstraint) reading con["related_functions"] can resolve.
// ---------------------------------------------------------------------------

describe("Phase 2.5: canonicalizeConstraintsPipeline writes related_functions snake_case", () => {
  it("projects relatedFunctions to a snake_case string[] on each constraint", () => {
    const merged: Record<string, unknown> = {
      functions: [
        { id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase" },
      ],
      constraints: [
        {
          description: "Search must exclude unauthorized records",
          source_text: "搜索功能必须排除未授权的记录",
          related_functions: ["FUN_SEARCH_CASE"], // candidate hint
        },
      ],
      // no missingConstraintCandidates
    };

    canonicalizeConstraintsPipeline(merged);

    const constraints = merged["constraints"] as Array<Record<string, unknown>>;
    expect(constraints).toHaveLength(1);
    const con = constraints[0];
    // snake_case compatibility write present and contains the functionId string
    expect(con["related_functions"]).toBeDefined();
    expect(Array.isArray(con["related_functions"])).toBe(true);
    expect(con["related_functions"]).toContain("FUN_SEARCH_CASE");
  });

  it("produces empty related_functions when no candidate/keyword matches", () => {
    const merged: Record<string, unknown> = {
      functions: [
        { id: "FUN_UNRELATED", displayId: "F002", name: "UnrelatedThing" },
      ],
      constraints: [
        {
          description: "Data must be encrypted at rest",
          source_text: "数据在存储时必须加密",
        },
      ],
    };

    canonicalizeConstraintsPipeline(merged);

    const constraints = merged["constraints"] as Array<Record<string, unknown>>;
    const con = constraints[0];
    expect(con["related_functions"]).toEqual([]);
  });
});
