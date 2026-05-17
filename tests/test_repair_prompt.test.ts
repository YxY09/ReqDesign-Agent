import { describe, it, expect, vi } from "vitest";
import { RepairAgent } from "../src/agents/repair.js";
import { createTask } from "../src/agents/types.js";

function designRepairLlm() {
  return {
    generateText: vi.fn().mockResolvedValue("fixed design"),
    generateJson: vi.fn(),
  } as any;
}

describe("RepairAgent prompt building", () => {
  it("adds a holistic closure hint for design repairs", async () => {
    const llm = designRepairLlm();
    const agent = new RepairAgent(llm);
    const task = createTask({
      id: "design-1",
      type: "design",
      description: "repair system design",
    });

    await agent.repair(
      task,
      "## 系统设计\n\n核心类缺失",
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
    expect(userPrompt).toContain("设计修复模式");
    expect(userPrompt).toContain("全局闭环");
    expect(userPrompt).toContain("当前设计全量校验结果");
  });
});
