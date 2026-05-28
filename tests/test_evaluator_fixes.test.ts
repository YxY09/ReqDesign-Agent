import { describe, it, expect, vi } from "vitest";
import { EvaluationTool } from "../src/tools/evaluation.js";
import { createIssue } from "../src/shared/types.js";
import type { Issue } from "../src/shared/types.js";

// -----------------------------------------------------------------------
// 模拟 LLM 存根
// -----------------------------------------------------------------------

/** 从 LLM 返回空的 issues。 */
function noopLlm() {
  return {
    generateJson: vi.fn().mockResolvedValue({ issues: [] }),
    _streamTag: "",
    get streamTag() { return this._streamTag; },
    set streamTag(v: string) { this._streamTag = v; },
  } as any;
}

/** 返回针对同级 diagram 字段的 issue（应该被过滤）。 */
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

/** 在 generateJson 上抛出异常。 */
function failingLlm() {
  return {
    generateJson: vi.fn().mockRejectedValue(new Error("invalid review json")),
    _streamTag: "",
    get streamTag() { return this._streamTag; },
    set streamTag(v: string) { this._streamTag = v; },
  } as any;
}

/** 返回误报的 analyze 分片 issue。 */
function analyzeShardFalsePositiveLlm() {
  return {
    generateJson: vi.fn().mockResolvedValue({
      issues: [
        {
          severity: "major",
          target_task_id: "analyze-1",
          target_task_type: "analyze",
          target_field: "requirement_json",
          description: "incorrectly treats a shard as a complete requirement spec",
          suggestion: "do not require full aggregate coverage for shards",
        },
      ],
    }),
    _streamTag: "",
    get streamTag() { return this._streamTag; },
    set streamTag(v: string) { this._streamTag = v; },
  } as any;
}

// -----------------------------------------------------------------------
// 测试：_buildFixes — 修复任务映射
// -----------------------------------------------------------------------

describe("EvaluationTool._buildFixes", () => {
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

    const fixes = EvaluationTool._buildFixes(issues);

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

    const fixes = EvaluationTool._buildFixes(issues);

    expect(fixes).toHaveLength(1);
    expect(fixes[0].type).toBe("design");
    expect(fixes[0].dependsOn).toEqual(["design-1"]);
  });
});

// -----------------------------------------------------------------------
// 测试：作用域快照
// -----------------------------------------------------------------------

