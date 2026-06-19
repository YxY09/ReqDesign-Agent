import { describe, it, expect, vi } from "vitest";
import { RepairTool } from "../src/tools/repair.js";
import { createTask, isDesignModel } from "../src/shared/types.js";

function textRepairLlm(returnText: string) {
  return {
    generateText: vi.fn().mockResolvedValue(returnText),
    generateJson: vi.fn(),
  } as any;
}

function jsonRepairLlm(response: Record<string, unknown>) {
  return {
    generateText: vi.fn(),
    generateJson: vi.fn().mockResolvedValue(response),
  } as any;
}

describe("RepairTool prompt building", () => {
  it("asks design repairs for a complete DesignModel without old protocol terms", async () => {
    const llm = jsonRepairLlm(baseDesignModel());
    const agent = new RepairTool(llm);
    const task = createTask({
      id: "design-1",
      type: "design",
      description: "repair system design",
    });

    await agent.repair(
      task,
      baseDesignModel(),
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

    expect(llm.generateJson).toHaveBeenCalled();
    expect(llm.generateText).not.toHaveBeenCalled();
    const userPrompt = llm.generateJson.mock.calls[0][0] as string;
    expect(userPrompt).toContain("完整 DesignModel JSON");
    expect(userPrompt).not.toContain("ops");
    expect(userPrompt).not.toContain("patches");
    expect(userPrompt).not.toContain("full_replace");
    expect(userPrompt).not.toContain("产物章节列表");
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

    expect(llm.generateJson).toHaveBeenCalled();
    expect(llm.generateText).not.toHaveBeenCalled();
  });

  it("parses complete DesignModel JSON response correctly", async () => {
    const llm = jsonRepairLlm(baseDesignModel({
      constraintImplementations: [
        {
          constraintId: "C001",
          sourceTextVerbatim: "库存不足时不可下单",
          implementationMechanism: "OrderService 调用 InventoryService 校验库存不足时不可下单",
          parametersPreserved: [],
          trigger: "提交订单时",
          handling: "库存不足则拒绝下单",
          affectedModuleIds: ["MOD_ORDER"],
          affectedClassNames: ["OrderService"],
        },
      ],
    }));
    const agent = new RepairTool(llm);
    const task = createTask({
      id: "design-1",
      type: "design",
      description: "repair system design",
    });

    const result = await agent.repair(
      task,
      baseDesignModel(),
      [
        {
          severity: "major",
          target_field: "design_text",
          description: "缺少 C001",
          suggestion: "补充 C001",
        },
      ],
      {
        requirement_json: {
          functions: [{ id: "F001", name: "CreateOrder" }],
          constraints: [{ id: "C001", source_text: "库存不足时不可下单" }],
        },
      },
    );

    expect(isDesignModel(result)).toBe(true);
    expect(JSON.stringify(result)).toContain("constraintImplementations");
  });

  it("accepts complete JSON content for structured test cases", async () => {
    const originalJson = JSON.stringify({
      test_cases: [
        { id: "TC-B-001", name: "Boundary test 1", target: "C001", steps: ["构造边界数据", "执行校验"], expected_result: "系统在边界处正确执行校验" },
      ],
    }, null, 2);

    const fixedJson = JSON.stringify({
      test_cases: [
        { id: "TC-B-001", name: "Fixed boundary test 1", target: "C001", steps: ["构造修复后边界数据", "执行修复后校验"], expected_result: "修复后预期结果" },
      ],
    }, null, 2);

    const llm = textRepairLlm(fixedJson);
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

    expect(result).not.toBeNull();
    expect(result).not.toBe(originalJson);
    expect(String(result)).toContain("Fixed boundary test 1");
  });

  it("_stripCodeFences strips markdown code fences", () => {
    expect(RepairTool._stripCodeFences('```json\n{"key": "value"}\n```')).toBe('{"key": "value"}');
    expect(RepairTool._stripCodeFences('```\nhello\n```')).toBe("hello");
    expect(RepairTool._stripCodeFences("  ```\nhello\n```  ")).toBe("hello");
    expect(RepairTool._stripCodeFences('{"no": "fence"}')).toBe('{"no": "fence"}');
    expect(RepairTool._stripCodeFences("plain text")).toBe("plain text");
    expect(RepairTool._stripCodeFences("```\nno closing")).toBe("```\nno closing");
  });

  it("handles fenced full JSON content", async () => {
    const originalJson = JSON.stringify({ test_cases: [{ id: "TC-N-001", name: "test", target: "F001", steps: ["输入测试数据", "验证输出"], expected_result: "输出结果正确且完整" }] }, null, 2);
    const fencedJson = "```json\n" + originalJson + "\n```";
    const fixedJson = JSON.stringify({ test_cases: [{ id: "TC-N-001", name: "fixed", target: "F001", steps: ["输入修复数据", "验证修复输出"], expected_result: "修复后输出完整正确" }] }, null, 2);

    const llm = textRepairLlm("```json\n" + fixedJson + "\n```");
    const agent = new RepairTool(llm);
    const task = createTask({ id: "tests-fenced", type: "tests", description: "repair fenced JSON" });

    const result = await agent.repair(task, fencedJson, [
      { severity: "major", target_field: "test_cases", description: "fix", suggestion: "fix" },
    ], {});

    expect(result).not.toBeNull();
    expect(String(result)).toContain("fixed");
    expect(String(result)).not.toBe(fencedJson);
  });

  it("accepts plain text for Markdown test case repairs", async () => {
    const llm = textRepairLlm("## TC-N-001\n\nfixed test body");
    const agent = new RepairTool(llm);
    const task = createTask({
      id: "tests-1",
      type: "tests",
      description: "repair tests",
    });

    const result = await agent.repair(
      task,
      "## TC-N-001\n\ntest body old",
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

    expect(result).toBe("## TC-N-001\n\nfixed test body");
  });
});

function baseDesignModel(overrides: Record<string, unknown> = {}) {
  return {
    constraintImplementations: [],
    exceptionImplementations: [],
    modules: [{ id: "MOD_ORDER", name: "订单模块", responsibility: "订单处理", functionIds: ["F001"] }],
    classes: [{ name: "OrderService", kind: "helper", responsibility: "订单服务" }],
    dataFlows: [{ name: "下单流程", steps: ["OrderService"], relatedFunctionIds: ["F001"] }],
    coverageMatrix: [],
    supplementaryClasses: [],
    ...overrides,
  };
}
