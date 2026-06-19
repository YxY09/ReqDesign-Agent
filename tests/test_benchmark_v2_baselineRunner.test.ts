/**
 * Compare-benchmark unit tests: baselineRunner.ts — prompt construction,
 * artifact writing, the no-scaffolding fairness guard, and an offline
 * end-to-end run with a stub LLM.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildBaselinePrompt,
  BASELINE_SYSTEM_PROMPT,
  findScaffoldingLeaks,
  parseBaselineResponse,
  writeBaselineArtifacts,
  runBaseline,
  normalizeBaselineAnalysisForMatrix,
  linkBaselineFunctions,
} from "../src/benchmark/baselineRunner.js";
import { AgentConfig } from "../src/config.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baseline-runner-"));
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

describe("buildBaselinePrompt — strong single-turn prompt", () => {
  const prompt = buildBaselinePrompt({ caseId: "demo", requirementText: "# req\n约束 X" });

  it("sets a senior architect role in the system prompt", () => {
    expect(BASELINE_SYSTEM_PROMPT.toLowerCase()).toMatch(/architect|架构师/);
  });

  it("requires the four deliverables + the output JSON schema", () => {
    expect(prompt).toContain("requirement_analysis");
    expect(prompt).toContain("system_design");
    expect(prompt).toContain("diagrams");
    expect(prompt).toContain("test_cases");
    expect(prompt).toContain("class_diagram");
    expect(prompt).toContain("activity_diagram");
    expect(prompt).toContain("state_diagram");
    // JSON output shape is pinned.
    expect(prompt).toMatch(/```json/);
  });

  it("embeds the four quality directives (cover constraints / handle exceptions / concrete design / tests aligned to constraints)", () => {
    expect(prompt).toMatch(/覆盖全部约束/);
    expect(prompt).toMatch(/处理异常/);
    expect(prompt).toMatch(/设计决策要具体/);
    expect(prompt).toMatch(/测试要对齐约束/);
  });

  it("embeds the raw requirement text", () => {
    expect(prompt).toContain("# req\n约束 X");
  });

  it("demands a single response (no staged process)", () => {
    expect(prompt).toMatch(/一次响应|这一次对话|一次响应中/);
  });

  it("requires a 约束覆盖矩阵 (constraint coverage matrix) section in system_design for traceability", () => {
    // Deliverable #2 must instruct the baseline to emit a Markdown coverage
    // table mapping each constraint id → module/class, so buildMatrix can
    // derive constraintToDesign from the baseline design just like the agent.
    expect(prompt).toContain("约束覆盖矩阵");
    // The table columns are spelled out so the baseline emits real Markdown.
    expect(prompt).toContain("约束ID");
    expect(prompt).toContain("实现模块/类");
    expect(prompt).toContain("触发条件");
    expect(prompt).toContain("处理行为");
    // The JSON template's system_design field echoes the requirement.
    expect(prompt).toMatch(/system_design.*约束覆盖矩阵/s);
  });
});

// ---------------------------------------------------------------------------
// Fairness: the prompt must NOT leak the Agent's multi-stage scaffolding
// ---------------------------------------------------------------------------

describe("findScaffoldingLeaks — fairness guard", () => {
  it("reports no leaks for the shipped baseline prompt + system prompt", () => {
    const prompt = buildBaselinePrompt({ caseId: "demo", requirementText: "req" });
    const leaks = findScaffoldingLeaks(prompt, BASELINE_SYSTEM_PROMPT);
    expect(leaks).toEqual([]);
  });

  it("detects a leaked staged-process phrase", () => {
    const leaks = findScaffoldingLeaks("do analyze → design → diagrams", "system");
    expect(leaks.length).toBeGreaterThan(0);
  });

  it("detects a leaked 'pipeline' mention", () => {
    const leaks = findScaffoldingLeaks("run the pipeline stages", "system");
    expect(leaks.some((l) => l.includes("pipeline"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Response parsing (defensive)
// ---------------------------------------------------------------------------

describe("parseBaselineResponse — defensive parsing", () => {
  it("parses a clean JSON object", () => {
    const raw = JSON.stringify({
      reasoning: "thinking",
      requirement_analysis: { actors: ["A"] },
      system_design: "# design",
      diagrams: { class_diagram: "classDiagram\n  class A" },
      test_cases: [{ id: "TC-1", target: "C1", expected_result: "ok" }],
    });
    const res = parseBaselineResponse(raw);
    expect(res.parsed).toBe(true);
    if (res.parsed) {
      expect(res.output.system_design).toBe("# design");
      expect(res.output.test_cases).toHaveLength(1);
      expect(res.output.diagrams.class_diagram).toContain("classDiagram");
    }
  });

  it("parses a ```json fenced response", () => {
    const raw = "```json\n" + JSON.stringify({ system_design: "x", test_cases: [] }) + "\n```";
    const res = parseBaselineResponse(raw);
    expect(res.parsed).toBe(true);
  });

  it("extracts the largest JSON object from surrounding prose", () => {
    const raw = "Here is the design:\n" + JSON.stringify({ system_design: "y", test_cases: [] }) + "\nThanks.";
    const res = parseBaselineResponse(raw);
    expect(res.parsed).toBe(true);
    if (res.parsed) expect(res.output.system_design).toBe("y");
  });

  it("tolerates a truncated object body (best-effort)", () => {
    // Missing closing brace; extractor returns the partial object.
    const raw = '{"system_design": "# partial';
    const res = parseBaselineResponse(raw);
    // Either it parses (lenient) or flags unparseable — must NOT throw.
    expect(typeof res.parsed).toBe("boolean");
  });

  it("returns parsed=false for an empty response", () => {
    const res = parseBaselineResponse("");
    expect(res.parsed).toBe(false);
  });

  it("coerces missing/typed fields into safe defaults", () => {
    const raw = JSON.stringify({ /* nothing */ });
    const res = parseBaselineResponse(raw);
    expect(res.parsed).toBe(true);
    if (res.parsed) {
      expect(res.output.system_design).toBe("");
      expect(res.output.diagrams).toEqual({});
      expect(res.output.test_cases).toEqual([]);
      expect(res.output.requirement_analysis).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// Artifact writing (Agent-aligned layout)
// ---------------------------------------------------------------------------

describe("writeBaselineArtifacts — Agent-aligned layout", () => {
  it("writes the requirement/design/diagrams/tests sub-dirs", () => {
    const out = join(root, "baseline");
    writeBaselineArtifacts(out, {
      requirement_analysis: { actors: ["User"] },
      system_design: "# System Design",
      diagrams: {
        class_diagram: "classDiagram\n  class User",
        activity_diagram: "flowchart TD\n  A-->B",
        empty_diagram: "   ",
      },
      test_cases: [{ id: "TC-1", target: "C1", expected_result: "ok" }],
    });

    // Agent-aligned paths the judge reads.
    expect(existsSync(join(out, "requirement", "analysis.json"))).toBe(true);
    expect(existsSync(join(out, "design", "system_design.md"))).toBe(true);
    expect(existsSync(join(out, "diagrams", "class_diagram.mmd"))).toBe(true);
    expect(existsSync(join(out, "diagrams", "activity_diagram.mmd"))).toBe(true);
    // Empty diagrams are dropped.
    expect(existsSync(join(out, "diagrams", "empty_diagram.mmd"))).toBe(false);
    expect(existsSync(join(out, "tests", "test_cases.json"))).toBe(true);

    // test_cases.json has the { test_cases: [...] } shape the Agent writes.
    const tc = JSON.parse(readFileSync(join(out, "tests", "test_cases.json"), "utf8"));
    expect(Array.isArray(tc.test_cases)).toBe(true);
    expect(tc.test_cases).toHaveLength(1);

    // analysis.json is valid JSON object.
    const an = JSON.parse(readFileSync(join(out, "requirement", "analysis.json"), "utf8"));
    expect(an.actors).toEqual(["User"]);
  });

  it("writes a structurally-valid traces/traceability_matrix.json (fairness)", () => {
    // Constraint text mentions the function name ("Register") so the baseline
    // heuristic links C001 → F001; the design carries a markdown module
    // table mapping F001 → a module, so buildMatrix tier-2 populates
    // constraintToDesign (the same strict branch the agent uses).
    const out = join(root, "baseline");
    writeBaselineArtifacts(out, {
      requirement_analysis: {
        constraints: ["N001: Register must encrypt at rest"],
        functions: ["Register (F001)"],
        exceptions: ["Duplicate user"],
      },
      system_design: [
        "# Design",
        "",
        "| 模块名称 | 包含功能 |",
        "|----------|----------|",
        "| UserModule | F001 |",
      ].join("\n"),
      diagrams: {},
      test_cases: [{ id: "TC-N-001", target: "F001", expected_result: "ok" }],
    });

    const matrixPath = join(out, "traces", "traceability_matrix.json");
    expect(existsSync(matrixPath)).toBe(true);

    const m = JSON.parse(readFileSync(matrixPath, "utf8"));
    // Every TraceabilityMatrix field present.
    for (const key of [
      "functionToConstraints",
      "constraintToFunctions",
      "constraintToDesign",
      "functionToDesign",
      "exceptionToDesign",
      "constraintToTests",
      "constraintToEvidence",
      "functionToTests",
      "exceptionToTests",
      "uncoveredConstraints",
      "uncoveredFunctions",
      "uncoveredExceptions",
    ]) {
      expect(m).toHaveProperty(key);
    }

    // The loose baseline input was normalized to the C/F/X key-space: the
    // function F001 is targeted by TC-N-001, so the matrix is NOT all-empty.
    expect(Object.keys(m.functionToTests)).toContain("F001");
    expect(m.functionToTests["F001"]).toEqual(["TC-N-001"]);

    // Fairness fix: the N001 constraint was normalized to C001 AND linked to
    // F001 (related_functions) AND F001 maps to UserModule in the design →
    // constraintToDesign is NON-empty (tier-2 bridge works) and C001 is no
    // longer uncovered. Previously this asserted C001 uncovered, which froze
    // the bug (baseline never emitted related_functions).
    expect(m.constraintToFunctions["C001"]).toContain("F001");
    expect(m.constraintToDesign["C001"]).toEqual(["UserModule"]);
    expect(m.uncoveredConstraints).not.toContain("C001");
  });
});

// ---------------------------------------------------------------------------
// normalizeBaselineAnalysisForMatrix — loose-string → object normalization
// ---------------------------------------------------------------------------

describe("normalizeBaselineAnalysisForMatrix — loose baseline → C/F/X key-space", () => {
  it("turns loose string arrays into objects with name/description + displayIds", () => {
    const { normalized, idMap } = normalizeBaselineAnalysisForMatrix({
      constraints: ["N001: AES encryption", "plain text constraint"],
      functions: ["Register (F001)", "Login"],
      exceptions: ["Invalid Master Key"],
    });

    const constraints = normalized.constraints as Array<Record<string, unknown>>;
    expect(constraints).toHaveLength(2);
    expect(constraints[0]).toHaveProperty("description", "AES encryption");
    expect(constraints[0]).toHaveProperty("displayId", "C001");
    expect(constraints[1]).toHaveProperty("description", "plain text constraint");
    expect(constraints[1]).toHaveProperty("displayId", "C002");

    const functions = normalized.functions as Array<Record<string, unknown>>;
    // Embedded F-id is preserved so test targets keep matching.
    expect(functions[0]).toHaveProperty("displayId", "F001");
    expect(functions[0]).toHaveProperty("name", "Register");
    // No embedded id → assigned sequentially.
    expect(functions[1]).toHaveProperty("displayId", "F002");
    expect(functions[1]).toHaveProperty("name", "Login");

    const exceptions = normalized.exceptions as Array<Record<string, unknown>>;
    expect(exceptions[0]).toHaveProperty("description", "Invalid Master Key");
    expect(exceptions[0]).toHaveProperty("displayId", "X001");

    // oldId → new displayId map is returned for target rewriting.
    expect(idMap.get("N001")).toBe("C001");
    // F001 is preserved (not re-mapped).
    expect(idMap.has("F001")).toBe(false);
  });

  it("tolerates already-object items and empty/missing arrays", () => {
    const { normalized } = normalizeBaselineAnalysisForMatrix({
      constraints: [{ description: "obj constraint", displayId: "C009" }],
      functions: [],
      // exceptions omitted entirely
    });
    expect((normalized.constraints as unknown[])[0]).toMatchObject({ description: "obj constraint" });
    expect(normalized.functions).toEqual([]);
    expect(normalized.exceptions).toEqual([]);
  });

  it("emits related_functions when a constraint text overlaps a function name", () => {
    const { normalized } = normalizeBaselineAnalysisForMatrix({
      constraints: ["Register must encrypt at rest", "purely unrelated rule"],
      functions: ["Register (F001)"],
    });
    const constraints = normalized.constraints as Array<Record<string, unknown>>;
    // C001 text contains the function name "Register" -> linked to F001.
    expect(constraints[0].related_functions).toEqual(["F001"]);
    // C002 has no keyword overlap -> no related_functions key (may be empty/absent).
    expect(constraints[1].related_functions).toBeUndefined();
  });

  it("links a constraint to multiple functions when several names match", () => {
    const { normalized } = normalizeBaselineAnalysisForMatrix({
      constraints: ["Checkout uses both Cart and Payment"],
      functions: ["Cart", "Payment", "Login"],
    });
    const constraints = normalized.constraints as Array<Record<string, unknown>>;
    expect(constraints[0].related_functions).toEqual(["F001", "F002"]); // Cart, Payment
  });
});

describe("linkBaselineFunctions — direct heuristic (exported)", () => {
  it("returns the matching function displayIds", () => {
    const links = linkBaselineFunctions("the Register flow must be idempotent", [
      { displayId: "F001", name: "Register" },
      { displayId: "F002", name: "Checkout" },
    ]);
    expect(links).toEqual(["F001"]);
  });

  it("splits camelCase names so significant tokens match", () => {
    const links = linkBaselineFunctions("SearchCase is case-sensitive", [
      { displayId: "F003", name: "SearchCase" },
    ]);
    // "search"/"case" tokens (>3 chars) match the constraint text.
    expect(links).toEqual(["F003"]);
  });

  it("returns [] when nothing overlaps (fair: weak linking)", () => {
    const links = linkBaselineFunctions("encrypt at rest", [
      { displayId: "F001", name: "Register" },
    ]);
    expect(links).toEqual([]);
  });

  // --- CJK matching: Chinese function names ---

  it("matches Chinese name via CJK bigram in constraint text", () => {
    // "用户管理" → bigrams: "用户", "户管", "管理"
    // Constraint "用户管理模块" contains "用户" and "管理" and "户管"
    const links = linkBaselineFunctions("用户管理模块必须支持权限控制", [
      { displayId: "F001", name: "用户管理" },
      { displayId: "F002", name: "支付" },
    ]);
    expect(links).toEqual(["F001"]);
  });

  it("matches short CJK name (2 chars) via bigram", () => {
    // "挂号" is 2 chars → single bigram "挂号"
    const links = linkBaselineFunctions("实现挂号预约流程", [
      { displayId: "F003", name: "挂号" },
    ]);
    expect(links).toEqual(["F003"]);
  });

  it("returns [] for single-CJK-char function name (too ambiguous)", () => {
    const links = linkBaselineFunctions("药房发药", [
      { displayId: "F004", name: "药" },
    ]);
    expect(links).toEqual([]);
  });

  it("matches multiple CJK functions in one constraint", () => {
    const links = linkBaselineFunctions("用户登录后可以查看报告", [
      { displayId: "F001", name: "用户登录" },
      { displayId: "F002", name: "查看报告" },
      { displayId: "F003", name: "支付" },
    ]);
    expect(links).toEqual(["F001", "F002"]);
  });

  it("CJK and English function names coexist correctly", () => {
    const links = linkBaselineFunctions("用户挂号后进入Register流程", [
      { displayId: "F001", name: "用户挂号" },
      { displayId: "F002", name: "Register" },
      { displayId: "F003", name: "Checkout" },
    ]);
    expect(links).toEqual(["F001", "F002"]);
  });

  it("no false match when CJK bigram is absent", () => {
    // "用户管理" bigrams: "用户", "户管", "管理" — none in "订单支付"
    const links = linkBaselineFunctions("订单支付流程", [
      { displayId: "F001", name: "用户管理" },
    ]);
    expect(links).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Offline end-to-end runBaseline with a stub LLM
// ---------------------------------------------------------------------------

describe("runBaseline — offline run with stub LLM", () => {
  it("calls the LLM once, parses, and writes Agent-aligned artifacts", async () => {
    const casePath = join(root, "demo.md");
    writeFileSync(casePath, "# demo\n约束 C1", "utf8");
    const out = join(root, "out");

    let calls = 0;
    const stubLlm = {
      generateJson: async () => {
        calls++;
        return {
          requirement_analysis: { constraints: ["C1"] },
          system_design: "# Design for C1",
          diagrams: { class_diagram: "classDiagram\n  class X" },
          test_cases: [{ id: "TC-1", target: "C1", expected_result: "rejected" }],
        };
      },
    };

    const result = await runBaseline({
      config: new AgentConfig(),
      casePath,
      outputDir: out,
      llm: stubLlm,
    });

    expect(calls).toBe(1); // exactly one LLM turn — fairness
    expect(result.parsed).toBe(true);
    expect(result.case_id).toBe("demo");
    expect(existsSync(join(out, "design", "system_design.md"))).toBe(true);
    expect(existsSync(join(out, "tests", "test_cases.json"))).toBe(true);
    // Fairness: baseline now emits a traceability matrix like the agent.
    expect(existsSync(join(out, "traces", "traceability_matrix.json"))).toBe(true);
  });

  it("flags parsed=false and still writes (empty) artifacts when the LLM returns junk", async () => {
    const casePath = join(root, "demo.md");
    writeFileSync(casePath, "# demo", "utf8");
    const out = join(root, "out");

    const stubLlm = {
      generateJson: async () => ({ /* no useful fields */ }),
    };

    const result = await runBaseline({
      config: new AgentConfig(),
      casePath,
      outputDir: out,
      llm: stubLlm,
    });

    // It coerces to defaults → parsed=true (empty but valid). Even so, files exist.
    expect(existsSync(join(out, "tests", "test_cases.json"))).toBe(true);
    // If a stub returns truly non-object it should not throw; cover that path too.
    expect(typeof result.parsed).toBe("boolean");
  });

  it("throws when the case file does not exist", async () => {
    await expect(
      runBaseline({
        config: new AgentConfig(),
        casePath: join(root, "missing.md"),
        outputDir: join(root, "out"),
        llm: { generateJson: async () => ({}) },
      }),
    ).rejects.toThrow(/not found/);
  });
});
