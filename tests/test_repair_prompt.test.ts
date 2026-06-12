import { describe, it, expect, vi } from "vitest";
import { RepairTool } from "../src/tools/repair.js";
import { createTask } from "../src/shared/types.js";

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

  it("falls back to full content for JSON-format test cases when patches don't apply", async () => {
    // BUG-3: JSON-format test cases like {"test_cases": [...]} have no markdown headings,
    // so parseSections returns [{key: "full", content: ...}]. LLM patches target test case
    // IDs (e.g., "TC-B-001") which don't match "full" → patches silently dropped.
    // Fix: when patches don't apply and content is JSON, fall back to full content.
    const originalJson = JSON.stringify({
      test_cases: [
        { id: "TC-B-001", name: "Boundary test 1", target: "C001", steps: ["构造边界数据", "执行校验"], expected_result: "系统在边界处正确执行校验" },
        { id: "TC-B-002", name: "Boundary test 2", target: "C002", steps: ["构造边界数据2", "执行校验2"], expected_result: "系统在边界处正确执行校验2" },
      ],
    }, null, 2);

    const fixedJson = JSON.stringify({
      test_cases: [
        { id: "TC-B-001", name: "Fixed boundary test 1", target: "C001", steps: ["构造修复后边界数据", "执行修复后校验"], expected_result: "修复后预期结果" },
        { id: "TC-B-002", name: "Boundary test 2", target: "C002", steps: ["构造边界数据2", "执行校验2"], expected_result: "系统在边界处正确执行校验2" },
      ],
    }, null, 2);

    // LLM returns patches targeting TC-B-001 (won't match "full" section) AND full content
    const llm = designRepairLlm(JSON.stringify({
      patches: [
        { op: "replace_section", section: "TC-B-001", content: "## TC-B-001\n\nfixed" },
      ],
      content: fixedJson,
    }));

    const agent = new RepairTool(llm);
    const task = createTask({
      id: "tests-json-1",
      type: "tests",
      description: "repair JSON test cases",
    });

    const result = await agent.repair(
      task,
      originalJson,
      [
        {
          severity: "major",
          target_field: "test_cases",
          description: "TC-B-001 步骤不完整",
          suggestion: "修复 TC-B-001",
        },
      ],
      {},
    );

    // The fix should cause the full content fallback to be used
    expect(result).not.toBeNull();
    expect(result).not.toBe(originalJson); // Should NOT be the unchanged original
    expect(String(result)).toContain("Fixed boundary test 1"); // Should contain the fix
  });

  it("_stripCodeFences strips markdown code fences", () => {
    expect(RepairTool._stripCodeFences('```json\n{"key": "value"}\n```')).toBe('{"key": "value"}');
    expect(RepairTool._stripCodeFences('```\nhello\n```')).toBe('hello');
    expect(RepairTool._stripCodeFences('  ```\nhello\n```  ')).toBe('hello');
    expect(RepairTool._stripCodeFences('{"no": "fence"}')).toBe('{"no": "fence"}');
    expect(RepairTool._stripCodeFences('plain text')).toBe('plain text');
    // Malformed fence: no closing fence
    expect(RepairTool._stripCodeFences('```\nno closing')).toBe('```\nno closing');
  });

  it("patches fallback handles fenced JSON content", async () => {
    // The currentContent is wrapped in code fences — the patches fallback
    // should still detect it as JSON and apply the full content fallback.
    const originalJson = JSON.stringify({ test_cases: [{ id: "TC-1", name: "test", target: "F001", steps: ["输入测试数据", "验证输出"], expected_result: "输出结果正确且完整" }] }, null, 2);
    const fencedJson = "```json\n" + originalJson + "\n```";
    const fixedJson = JSON.stringify({ test_cases: [{ id: "TC-1", name: "fixed", target: "F001", steps: ["输入修复数据", "验证修复输出"], expected_result: "修复后输出完整正确" }] }, null, 2);

    const llm = designRepairLlm(JSON.stringify({
      patches: [{ op: "replace_section", section: "TC-1", content: "## TC-1\nfixed" }],
      content: fixedJson,
    }));

    const agent = new RepairTool(llm);
    const task = createTask({ id: "tests-fenced", type: "tests", description: "repair fenced JSON" });

    const result = await agent.repair(task, fencedJson, [
      { severity: "major", target_field: "test_cases", description: "fix", suggestion: "fix" },
    ], {});

    expect(result).not.toBeNull();
    expect(String(result)).toContain("fixed");
    expect(String(result)).not.toBe(fencedJson);
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
