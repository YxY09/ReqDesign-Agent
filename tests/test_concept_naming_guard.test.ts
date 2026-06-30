import { describe, it, expect, vi } from "vitest";
import { RepairTool } from "../src/tools/repair.js";
import { EvaluationTool } from "../src/tools/evaluation.js";
import { createTask } from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// Regression: domain-concept preserve-set guard on the repair deterministic
// rename path + evaluator naming-inconsistency exemption for authoritative
// domain concept names. SYNTHETIC names only (BaseWidget concept vs Widget
// analysis entity).
//
// Root cause being guarded: the evaluator emitted a "命名不一致" complaint when a
// class-diagram used the domain concept name `BaseWidget` while the analysis
// entity was `Widget`; the repair deterministic path then globally renamed the
// faithful concept name away. These guards refuse the rename / suppress the
// complaint when the used name IS an authoritative domain concept.
// ---------------------------------------------------------------------------

const withStreamCtx = {
  runWithStreamTagContext: (_t: string, _s: string, fn: () => Promise<unknown>) => fn(),
};

function makeTextLlm(text: string) {
  return {
    generateText: vi.fn().mockResolvedValue(text),
    generateJson: vi.fn(),
    ...withStreamCtx,
  } as any;
}

function noopLlm() {
  return {
    generateJson: vi.fn().mockResolvedValue({ issues: [] }),
    ...withStreamCtx,
  } as any;
}

describe("RepairTool deterministic rename — domain-concept preserve-set guard", () => {
  it("(a) does NOT rename an authoritative domain concept name to the analysis entity name", async () => {
    // wrongName `BaseWidget` IS a domain concept → deterministic rename must
    // be refused (return null → defer to LLM). The faithful diagram survives.
    const llm = makeTextLlm(
      JSON.stringify({
        class_diagram: "classDiagram\n    class BaseWidget {\n    }",
      }),
    );
    const agent = new RepairTool(llm);
    const task = createTask({
      id: "diagrams-class",
      type: "diagrams",
      description: "repair class diagram",
      contextHints: { diagram_kind: "class_diagram" },
    });

    const result = await agent.repair(
      task,
      { class_diagram: "classDiagram\n    class BaseWidget {\n    }" },
      [
        {
          severity: "major",
          description:
            "类图实体命名不一致: 需求分析中为 'Widget'，类图中使用了 'BaseWidget'",
          suggestion: "统一命名",
        },
      ],
      {
        domain_model_json: { concepts: [{ id: "D001", name: "BaseWidget" }] },
      },
    ) as Record<string, string> | null;

    expect(result).not.toBeNull();
    expect(result?.class_diagram).toContain("class BaseWidget");
    // Deterministic path was skipped → LLM was invoked.
    expect(llm.generateText).toHaveBeenCalled();
  });

  it("(b) DOES deterministically rename a non-concept typo to the analysis entity name", async () => {
    // wrongName `Widgit` is a typo, NOT a domain concept → deterministic rename
    // runs and the LLM is NOT consulted.
    const llm = makeTextLlm("SHOULD NOT BE CALLED");
    const agent = new RepairTool(llm);
    const task = createTask({
      id: "diagrams-class",
      type: "diagrams",
      description: "repair class diagram",
      contextHints: { diagram_kind: "class_diagram" },
    });

    const result = await agent.repair(
      task,
      { class_diagram: "classDiagram\n    class Widgit {\n    }" },
      [
        {
          severity: "major",
          description:
            "类图实体命名不一致: 需求分析中为 'Widget'，类图中使用了 'Widgit'",
          suggestion: "统一命名",
        },
      ],
      {
        domain_model_json: { concepts: [{ id: "D001", name: "BaseWidget" }] },
      },
    ) as Record<string, string> | null;

    expect(result).not.toBeNull();
    expect(result?.class_diagram).toContain("class Widget");
    expect(result?.class_diagram).not.toContain("Widgit");
    // Deterministic path handled it → LLM was NOT invoked.
    expect(llm.generateText).not.toHaveBeenCalled();
  });
});

describe("EvaluationTool naming-inconsistency — domain-concept exemption", () => {
  const domainModel = { concepts: [{ id: "D001", name: "BaseWidget" }] };

  it("(c) does NOT flag a class diagram class named after an authoritative domain concept", async () => {
    const evaluator = new EvaluationTool(noopLlm());

    const verdict = await evaluator.evaluate(
      "requirement",
      {
        functions: [{ id: "F001", name: "DoSomething" }],
        entities: [{ name: "Widget" }],
      },
      "",
      {},
      "",
      { "diagrams-1": { type: "diagrams", revision: 1 } },
      {
        "diagrams-1": {
          task_id: "diagrams-1",
          type: "diagrams",
          revision: 1,
          content: { class_diagram: "classDiagram\n    class BaseWidget {\n    }" },
        },
      },
      "design",
      false,
      undefined,
      undefined,
      domainModel,
    );

    const namingIssues = verdict.issues.filter(
      (issue) =>
        issue.description.includes("类图实体命名不一致") &&
        issue.description.includes("BaseWidget"),
    );
    expect(namingIssues).toHaveLength(0);
  });

  it("(d) still flags a non-concept renamed diagram class as a naming inconsistency", async () => {
    const evaluator = new EvaluationTool(noopLlm());

    const verdict = await evaluator.evaluate(
      "requirement",
      {
        functions: [{ id: "F001", name: "DoSomething" }],
        entities: [{ name: "Widget" }],
      },
      "",
      {},
      "",
      { "diagrams-1": { type: "diagrams", revision: 1 } },
      {
        "diagrams-1": {
          task_id: "diagrams-1",
          type: "diagrams",
          revision: 1,
          content: { class_diagram: "classDiagram\n    class WidgetRule {\n    }" },
        },
      },
      "design",
      false,
      undefined,
      undefined,
      domainModel,
    );

    const namingIssues = verdict.issues.filter((issue) =>
      issue.description.includes("类图实体命名不一致"),
    );
    expect(namingIssues.length).toBeGreaterThan(0);
    expect(namingIssues[0].description).toContain("WidgetRule");
  });
});
