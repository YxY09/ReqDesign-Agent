import { describe, it, expect, vi } from "vitest";
import { EvaluationTool } from "../src/tools/evaluation.js";
import { createIssue } from "../src/shared/types.js";
import type { Issue } from "../src/shared/types.js";
import { validateReview } from "../src/shared/reviewValidator.js";

// -----------------------------------------------------------------------
// 模拟 LLM 存根
// -----------------------------------------------------------------------

/** 从 LLM 返回空的 issues。 */
const withStreamCtx = { runWithStreamTagContext: (_t: string, _s: string, fn: () => Promise<unknown>) => fn() };

function noopLlm() {
  return {
    generateJson: vi.fn().mockResolvedValue({ issues: [] }),
    ...withStreamCtx,
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
    ...withStreamCtx,
  } as any;
}

/** 在 generateJson 上抛出异常。 */
function failingLlm() {
  return {
    generateJson: vi.fn().mockRejectedValue(new Error("invalid review json")),
    ...withStreamCtx,
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
    ...withStreamCtx,
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

  it("renders structured DesignModel snapshots for LLM review", async () => {
    const llm = noopLlm();
    const evaluator = new EvaluationTool(llm);
    const designModel = {
      constraintImplementations: [
        {
          constraintId: "C001",
          sourceTextVerbatim: "单笔订单商品数量不超过99件",
          implementationMechanism: "OrderValidator 校验单笔订单商品数量不超过99件",
          parametersPreserved: ["99件"],
          trigger: "提交订单时",
          handling: "超过99件则拒绝下单",
          affectedModuleIds: ["MOD_ORDER"],
          affectedClassNames: ["OrderValidator"],
        },
      ],
      exceptionImplementations: [],
      modules: [{ id: "MOD_ORDER", name: "订单模块", responsibility: "订单处理", functionIds: ["F001"] }],
      classes: [{ name: "OrderValidator", kind: "helper", responsibility: "订单校验" }],
      dataFlows: [{ name: "下单流程", steps: ["OrderService -> OrderValidator"], relatedFunctionIds: ["F001"] }],
      supplementaryClasses: [],
      coverageMatrix: [
        {
          refId: "C001",
          refKind: "constraint",
          originalDescription: "单笔订单商品数量不超过99件",
          designDecision: "见 constraintImplementations[C001]",
          affectedModuleIds: ["MOD_ORDER"],
          affectedClassNames: ["OrderValidator"],
          testImplication: "边界测试99件/100件",
        },
      ],
    };

    await evaluator.evaluate(
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
          content: designModel,
        },
      },
      "design",
      false,
      ["design-1"],
    );

    const prompt = llm.generateJson.mock.calls[0][0] as string;
    expect(prompt).not.toContain("[object Object]");
    expect(prompt).toContain("## 约束实现");
    expect(prompt).toContain("constraintImplementations[C001]");
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
          content: "## 模块划分\n支付失败按 X999 处理。\n## 核心类\nUser\n## 数据流\nOrder -> Payment",
        },
      },
      "design",
      false,
      ["design-1"],
    );

    // majors no longer prevent pass; only blockers do
    expect(verdict.passed).toBe(true);
    expect(verdict.issues.some((issue) =>
      issue.description.includes("未定义的异常 ID: X999"),
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

  it("maps diagrams-final activity issues back to the source diagram task", async () => {
    const evaluator = new EvaluationTool(noopLlm());

    const verdict = await evaluator.evaluate(
      "case workflow",
      {
        business_processes: [
          { name: "CaseRegistration", steps: ["register case", "assign officer"] },
          { name: "AuditReviewProcess", steps: ["review audit trail", "approve finding"] },
        ],
      },
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
            activity_diagram: "flowchart TD\nA[Start] --> B[Done]",
          },
          sourceTaskIds: ["diagrams-activity"],
          sourceRevisions: { "diagrams-activity": 1 },
        },
      },
      "design",
      false,
      ["diagrams-final"],
    );

    expect(verdict.issues.some((issue) =>
      issue.targetTaskId === "diagrams-activity" &&
      issue.targetField === "diagrams.activity_diagram",
    )).toBe(true);
  });

  it("unwraps nested diagrams before Mermaid header checks", async () => {
    const evaluator = new EvaluationTool(noopLlm());

    const verdict = await evaluator.evaluate(
      "",
      {},
      "",
      {},
      "",
      { "diagrams-activity": { type: "diagrams", revision: 1 } },
      {
        "diagrams-activity": {
          task_id: "diagrams-activity",
          type: "diagrams",
          revision: 1,
          content: {
            diagrams: {
              activity_diagram: "flowchart TD\nA[Start] --> B[Done]",
            },
          },
        },
      },
      "design",
      false,
      ["diagrams-activity"],
    );

    expect(verdict.issues.some((issue) =>
      issue.description.includes("Mermaid 头部"),
    )).toBe(false);
    expect(verdict.passed).toBe(true);
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

// -----------------------------------------------------------------------
// Regression: multiple uncovered constraints collapse into one issue
// -----------------------------------------------------------------------

describe("EvaluationTool — constraint coverage merging", () => {
  it("emits one merged issue when multiple constraints are uncovered, not one per constraint", async () => {
    const evaluator = new EvaluationTool(noopLlm());

    const reqJson = {
      functions: [{ id: "F001", name: "PlaceOrder" }],
      constraints: [
        { id: "CON_FUNC_ABC", description: "最大下单数量限制" },
        { id: "CON_FUNC_DEF", description: "支付超时限制" },
        { id: "CON_FUNC_GHI", description: "库存不足限制" },
      ],
    };

    const verdict = await evaluator.evaluate(
      "requirement",
      reqJson,
      "",
      {},
      "",
      { "tests-1": { type: "tests", revision: 1 } },
      {
        "tests-1": {
          task_id: "tests-1",
          type: "tests",
          revision: 1,
          // None of the 3 constraint IDs appear in this test content
          content: "## TC-N-001: 正常下单\n- 步骤: 用户下单\n- 预期: 订单创建成功",
        },
      },
      "design",
      false,
      ["tests-1"],
    );

    const constraintIssues = verdict.issues.filter(
      (issue) => issue.targetField === "test_cases" && issue.description.includes("约束"),
    );
    // Should be exactly ONE merged issue, not three separate issues
    expect(constraintIssues).toHaveLength(1);
    expect(constraintIssues[0].description).toContain("3 个约束未被测试用例覆盖");
    expect(constraintIssues[0].description).toContain("CON_FUNC_ABC");
    expect(constraintIssues[0].description).toContain("CON_FUNC_DEF");
    expect(constraintIssues[0].description).toContain("CON_FUNC_GHI");
  });

  it("emits no constraint issue when all constraints are covered", async () => {
    const evaluator = new EvaluationTool(noopLlm());

    const reqJson = {
      constraints: [
        { id: "C001", description: "订单数量限制" },
      ],
    };

    const verdict = await evaluator.evaluate(
      "requirement",
      reqJson,
      "",
      {},
      "",
      { "tests-1": { type: "tests", revision: 1 } },
      {
        "tests-1": {
          task_id: "tests-1",
          type: "tests",
          revision: 1,
          content: "## TC-B-001: C001 边界测试\n- 步骤: 构造C001边界值\n- 预期: 系统拒绝",
        },
      },
      "design",
      false,
      ["tests-1"],
    );

    const constraintIssues = verdict.issues.filter(
      (issue) => issue.targetField === "test_cases" && issue.description.includes("约束"),
    );
    expect(constraintIssues).toHaveLength(0);
  });
});

describe("EvaluationTool._requirementForReview", () => {
  it("returns the text unchanged when within budget", () => {
    const text = "短需求文本";
    expect(EvaluationTool._requirementForReview(text, 1000)).toBe(text);
  });

  it("keeps both head and tail when truncating, with a marker between", () => {
    const head = "HEAD_MARKER_" + "a".repeat(500);
    const tail = "b".repeat(500) + "_TAIL_MARKER";
    const text = head + "c".repeat(5000) + tail;
    const out = EvaluationTool._requirementForReview(text, 1000);

    // tail-aware truncation must preserve the document end (where
    // constraints / NFRs / acceptance criteria typically live).
    expect(out).toContain("HEAD_MARKER_");
    expect(out).toContain("_TAIL_MARKER");
    expect(out).toContain("__review_truncated__");
    expect(out.length).toBeLessThan(text.length);
    expect(out.length).toBeLessThan(1000 + 200);
  });

  it("allocates ~70% of the budget to the head", () => {
    const text = "x".repeat(10000);
    const out = EvaluationTool._requirementForReview(text, 1000);
    const headPart = out.split("__review_truncated__")[0];
    expect(headPart.length).toBeGreaterThanOrEqual(700);
    expect(headPart.length).toBeLessThan(760);
  });
});

// ---------------------------------------------------------------------------
// _checkUndefinedExceptionIds — dynamic prefix detection
// ---------------------------------------------------------------------------

describe("EvaluationTool._checkUndefinedExceptionIds dynamic prefix", () => {
  function checkIds(
    text: string,
    exceptions: Array<{ id: string; displayId?: string; name: string }>,
  ) {
    const tool = new EvaluationTool(noopLlm());
    const requirementJson = {
      exceptions: exceptions.map((e) => ({ ...e, displayId: e.displayId ?? e.id })),
    };
    return (tool as unknown as { _checkUndefinedExceptionIds(a: string, b: string, c: string, d: string, e: Record<string, unknown>): import("../src/shared/types.js").Issue[] })
      ._checkUndefinedExceptionIds("design-1", "design", "design_text", text, requirementJson);
  }

  it("detects undefined E-prefix exception ID when exceptions use E-prefix", () => {
    const issues = checkIds("Throws E999 on failure", [
      { id: "E001", name: "InvalidInput" },
      { id: "E002", name: "NotFound" },
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0].description).toContain("E999");
  });

  it("does NOT flag a valid E-prefix exception ID", () => {
    const issues = checkIds("Throws E001 on failure", [
      { id: "E001", name: "InvalidInput" },
    ]);
    expect(issues.length).toBe(0);
  });

  it("detects undefined EXC_-prefix exception ID", () => {
    const issues = checkIds("See EXC_UNKNOWN for details", [
      { id: "EXC_TIMEOUT", name: "Timeout" },
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0].description).toContain("EXC_UNKNOWN");
  });

  it("still detects undefined X-prefix exception ID (legacy format)", () => {
    const issues = checkIds("Throws X999 on failure", [
      { id: "X001", name: "InvalidInput" },
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0].description).toContain("X999");
  });

  it("returns empty when no exceptions defined", () => {
    const tool = new EvaluationTool(noopLlm());
    const issues = (tool as unknown as { _checkUndefinedExceptionIds(a: string, b: string, c: string, d: string, e: Record<string, unknown>): import("../src/shared/types.js").Issue[] })
      ._checkUndefinedExceptionIds("design-1", "design", "design_text", "E001", {});
    expect(issues.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: _checkClassDiagramEntities — relationship endpoint completeness
// (defect 1: associations like "1" --> "*" previously slipped through)
// ---------------------------------------------------------------------------

describe("EvaluationTool._checkClassDiagramEntities — relationship endpoints", () => {
  function checkEntities(
    mermaidText: string,
    requirementJson: Record<string, unknown>,
  ) {
    const tool = new EvaluationTool(noopLlm());
    return (tool as unknown as {
      _checkClassDiagramEntities(
        taskId: string,
        mermaidText: string,
        requirementJson: Record<string, unknown>,
      ): import("../src/shared/types.js").Issue[];
    })._checkClassDiagramEntities("diagrams-final", mermaidText, requirementJson);
  }

  it('flags dangling association endpoints (`"1" --> "*"`) referenced but never defined', () => {
    const mermaid = `classDiagram
    class Patient {
        -String id
    }
    class Doctor {
        -String id
    }
    Patient "1" --> "*" Doctor : visits
    Patient "1" --> "*" Insurance : uses
    Doctor "1" --> "*" PrescriptionItem : writes`;
    const issues = checkEntities(mermaid, { entities: [] });
    const dangling = issues.find((i) =>
      i.description.includes("类图关系引用了未定义的类"));
    expect(dangling).toBeDefined();
    expect(dangling!.description).toContain("Insurance");
    expect(dangling!.description).toContain("PrescriptionItem");
    // Doctor IS defined, so it must not appear in the dangling list.
    expect(dangling!.description).not.toContain("Doctor");
  });

  it("does NOT flag endpoints when every referenced class is defined", () => {
    const mermaid = `classDiagram
    class User {
        -int id
    }
    class Book {
        -int id
    }
    User --> Book : borrows`;
    const issues = checkEntities(mermaid, { entities: [] });
    expect(issues.some((i) => i.description.includes("类图关系引用了未定义的类"))).toBe(false);
  });

  it("flags dangling inheritance endpoints (<|-- / --|>)", () => {
    const mermaid = `classDiagram
    class Dog {
        -String name
    }
    Dog --|> Animal
    Cat <|-- Feline`;
    const issues = checkEntities(mermaid, { entities: [] });
    const dangling = issues.find((i) =>
      i.description.includes("类图关系引用了未定义的类"));
    expect(dangling).toBeDefined();
    // Animal, Cat and Feline are all undefined
    expect(dangling!.description).toContain("Animal");
  });

  it("uses precise set membership for missing entities (not fuzzy substring)", () => {
    // User is required; UserAccount is defined. Fuzzy `.includes` would hide User.
    const mermaid = `classDiagram
    class UserAccount {
        -String id
    }`;
    const issues = checkEntities(mermaid, {
      entities: [{ name: "User", attributes: [] }],
    });
    const missing = issues.find((i) =>
      i.description.includes("类图缺少需求分析中的核心实体"));
    expect(missing).toBeDefined();
    expect(missing!.description).toContain("User");
  });
});

// ---------------------------------------------------------------------------
// Regression: target-content alignment (defect 2: hallucinated tests)
// ---------------------------------------------------------------------------

describe("target-content alignment", () => {
  const analysis = {
    constraints: [
      { id: "C001", displayId: "C001", source_text: "挂号约束：每位医生每日限号50，同一患者同日同科限挂1次" },
    ],
  };

  it("flags a test whose valid target ID verifies an unrelated fabricated rule", () => {
    const verdict = validateReview(
      analysis,
      "",
      JSON.stringify({
        test_cases: [
          {
            id: "TC-B-001",
            target: "C001",
            title: "密码复杂度边界",
            steps: ["输入8位密码", "输入含特殊字符密码"],
            expected_result: "密码强度达标",
          },
        ],
      }),
    );
    const check = verdict.checks.find((c) => c.name === "测试目标/内容对齐检测");
    expect(check).toBeDefined();
    expect(check!.passed).toBe(false);
    expect(check!.detail).toContain("TC-B-001");
  });

  it("does NOT flag a test that verifies the constraint's actual rule", () => {
    const verdict = validateReview(
      analysis,
      "",
      JSON.stringify({
        test_cases: [
          {
            id: "TC-B-001",
            target: "C001 挂号约束",
            title: "医生限号边界",
            steps: ["医生当日挂号达到50次", "患者再次挂号"],
            expected_result: "系统拒绝挂号提示达上限",
          },
        ],
      }),
    );
    const check = verdict.checks.find((c) => c.name === "测试目标/内容对齐检测");
    expect(check).toBeDefined();
    expect(check!.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: _checkFunctionIdConsistency — whitelist must accept FUN_ form
// (RequirementIndex allowedIds holds both F001 displayId and FUN_xxx canonicalId;
// the evaluator whitelist + extractor previously only kept F\d+, causing
// FUN_xxx canonical IDs to be mishandled as ghost references.)
// ---------------------------------------------------------------------------

describe("EvaluationTool._checkFunctionIdConsistency — FUN_ canonical form", () => {
  function checkConsistency(
    snapshots: Record<string, Record<string, unknown>>,
    requirementJson: Record<string, unknown>,
  ) {
    const tool = new EvaluationTool(noopLlm());
    return (tool as unknown as {
      _checkFunctionIdConsistency(
        snapshots: Record<string, Record<string, unknown>>,
        requirementJson: Record<string, unknown>,
      ): Issue[];
    })._checkFunctionIdConsistency(snapshots, requirementJson);
  }

  it("does NOT flag a valid FUN_xxx reference (displayId F001 + canonicalId FUN_xxx)", () => {
    // RequirementIndex adds both displayId and canonicalId to allowedIds;
    // the evaluator whitelist must likewise accept both.
    const issues = checkConsistency(
      {
        "design-1": {
          type: "design",
          content: "模块实现 F001 (FUN_LOGIN) 的登录流程。",
        },
      },
      {
        functions: [
          { id: "FUN_LOGIN", displayId: "F001", name: "用户登录" },
        ],
      },
    );
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag a bare FUN_xxx reference (no F001 displayId in text)", () => {
    const issues = checkConsistency(
      {
        "design-1": {
          type: "design",
          content: "本设计覆盖 FUN_LOGIN 的鉴权逻辑。",
        },
      },
      {
        functions: [
          { id: "FUN_LOGIN", displayId: "F001", name: "用户登录" },
        ],
      },
    );
    expect(issues).toHaveLength(0);
  });

  it("flags an undefined FUN_xxx reference as a ghost", () => {
    // The extractor must capture FUN_xxx tokens so a referenced-but-undefined
    // canonical ID is still caught as inconsistent (this fails on the
    // pre-fix F\d+-only extractor, validating the fix actually takes effect).
    const issues = checkConsistency(
      {
        "design-1": {
          type: "design",
          content: "本设计实现 FUN_GHOST 功能。",
        },
      },
      {
        functions: [
          { id: "FUN_LOGIN", displayId: "F001", name: "用户登录" },
        ],
      },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].description).toContain("FUN_GHOST");
  });

  it("still flags an undefined Fxxx reference", () => {
    const issues = checkConsistency(
      {
        "tests-1": {
          type: "tests",
          content: "用例覆盖 F999。",
        },
      },
      {
        functions: [
          { id: "FUN_LOGIN", displayId: "F001", name: "用户登录" },
        ],
      },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].description).toContain("F999");
  });

  it("returns no issues when no function IDs are defined", () => {
    const issues = checkConsistency(
      {
        "design-1": {
          type: "design",
          content: "本设计实现 F001。",
        },
      },
      { functions: [] },
    );
    expect(issues).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------
// Pillar A: defect vs advisory classification (control flow keys off this,
// NOT the LLM's severity label)
// -----------------------------------------------------------------------

describe("EvaluationTool issue-kind classification", () => {
  it("classifies coverage/completeness opinions as advisory even at major severity", () => {
    for (const description of [
      "功能 F010 未被测试用例覆盖",
      "4 个约束未被测试用例覆盖: C001, C009",
      "测试用例覆盖不完整，缺少边界测试",
      "部分类缺少明确的需求原文依据",
    ]) {
      const issue = createIssue({ severity: "major", description });
      expect(EvaluationTool._classifyIssueKind(issue)).toBe("advisory");
    }
  });

  it("classifies verifiable defects as defect", () => {
    for (const description of [
      "测试用例 TC-N-010 引用了不存在的功能 ID 'F003'",
      "多个类的方法显示为 '[object Object]' 而不是具体的方法签名",
      "功能 F005 映射错误，设计将其映射为'日志与审计'模块",
      "引用了未定义的需求 ID C999",
      "class_diagram 缺少正确的 Mermaid 头部",
    ]) {
      const issue = createIssue({ severity: "major", description });
      expect(EvaluationTool._classifyIssueKind(issue)).toBe("defect");
    }
  });

  it("treats any blocker as a defect regardless of wording", () => {
    const issue = createIssue({ severity: "blocker", description: "系统设计文档为空" });
    expect(EvaluationTool._classifyIssueKind(issue)).toBe("defect");
  });

  it("promotes an LLM advisory to defect when a rule-check flagged the same field", () => {
    const llmIssue = createIssue({
      severity: "major",
      targetTaskId: "design-1",
      targetField: "design_text",
      description: "设计的支付流程描述不清晰", // no defect signature on its own
    });
    // No corroboration → advisory.
    expect(EvaluationTool._classifyLlmIssueKind(llmIssue, new Set())).toBe("advisory");
    // A rule-check defect on the same field corroborates it → defect.
    expect(
      EvaluationTool._classifyLlmIssueKind(llmIssue, new Set(["design-1::design_text"])),
    ).toBe("defect");
  });
});

