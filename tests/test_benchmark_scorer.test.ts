/**
 * Unit tests for the hybrid benchmark scorer — fully offline.
 * Deterministic functions run directly; the LLM coverage judge runs against a
 * mock JudgeClient so no network/LLM is needed.
 */
import { describe, it, expect } from "vitest";
import {
  readNames,
  scoreDiagramSyntax,
  scoreDiagramStructure,
  scoreConsistency,
  buildCoveragePrompt,
  judgeCoverage,
  computeOverall,
  combineScores,
  computeRunSummary,
  casePassed,
  type JudgeClient,
  type GoldLabel,
} from "../src/benchmark/scorer.js";

function mockJudge(verdict: Record<string, unknown>): JudgeClient {
  return { generateJson: async () => verdict };
}

describe("readNames", () => {
  it("reads strings and objects with name/description", () => {
    expect(readNames(["a", "b"])).toEqual(["a", "b"]);
    expect(readNames([{ name: "X" }, { description: "Y" }], "name")).toEqual(["X", "Y"]);
    expect(readNames([{ description: "D" }], "description")).toEqual(["D"]);
    expect(readNames(null)).toEqual([]);
  });
});

describe("scoreDiagramSyntax (deterministic)", () => {
  it("is 0 when no diagrams", () => {
    expect(scoreDiagramSyntax({})).toBe(0);
  });

  it("is 100 when all present diagrams are valid mermaid", () => {
    const diagrams = {
      class_diagram: "classDiagram\n  class Order\n  class User\n  User --> Order",
      activity_diagram: "flowchart TD\n  A[开始] --> B[结束]",
      state_diagram: "stateDiagram-v2\n  [*] --> Open\n  Open --> [*]",
    };
    expect(scoreDiagramSyntax(diagrams)).toBe(100);
  });

  it("drops the score for invalid syntax", () => {
    const diagrams = {
      class_diagram: "classDiagram\n  class Order",
      activity_diagram: "this is not a diagram",
    };
    expect(scoreDiagramSyntax(diagrams)).toBe(50);
  });
});

describe("scoreDiagramStructure (deterministic)", () => {
  it("rewards start/end/flow/branch in an activity diagram", () => {
    const diagrams = { activity_diagram: "flowchart TD\n  A[开始] --> B{判断} -->|是| C[结束]" };
    expect(scoreDiagramStructure(diagrams)).toBe(100);
  });

  it("rewards initial/transitions/states in a state diagram", () => {
    const diagrams = { state_diagram: "stateDiagram-v2\n  [*] --> Open\n  Open --> Paid\n  Paid --> Shipped\n  Shipped --> [*]" };
    // initial(+35) + transition(+25) + >=3 states(+40) = 100
    expect(scoreDiagramStructure(diagrams)).toBe(100);
  });

  it("is 0 when there is no behavioural diagram", () => {
    expect(scoreDiagramStructure({ class_diagram: "classDiagram\n class A" })).toBe(0);
  });
});

describe("scoreConsistency (deterministic)", () => {
  it("is 100 when there are no entities to check", () => {
    expect(scoreConsistency({}, {})).toBe(100);
  });

  it("is 100 when every entity appears in the class diagram (language-agnostic)", () => {
    const result = { entities: [{ name: "Order" }, { name: "用户" }] };
    const diagrams = { class_diagram: "classDiagram\n class Order\n class 用户" };
    expect(scoreConsistency(result, diagrams)).toBe(100);
  });

  it("penalises entities missing from the class diagram", () => {
    const result = { entities: [{ name: "Order" }, { name: "Ghost" }] };
    const diagrams = { class_diagram: "classDiagram\n class Order" };
    expect(scoreConsistency(result, diagrams)).toBe(90); // one missing → -10
  });
});