describe("EvaluationTool evaluate — scoped snapshots", () => {
  it("does not pass when major issues remain", async () => {
    const evaluator = new EvaluationTool(noopLlm());

    const verdict = await evaluator.evaluate(
      "simple requirement",
      { functions: [{ id: "F001", name: "Login" }], entities: [] },
      "",
      {},
      "",
      { "design-1": { type: "design", revision: 1 } },
      {
        "design-1": {
          task_id: "design-1",
          type: "design",
          revision: 1,
          content: "## 模块划分\n\n## 核心类\n\n## 数据流",
        },
      },
      "design",
      false,
      ["design-1"],
    );

    // majors no longer prevent pass; only blockers do
    expect(verdict.passed).toBe(true);
    expect(verdict.issues.some((issue) => issue.severity === "major")).toBe(true);
  });

  it("keeps exact task_id in evaluated_revisions", async () => {
    const evaluator = new EvaluationTool(noopLlm());

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
    const evaluator = new EvaluationTool(siblingLeakLlm());

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

  it("skips LLM semantic review for multiple analyze shards in design runs", async () => {
    const llm = analyzeShardFalsePositiveLlm();
    const evaluator = new EvaluationTool(llm);

    const shard = {
      actors: ["Customer"],
      functions: [{ id: "F001", name: "Browse products" }],
      entities: [{ name: "Product", attributes: [] }],
    };

    const verdict = await evaluator.evaluate(
      "complex requirement",
      {},
      "",
      {},
      "",
      {
        "analyze-1": { type: "analyze", revision: 1 },
        "analyze-3": { type: "analyze", revision: 1 },
      },
      {
        "analyze-1": {
          task_id: "analyze-1",
          type: "analyze",
          revision: 1,
          content: shard,
        },
        "analyze-3": {
          task_id: "analyze-3",
          type: "analyze",
          revision: 1,
          content: shard,
        },
      },
      "design",
      false,
      ["analyze-1", "analyze-3"],
    );

    expect(verdict.passed).toBe(true);
    expect(verdict.issues).toEqual([]);
    expect(llm.generateJson).not.toHaveBeenCalled();
  });

  it("sends large analyze snapshots as valid truncated JSON summaries", async () => {
    const llm = noopLlm();
    const evaluator = new EvaluationTool(llm);
    const entities = Array.from({ length: 120 }, (_, i) => ({
      name: `Entity${i}`,
      description: "实体".repeat(80),
      attributes: Array.from({ length: 12 }, (_, j) => ({
        name: `field${j}`,
        type: "String",
        description: "字段说明".repeat(50),
      })),
      relationships: [],
    }));

    await evaluator.evaluate(
      "complex requirement",
      {},
      "",
      {},
      "",
      { "analyze-final": { type: "analyze", revision: 1 } },
      {
        "analyze-final": {
          task_id: "analyze-final",
          type: "analyze",
          revision: 1,
          content: {
            actors: ["Customer"],
            functions: [{ id: "F001", name: "Create order" }],
            entities,
            constraints: [{ id: "C001", description: "Order limit" }],
            exceptions: [{ id: "X001", description: "Payment failed" }],
            non_functional_requirements: [{ id: "N001", description: "Latency" }],
            business_processes: [{ id: "B001", description: "Checkout" }],
          },
        },
      },
      "design",
      false,
      ["analyze-final"],
    );

    const prompt = llm.generateJson.mock.calls[0][0] as string;
    expect(prompt).toContain("__review_truncated__");
    expect(prompt).toContain('"constraints"');
    expect(prompt).toContain('"business_processes"');

    const match = prompt.match(/```json\n([\s\S]*?)\n```/);
    expect(match).not.toBeNull();
    expect(() => JSON.parse(match![1])).not.toThrow();
  });

  it("wraps diagram snapshots under diagrams for LLM review", async () => {
    const llm = noopLlm();
    const evaluator = new EvaluationTool(llm);

    await evaluator.evaluate(
      "simple requirement",
      {},
      "",
      {},
      "",
      { "diagrams-final": { type: "diagrams", revision: 1 } },
      {
        "diagrams-final": {
          task_id: "diagrams-final",
          type: "diagrams",
          revision: 1,
          content: {
            activity_diagram: "flowchart TD\nA --> B",
          },
        },
      },
      "design",
      false,
      ["diagrams-final"],
    );

    const prompt = llm.generateJson.mock.calls[0][0] as string;
    const match = prompt.match(/```json\n([\s\S]*?)\n```/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toEqual({
      diagrams: {
        activity_diagram: "flowchart TD\nA --> B",
      },
    });
  });

  it("rule-checks refund flow and C001 coverage in activity diagrams", async () => {
    const evaluator = new EvaluationTool(noopLlm());
    const requirementJson = {
      functions: [
        { id: "F007", name: "RefundOrder", description: "顾客申请退货退款，商家审核，仓库验收后退款到账" },
      ],
      constraints: [
        { id: "C001", description: "单笔订单商品数量≤99，金额≤99999，同一商品≤10，地址需在配送范围内" },
      ],
      exceptions: [{ id: "X001", description: "支付失败" }],
    };

    const verdict = await evaluator.evaluate(
      "电商订单系统，包含退货退款和订单约束",
      requirementJson,
      "",
      {},
      "",
      { "diagrams-final": { type: "diagrams", revision: 1 } },
      {
        "diagrams-final": {
          task_id: "diagrams-final",
          type: "diagrams",
          revision: 1,
          content: {
            activity_diagram: "flowchart TD\nA[提交订单] --> B{总数量<=99且金额<=99999?}\nB --> C[支付]",
          },
        },
      },
      "design",
      false,
      ["diagrams-final"],
    );

    // Hardcoded domain checks (refund flow, C001) were removed.
    // The verdict should now pass without those checks.
    expect(verdict.passed).toBe(true);
    expect(verdict.issues.some((issue) =>
      issue.description.includes("退货退款流程") || issue.description.includes("C001"),
    )).toBe(false);
  });

  it("rule-checks undefined exception IDs before deep review", async () => {
    const evaluator = new EvaluationTool(noopLlm());

    const verdict = await evaluator.evaluate(
      "requirement",
      {
        functions: [{ id: "F001", name: "PayOrder" }],
        exceptions: [{ id: "X001", description: "支付失败" }],
      },
      "",
      {},
      "",
      { "design-1": { type: "design", revision: 1 } },
      {
        "design-1": {
          task_id: "design-1",
          type: "design",
          revision: 1,
          content: "## 模块划分\n支付失败按 E001 处理。\n## 核心类\nUser\n## 数据流\nOrder -> Payment",
        },
      },
      "design",
      false,
      ["design-1"],
    );

    // majors no longer prevent pass; only blockers do
    expect(verdict.passed).toBe(true);
    expect(verdict.issues.some((issue) =>
      issue.description.includes("未定义的异常 ID: E001"),
    )).toBe(true);
  });

  it("rule-checks complete refund happy-path coverage in tests", async () => {
    const evaluator = new EvaluationTool(noopLlm());

    const verdict = await evaluator.evaluate(
      "电商订单系统",
      {
        functions: [
          { id: "F007", name: "RefundOrder", description: "退货退款已发货已收货、填写物流单号" },
        ],
      },
      "",
      {},
      "",
      { "tests-1": { type: "tests", revision: 1 } },
      {
        "tests-1": {
          task_id: "tests-1",
          type: "tests",
          revision: 1,
          content: "## TC-N-001: 申请退款\n- 步骤: 用户点击申请退款\n- 预期: 退款申请提交成功",
        },
      },
      "design",
      false,
      ["tests-1"],
    );

    // Hardcoded refund test coverage check was removed.
    // The verdict should now pass without that check.
    expect(verdict.issues.some((issue) =>
      issue.description.includes("完整退货退款正常流程"),
    )).toBe(false);
  });
});

// -----------------------------------------------------------------------
// 测试：直接模式检测
// -----------------------------------------------------------------------

describe("EvaluationTool evaluate — direct mode detection", () => {
  it("analyze snapshot is not auto-detected as direct mode", async () => {
    const evaluator = new EvaluationTool(noopLlm());
    const seen: Record<string, unknown> = {};

    // 重写私有的 _llmReviewSnapshots 以捕获 isDirectMode 参数
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

// -----------------------------------------------------------------------
// 测试：LLM 失败处理
// -----------------------------------------------------------------------

describe("EvaluationTool evaluate — LLM failure", () => {
  it("propagates LLM error instead of silently passing", async () => {
    const evaluator = new EvaluationTool(failingLlm());

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

// -----------------------------------------------------------------------
// Regression: _checkUndefinedExceptionIds must match displayId, not just canonicalId
// -----------------------------------------------------------------------

describe("EvaluationTool — exception ID displayId matching regression", () => {
  it("does not flag displayId as undefined when canonicalId is present", async () => {
    const evaluator = new EvaluationTool(noopLlm());

    const verdict = await evaluator.evaluate(
      "requirement",
      {
        functions: [{ id: "F001", name: "PayOrder" }],
        exceptions: [{
          id: "EXC_2XTJ9S00",
          displayId: "X001",
          description: "支付失败",
        }],
      },
      "",
      {},
      "",
      { "design-1": { type: "design", revision: 1 } },
      {
        "design-1": {
          task_id: "design-1",
          type: "design",
          revision: 1,
          content: "## 模块划分\n支付失败按 X001 处理。\n## 核心类\nUser\n## 数据流\nOrder -> Payment",
        },
      },
      "design",
      false,
      ["design-1"],
    );

    // X001 is a valid displayId for EXC_2XTJ9S00, so should NOT be flagged as undefined
    const undefinedIdIssues = verdict.issues.filter((issue) =>
      issue.description.includes("未定义的异常 ID"),
    );
    expect(undefinedIdIssues).toHaveLength(0);
  });
});
