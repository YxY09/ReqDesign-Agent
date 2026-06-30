import { describe, it, expect } from "vitest";
import { SystemDesigner } from "../src/generators/design.js";

/**
 * Regression (FIX 2): data-flow steps emitted as objects by the LLM must be
 * serialized to a readable string. Previously `_coerceDataFlow` did
 * `String(p)`, producing the literal `[object Object]` in the rendered design
 * text (seen as `1. [object Object]` in S12-dm4 system_design.md).
 *
 * `parseDesignModel` is the public entry that runs `_coerceDataFlow`, so we
 * feed it a raw payload whose steps are objects and assert the coerced steps
 * are readable strings with no `[object Object]`.
 */
describe("SystemDesigner._coerceDataFlow (via parseDesignModel) — FIX 2", () => {
  it("serializes object-valued steps to readable strings", () => {
    const raw = {
      modules: [{ id: "M1", name: "Core", responsibility: "r", functionIds: ["F001"] }],
      classes: [{ name: "Foo", kind: "domain", responsibility: "r" }],
      dataFlows: [
        {
          name: "审批流程",
          steps: [
            { description: "提交申请 → 主管审核" },
            { step: "归档记录" },
            { name: "通知申请人" },
            "纯文本步骤",
          ],
        },
      ],
      coverageMatrix: [],
    };

    const model = SystemDesigner.parseDesignModel(raw);
    expect(model).not.toBeNull();
    const flow = model!.dataFlows[0];
    expect(flow.steps).toEqual([
      "提交申请 → 主管审核",
      "归档记录",
      "通知申请人",
      "纯文本步骤",
    ]);
    // No step may render as [object Object].
    for (const step of flow.steps) {
      expect(step).not.toContain("[object Object]");
    }
  });

  it("renders object-valued steps without [object Object] in markdown", () => {
    const raw = {
      modules: [{ id: "M1", name: "Core", responsibility: "r", functionIds: ["F001"] }],
      classes: [{ name: "Foo", kind: "domain", responsibility: "r" }],
      dataFlows: [
        {
          name: "结算流程",
          steps: [
            { description: "计算金额" },
            { action: "扣减余额" },
          ],
        },
      ],
      coverageMatrix: [],
    };

    const model = SystemDesigner.parseDesignModel(raw)!;
    const md = SystemDesigner.renderDesignMarkdown(model);
    expect(md).toContain("计算金额");
    expect(md).toContain("扣减余额");
    expect(md).not.toContain("[object Object]");
  });

  it("renders plain-string steps unchanged", () => {
    const raw = {
      modules: [{ id: "M1", name: "Core", responsibility: "r", functionIds: ["F001"] }],
      classes: [{ name: "Foo", kind: "domain", responsibility: "r" }],
      dataFlows: [
        { name: "登录流程", steps: ["输入凭证", "校验", "颁发令牌"] },
      ],
      coverageMatrix: [],
    };

    const model = SystemDesigner.parseDesignModel(raw)!;
    const md = SystemDesigner.renderDesignMarkdown(model);
    expect(md).toContain("输入凭证");
    expect(md).toContain("颁发令牌");
    expect(md).not.toContain("[object Object]");
  });
});
