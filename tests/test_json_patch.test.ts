import { describe, it, expect, vi } from "vitest";
import { RepairTool } from "../src/tools/repair.js";
import { createTask, isDesignModel } from "../src/shared/types.js";

function makeTextLlm(text: string) {
  return {
    generateText: vi.fn().mockResolvedValue(text),
    generateJson: vi.fn(),
  } as any;
}

function makeJsonLlm(response: Record<string, unknown>) {
  return {
    generateText: vi.fn(),
    generateJson: vi.fn().mockResolvedValue(response),
  } as any;
}

describe("RepairTool full-artifact repair routing", () => {
  it("accepts complete JSON repair for object test content", async () => {
    const llm = makeTextLlm(JSON.stringify({
      test_cases: [
        { id: "TC-N-001", title: "Login Fixed", type: "正常", target: "F001", steps: ["输入用户名和密码", "点击登录按钮"], expected_result: "登录成功并跳转到首页", priority: "P1" },
      ],
    }));
    const agent = new RepairTool(llm);
    const task = createTask({ id: "tests-1", type: "tests", description: "repair tests" });

    const result = await agent.repair(
      task,
      { test_cases: [{ id: "TC-N-001", title: "Login", target: "F001" }] },
      [{ severity: "major", description: "TC-N-001 broken", suggestion: "fix" }],
      {},
    );

    expect(result).not.toBeNull();
    expect(JSON.parse(result as string).test_cases[0].title).toBe("Login Fixed");
  });

  it("rejects ops patch protocol for test repair", async () => {
    const llm = makeTextLlm(JSON.stringify({
      ops: [
        {
          action: "replace",
          path: "test_cases",
          match: { field: "id", value: "TC-N-001" },
          value: { id: "TC-N-001", target: "F001" },
        },
      ],
    }));
    const agent = new RepairTool(llm);
    const task = createTask({ id: "tests-1", type: "tests", description: "repair tests" });

    const result = await agent.repair(
      task,
      JSON.stringify({ test_cases: [{ id: "TC-N-001", target: "F001" }] }),
      [{ severity: "major", description: "TC-N-001 broken", suggestion: "fix" }],
      {},
    );

    expect(result).toBeNull();
  });

  it("normalizes invalid structured test IDs after full JSON repair", async () => {
    const llm = makeTextLlm(JSON.stringify({
      test_cases: [
        { id: "TC-F010-001", title: "帮助功能正常测试", type: "正常", target: "F010", preconditions: "ready", steps: ["导航到帮助页面", "查看帮助内容"], expected_result: "帮助内容正确显示", priority: "P1" },
        { id: "TC-X002-001", title: "权限异常测试", type: "异常", target: "X002", preconditions: "denied", steps: ["以无权限用户登录", "访问受限资源"], expected_result: "系统拒绝访问并提示权限不足", priority: "P0" },
        { id: "TC-CON-001", title: "审计约束测试", type: "边界", target: "C001", preconditions: "audit enabled", steps: ["获取审计日志记录", "尝试篡改审计日志内容"], expected_result: "系统阻止篡改并记录安全事件", priority: "P0" },
      ],
    }));
    const agent = new RepairTool(llm);
    const task = createTask({ id: "tests-1", type: "tests", description: "repair tests" });

    const result = await agent.repair(
      task,
      JSON.stringify({ test_cases: [] }),
      [{ severity: "major", description: "missing coverage", suggestion: "add tests" }],
      {
        requirement_json: {
          functions: [{ id: "F010", name: "Help" }],
          exceptions: [{ id: "X002", description: "Denied" }],
          constraints: [{ id: "C001", description: "Audit cannot be altered" }],
        },
      },
    );

    expect(result).not.toBeNull();
    expect(JSON.parse(result as string).test_cases.map((tc: Record<string, unknown>) => tc.id)).toEqual([
      "TC-N-001",
      "TC-E-001",
      "TC-B-001",
    ]);
  });

  it("keeps existing tests when a full repair response omits unrelated cases", async () => {
    const llm = makeTextLlm(JSON.stringify({
      test_cases: [
        {
          id: "TC-B-001",
          title: "库存不足不可下单边界测试",
          type: "边界",
          target: "C001 库存不足时不可下单",
          preconditions: "商品SKU-1库存为0",
          steps: ["用户选择SKU-1并提交订单", "系统调用InventoryService校验库存"],
          expected_result: "订单创建失败并提示库存不足",
          priority: "P0",
        },
      ],
    }));
    const agent = new RepairTool(llm);
    const task = createTask({ id: "tests-1", type: "tests", description: "repair tests" });

    const result = await agent.repair(
      task,
      JSON.stringify({
        test_cases: [
          {
            id: "TC-N-001",
            title: "订单创建正常流程",
            type: "正常",
            target: "F001 创建订单",
            preconditions: "用户已登录且SKU-2库存为5件",
            steps: ["用户选择SKU-2数量1", "提交订单"],
            expected_result: "订单创建成功并锁定SKU-2库存",
            priority: "P0",
          },
          {
            id: "TC-B-001",
            title: "库存约束模板测试",
            type: "边界",
            target: "C001 库存不足时不可下单",
            preconditions: "库存不足",
            steps: ["检查是否满足约束", "返回结果"],
            expected_result: "符合预期",
            priority: "P1",
          },
        ],
      }),
      [{ severity: "major", description: "TC-B-001 too generic", suggestion: "rewrite TC-B-001" }],
      {
        requirement_json: {
          functions: [{ id: "F001", displayId: "F001", name: "创建订单" }],
          constraints: [{ id: "C001", displayId: "C001", source_text: "库存不足时不可下单" }],
          exceptions: [],
        },
      },
    );

    expect(result).not.toBeNull();
    const cases = JSON.parse(result as string).test_cases as Array<Record<string, unknown>>;
    expect(cases.map((tc) => tc.id)).toEqual(["TC-N-001", "TC-B-001"]);
    expect(cases[0].title).toBe("订单创建正常流程");
    expect(cases[1].title).toBe("库存不足不可下单边界测试");
  });

  it("keeps usable tests when a subset of repaired cases is still low quality", async () => {
    const llm = makeTextLlm(JSON.stringify({
      test_cases: [
        {
          id: "TC-N-001",
          title: "订单创建正常流程",
          type: "正常",
          target: "F001 创建订单",
          preconditions: "用户已登录且购物车包含商品SKU-1",
          steps: ["选择收货地址ADDR-1并提交订单", "系统校验库存并创建订单"],
          expected_result: "订单创建成功，返回订单号并锁定SKU-1库存",
          priority: "P1",
        },
        {
          id: "TC-B-001",
          title: "库存约束模板测试",
          type: "边界",
          target: "C001 库存不足时不可下单",
          preconditions: "库存不足",
          steps: ["检查是否满足约束"],
          expected_result: "符合预期",
          priority: "P1",
        },
      ],
    }));
    const agent = new RepairTool(llm);
    const task = createTask({ id: "tests-1", type: "tests", description: "repair tests" });

    const result = await agent.repair(
      task,
      JSON.stringify({ test_cases: [] }),
      [{ severity: "major", description: "fix low quality tests", suggestion: "rewrite tests" }],
      {
        requirement_json: {
          functions: [{ id: "F001", displayId: "F001", name: "创建订单" }],
          constraints: [{ id: "C001", displayId: "C001", source_text: "库存不足时不可下单" }],
          exceptions: [],
        },
      },
    );

    expect(result).not.toBeNull();
    const cases = JSON.parse(result as string).test_cases as Array<Record<string, unknown>>;
    expect(cases.map((tc) => tc.id)).toEqual(["TC-N-001"]);
  });

  it("rejects full_replace protocol for design repair", async () => {
    const llm = makeJsonLlm({
      action: "full_replace",
      content: "# 泛化系统设计\n\n## 模块划分\n\n只有泛化模块",
    });
    const agent = new RepairTool(llm);
    const task = createTask({ id: "design-1", type: "design", description: "repair design" });

    const result = await agent.repair(
      task,
      baseDesignModel(),
      [{ severity: "major", description: "设计缺少约束实现", suggestion: "补充约束实现" }],
      {},
    );

    expect(result).toBeNull();
    const prompt = llm.generateJson.mock.calls[0][0] as string;
    expect(prompt).toContain("完整 DesignModel JSON");
    expect(prompt).not.toContain("ops");
    expect(prompt).not.toContain("patches");
    expect(prompt).not.toContain("full_replace");
  });

  it("accepts complete DesignModel repair without degrading to markdown", async () => {
    const repairedModel = {
      ...baseDesignModel(),
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
    };

    const llm = makeJsonLlm(repairedModel);
    const agent = new RepairTool(llm);
    const task = createTask({ id: "design-1", type: "design", description: "repair design" });

    const result = await agent.repair(
      task,
      baseDesignModel(),
      [{ severity: "major", description: "设计缺少约束 C001", suggestion: "补充 C001" }],
      {
        requirement_json: {
          functions: [{ id: "FUN_CREATE_ORDER", displayId: "F001", name: "CreateOrder" }],
          constraints: [{ id: "CON_STOCK", displayId: "C001", description: "库存不足时不可下单", source_text: "库存不足时不可下单" }],
          exceptions: [],
          entities: [],
        },
      },
    );

    expect(isDesignModel(result)).toBe(true);
    expect(JSON.stringify(result)).toContain("constraintImplementations");
  });

  it("rejects section patches protocol", async () => {
    const llm = makeTextLlm(JSON.stringify({
      patches: [
        { op: "replace_section", section: "TC-N-001", content: "## TC-N-001\nfixed" },
      ],
    }));
    const agent = new RepairTool(llm);
    const task = createTask({ id: "tests-1", type: "tests", description: "repair tests" });

    const result = await agent.repair(
      task,
      JSON.stringify({ test_cases: [{ id: "TC-N-001", target: "F001" }] }),
      [{ severity: "major", description: "Test broken", suggestion: "fix" }],
      {},
    );

    expect(result).toBeNull();
  });

  it("accepts complete diagram JSON repair", async () => {
    const llm = makeTextLlm(JSON.stringify({
      class_diagram: "classDiagram\n    class OrderService {\n        +createOrder()\n    }",
    }));
    const agent = new RepairTool(llm);
    const task = createTask({
      id: "diagrams-class",
      type: "diagrams",
      description: "repair class diagram",
      contextHints: { diagram_kind: "class_diagram" },
    });

    const result = await agent.repair(
      task,
      { class_diagram: "classDiagram\n    class OrderService" },
      [{ severity: "major", description: "class diagram broken", suggestion: "fix" }],
      {},
    ) as Record<string, string> | null;

    expect(result).not.toBeNull();
    expect(result?.class_diagram).toContain("createOrder");
  });

  it("does not log success when patch protocol is rejected", async () => {
    const logs: string[] = [];
    const llm = makeTextLlm(JSON.stringify({
      patches: [{ op: "replace_section", section: "nonexistent", content: "won't apply" }],
    }));
    const agent = new RepairTool(llm);
    const origInfo = agent.logger.info.bind(agent.logger);
    agent.logger.info = (msg: string) => {
      logs.push(msg);
      origInfo(msg);
    };
    const task = createTask({ id: "tests-1", type: "tests", description: "repair tests" });

    await agent.repair(
      task,
      JSON.stringify({ test_cases: [{ id: "TC-N-001", target: "F001" }] }),
      [{ severity: "major", description: "issue", suggestion: "fix" }],
      {},
    );

    expect(logs.find((line) => line.includes("修复成功"))).toBeUndefined();
  });
});

function baseDesignModel() {
  return {
    constraintImplementations: [],
    exceptionImplementations: [],
    modules: [{ id: "MOD_ORDER", name: "订单模块", responsibility: "订单处理", functionIds: ["F001"] }],
    classes: [{ name: "OrderService", kind: "helper", responsibility: "订单服务" }],
    dataFlows: [{ name: "下单流程", steps: ["OrderService"], relatedFunctionIds: ["F001"] }],
    coverageMatrix: [],
    supplementaryClasses: [],
  };
}