describe("buildCoveragePrompt", () => {
  it("includes expected items + output, and skips empty categories", () => {
    const gold: GoldLabel = { expected_actors: ["用户"], expected_functions: [], expected_entities: ["订单"] };
    const result = { actors: ["customer"], entities: [{ name: "Order" }] };
    const { prompt, activeCategories } = buildCoveragePrompt(gold, result);
    expect(activeCategories.map((c) => c.label)).toEqual(["actors", "entities"]);
    expect(prompt).toContain("用户");
    expect(prompt).toContain("订单");
    expect(prompt).toContain("customer");
    expect(prompt).not.toContain("functions:"); // empty category omitted
  });
});

describe("judgeCoverage (LLM judge, mocked)", () => {
  const gold: GoldLabel = { expected_functions: ["登录", "搜索"], expected_actors: ["用户"] };

  it("scores 100 when the judge marks everything covered", async () => {
    const judge = mockJudge({
      functions: { covered: ["登录", "搜索"], missing: [] },
      actors: { covered: ["用户"], missing: [] },
    });
    const { score, detail } = await judgeCoverage(judge, gold, {});
    expect(score).toBe(100);
    const fns = detail.find((d) => d.category === "functions")!;
    expect(fns).toMatchObject({ expected: 2, covered: 2 });
  });

  it("averages per-category coverage", async () => {
    const judge = mockJudge({
      functions: { covered: ["登录"], missing: ["搜索"] },
      actors: { covered: ["用户"], missing: [] },
    });
    // functions 50% + actors 100% → 75
    const { score } = await judgeCoverage(judge, gold, {});
    expect(score).toBe(75);
  });

  it("is gold-anchored: invented items do not inflate the score", async () => {
    const judge = mockJudge({
      functions: { covered: ["登录", "搜索", "凭空捏造"], missing: [] },
      actors: { covered: [], missing: ["用户"] },
    });
    // functions counts only the 2 real gold items (100%); actors 0% → 50
    const { score, detail } = await judgeCoverage(judge, gold, {});
    expect(score).toBe(50);
    expect(detail.find((d) => d.category === "functions")!.covered).toBe(2);
  });

  it("returns 0 and empty detail for empty gold", async () => {
    const { score, detail } = await judgeCoverage(mockJudge({}), {}, {});
    expect(score).toBe(0);
    expect(detail).toEqual([]);
  });

  it("degrades gracefully when the judge throws", async () => {
    const judge: JudgeClient = { generateJson: async () => { throw new Error("LLM down"); } };
    const { score } = await judgeCoverage(judge, gold, {});
    expect(score).toBe(0);
  });
});

describe("computeOverall + combineScores", () => {
  it("weights coverage 0.5 / syntax 0.2 / structure 0.15 / consistency 0.15", () => {
    expect(computeOverall({ coverage: 50, diagram_syntax: 100, diagram_structure: 100, consistency: 100 })).toBe(75);
  });

  it("combineScores merges judge coverage with deterministic scoring", () => {
    const scores = combineScores({ coverage: 80, result: {}, diagrams: {} });
    // no diagrams → syntax 0, structure 0; no entities → consistency 100
    expect(scores.diagram_syntax).toBe(0);
    expect(scores.consistency).toBe(100);
    expect(scores.overall).toBe(55); // 0.5*80 + 0.15*100
  });
});

describe("computeRunSummary", () => {
  it("counts passed/failed/error and averages the new metrics", () => {
    const summary = computeRunSummary([
      { case_name: "a", status: "success", passed: true, scores: { coverage: 90, diagram_syntax: 100, diagram_structure: 80, consistency: 100, overall: 91 } },
      { case_name: "b", status: "success", passed: false, scores: { coverage: 50, diagram_syntax: 60, diagram_structure: 40, consistency: 80, overall: 55 } },
      { case_name: "c", status: "error", scores: {} },
    ]);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.error).toBe(1);
    const avg = summary.avg_scores as Record<string, number>;
    expect(avg.overall).toBe(73); // (91+55)/2
    expect(avg.coverage).toBe(70); // (90+50)/2
  });
});

describe("casePassed (review gate)", () => {
  it("passes only when overall clears the bar and no open major issues", () => {
    expect(casePassed(90, 0)).toBe(true);
    expect(casePassed(90, 3)).toBe(false);
    expect(casePassed(50, 0)).toBe(false);
  });
});
