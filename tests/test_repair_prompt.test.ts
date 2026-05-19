import { describe, it, expect, vi } from "vitest";
import { RepairTool } from "../src/tools/repair.js";
import { createTask } from "../src/agent/types.js";

function designRepairLlm(returnText: string = '{"patches":[{"op":"replace_section","section":"系统设计","content":"## 系统设计\n\nfixed content"}]}') {
  return {
    generateText: vi.fn().mockResolvedValue(returnText),
    generateJson: vi.fn(),
  } as any;
}

describe("RepairTool prompt building", () => {
  it("includes section listing for patch-mode design repairs", async () => {
    const llm = designRepairLlm();
    const agent = new RepairTool(llm);
    const task = createTask({
      id: "design-1",
      type: "design",
      description: "repair system design",
    });

    await agent.repair(
      task,
      "## 系统设计\n\n核心类缺失\n\n## 模块划分\n\nModule A",
      [
        {
          severity: "major",
          target_field: "design_text",
          description: "实体缺失",
          suggestion: "补齐缺失实体",
        },
      ],
      {
        requirement_json: {
          entities: [
            { name: "User", description: "user" },
            { name: "Order", description: "order" },
          ],
          functions: [
            { id: "F001", name: "CreateOrder" },
          ],
        },
      },
    );

    expect(llm.generateText).toHaveBeenCalled();
    const userPrompt = llm.generateText.mock.calls[0][0] as string;
    // Patch mode: should include section listing
    expect(userPrompt).toContain("产物章节列表");
    // Should NOT include old full-rewrite instructions
    expect(userPrompt).not.toContain("设计修复模式");
    expect(userPrompt).not.toContain("全局闭环");
  });

  it("uses full rewrite for analyze tasks", async () => {
    const llm = {
      generateText: vi.fn(),
      generateJson: vi.fn().mockResolvedValue({
        content: { actors: [], functions: [], entities: [] },
      }),
    } as any;

    const agent = new RepairTool(llm);
    const task = createTask({
      id: "analyze-1",
      type: "analyze",
      description: "repair analysis",
    });

    await agent.repair(
      task,
      { actors: [], functions: [], entities: [] },
      [
        {
          severity: "major",
          target_field: "actors",
          description: "缺少 actors",
          suggestion: "补充 actors",
        },
      ],
      { requirement_text: "some requirement" },
    );

    // analyze uses generateJson, not generateText
    expect(llm.generateJson).toHaveBeenCalled();
    expect(llm.generateText).not.toHaveBeenCalled();
  });

  it("parses patch JSON response correctly", async () => {
    const llm = designRepairLlm();
    const agent = new RepairTool(llm);
    const task = createTask({
      id: "design-1",
      type: "design",
      description: "repair system design",
    });

    const result = await agent.repair(
      task,
      "## 系统设计\n\nold content\n\n## 模块划分\n\nModule A",
      [
        {
          severity: "major",
          target_field: "design_text",
          description: "内容错误",
          suggestion: "修复",
        },
      ],
      {},
    );

    expect(result).not.toBeNull();
    const resultStr = String(result);
    expect(resultStr).toContain("fixed content");
  });

  it("falls back to full content on non-JSON LLM response", async () => {
    const llm = designRepairLlm("This is not JSON, just plain text output");
    const agent = new RepairTool(llm);
    const task = createTask({
      id: "tests-1",
      type: "tests",
      description: "repair tests",
    });

    const result = await agent.repair(
      task,
      "## TC-001\n\ntest body old",
      [
        {
          severity: "major",
          target_field: "test_cases",
          description: "测试不完整",
          suggestion: "补充测试",
        },
      ],
      {},
    );

    // Should fallback to wrapping the raw text
    expect(result).toBe("This is not JSON, just plain text output");
  });
});
