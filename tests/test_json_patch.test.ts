import { describe, it, expect, vi } from "vitest";
import { ArtifactPatcher } from "../src/tools/artifactPatcher.js";
import { RepairTool } from "../src/tools/repair.js";
import { createTask } from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// applyJsonOps — unit tests on ArtifactPatcher
// ---------------------------------------------------------------------------

describe("ArtifactPatcher.applyJsonOps", () => {
  const baseJson = JSON.stringify(
    {
      test_cases: [
        { id: "TC-001", name: "Login", steps: "step1", expected: "ok" },
        { id: "TC-002", name: "Logout", steps: "step2", expected: "ok" },
      ],
    },
    null,
    2,
  );

  it("appends items to an array path", () => {
    const result = ArtifactPatcher.applyJsonOps(baseJson, [
      {
        action: "append",
        path: "test_cases",
        items: [{ id: "TC-003", name: "Register", steps: "step3", expected: "ok" }],
      },
    ]);
    const parsed = JSON.parse(result);
    expect(parsed.test_cases).toHaveLength(3);
    expect(parsed.test_cases[2].id).toBe("TC-003");
  });

  it("replaces an item by match field", () => {
    const result = ArtifactPatcher.applyJsonOps(baseJson, [
      {
        action: "replace",
        path: "test_cases",
        match: { field: "id", value: "TC-001" },
        value: { id: "TC-001", name: "Login V2", steps: "step1v2", expected: "ok2" },
      },
    ]);
    const parsed = JSON.parse(result);
    expect(parsed.test_cases).toHaveLength(2);
    expect(parsed.test_cases[0].name).toBe("Login V2");
    expect(parsed.test_cases[1].name).toBe("Logout"); // unchanged
  });

  it("deletes an item by match field", () => {
    const result = ArtifactPatcher.applyJsonOps(baseJson, [
      {
        action: "delete",
        path: "test_cases",
        match: { field: "id", value: "TC-002" },
      },
    ]);
    const parsed = JSON.parse(result);
    expect(parsed.test_cases).toHaveLength(1);
    expect(parsed.test_cases[0].id).toBe("TC-001");
  });

  it("skips op when path is not an array", () => {
    const json = JSON.stringify({ test_cases: [1, 2], metadata: "hello" });
    const result = ArtifactPatcher.applyJsonOps(json, [
      { action: "append", path: "metadata", items: [3] } as any,
    ]);
    const parsed = JSON.parse(result);
    expect(parsed.metadata).toBe("hello"); // unchanged
    expect(parsed.test_cases).toHaveLength(2);
  });

  it("skips replace when match not found", () => {
    const result = ArtifactPatcher.applyJsonOps(baseJson, [
      {
        action: "replace",
        path: "test_cases",
        match: { field: "id", value: "TC-999" },
        value: { id: "TC-999", name: "Ghost" },
      },
    ]);
    const parsed = JSON.parse(result);
    expect(parsed.test_cases).toHaveLength(2);
    expect(parsed.test_cases[0].name).toBe("Login");
  });

  it("applies multiple ops in sequence", () => {
    const result = ArtifactPatcher.applyJsonOps(baseJson, [
      {
        action: "replace",
        path: "test_cases",
        match: { field: "id", value: "TC-001" },
        value: { id: "TC-001", name: "Login Fixed", steps: "step1f", expected: "ok" },
      },
      {
        action: "append",
        path: "test_cases",
        items: [{ id: "TC-003", name: "New", steps: "s3", expected: "ok" }],
      },
    ]);
    const parsed = JSON.parse(result);
    expect(parsed.test_cases).toHaveLength(3);
    expect(parsed.test_cases[0].name).toBe("Login Fixed");
    expect(parsed.test_cases[2].id).toBe("TC-003");
  });

  it("returns pretty-printed JSON", () => {
    const result = ArtifactPatcher.applyJsonOps(baseJson, []);
    // Pretty-printed JSON should have newlines and indentation
    expect(result).toContain("\n");
    expect(result).toContain("  ");
  });
});

// ---------------------------------------------------------------------------
// _applyPatchResponse routing — ops and full_replace
// ---------------------------------------------------------------------------

function makeLlm(text: string) {
  return {
    generateText: vi.fn().mockResolvedValue(text),
    generateJson: vi.fn(),
  } as any;
}

describe("RepairTool._applyPatchResponse routing", () => {
  it("routes ops to applyJsonOps for object currentContent (tests task)", async () => {
    // For tests tasks, currentContent can be a parsed JSON object,
    // not a string. The ops branch must still be routed in that case.
    const originalObj = {
      test_cases: [
        { id: "TC-001", name: "Login", steps: ["输入用户名和密码", "点击登录按钮"], expected_result: "登录成功并跳转到首页" },
      ],
    };

    // LLM returns ops format
    const llm = makeLlm(
      JSON.stringify({
        ops: [
          {
            action: "replace",
            path: "test_cases",
            match: { field: "id", value: "TC-001" },
            value: { id: "TC-001", name: "Login Fixed", steps: ["输入用户名和密码", "点击登录按钮"], expected_result: "登录成功并跳转到首页" },
          },
        ],
      }),
    );

    const agent = new RepairTool(llm);
    const task = createTask({
      id: "tests-1",
      type: "tests",
      description: "repair tests",
    });

    const result = await agent.repair(task, originalObj as unknown as string, [
      { severity: "major", description: "TC-001 broken", suggestion: "fix" },
    ], {});

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result as string);
    expect(parsed.test_cases[0].name).toBe("Login Fixed");
  });

  it("routes ops to applyJsonOps for JSON content", async () => {
    const originalJson = JSON.stringify(
      {
        test_cases: [
          { id: "TC-001", name: "Login", steps: ["输入用户名和密码", "点击登录按钮"], expected_result: "登录成功并跳转到首页" },
        ],
      },
      null,
      2,
    );

    // LLM returns ops format
    const llm = makeLlm(
      JSON.stringify({
        ops: [
          {
            action: "replace",
            path: "test_cases",
            match: { field: "id", value: "TC-001" },
            value: { id: "TC-001", name: "Login Fixed", steps: ["输入用户名和密码", "点击登录按钮"], expected_result: "登录成功并跳转到首页" },
          },
        ],
      }),
    );

    const agent = new RepairTool(llm);
    const task = createTask({
      id: "tests-1",
      type: "tests",
      description: "repair tests",
    });

    const result = await agent.repair(task, originalJson, [
      { severity: "major", description: "TC-001 broken", suggestion: "fix" },
    ], {});

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result as string);
    expect(parsed.test_cases[0].name).toBe("Login Fixed");
  });

  it("normalizes invalid structured test IDs after ops repair", async () => {
    const originalJson = JSON.stringify(
      {
        test_cases: [
          {
            id: "TC-N-001",
            title: "已有正常测试",
            type: "正常",
            target: "F010",
            preconditions: "ready",
            steps: ["准备测试环境", "执行正常操作"],
            expected_result: "操作成功完成",
            priority: "P1",
          },
        ],
      },
      null,
      2,
    );

    const llm = makeLlm(
      JSON.stringify({
        ops: [
          {
            action: "append",
            path: "test_cases",
            items: [
              {
                id: "TC-F010-001",
                title: "帮助功能正常测试",
                type: "正常",
                target: "F010",
                preconditions: "ready",
                steps: ["导航到帮助页面", "查看帮助内容"],
                expected_result: "帮助内容正确显示",
                priority: "P1",
              },
              {
                id: "TC-X002-001",
                title: "权限异常测试",
                type: "异常",
                target: "X002",
                preconditions: "denied",
                steps: ["以无权限用户登录", "访问受限资源"],
                expected_result: "系统拒绝访问并提示权限不足",
                priority: "P0",
              },
              {
                id: "TC-CON-001",
                title: "审计约束测试",
                type: "边界",
                target: "C001",
                preconditions: "audit enabled",
                steps: ["获取审计日志记录", "尝试篡改审计日志内容"],
                expected_result: "系统阻止篡改并记录安全事件",
                priority: "P0",
              },
            ],
          },
        ],
      }),
    );

    const agent = new RepairTool(llm);
    const task = createTask({ id: "tests-1", type: "tests", description: "repair tests" });

    const result = await agent.repair(task, originalJson, [
      { severity: "major", description: "missing coverage", suggestion: "add tests" },
    ], {
      requirement_json: {
        functions: [{ id: "F010", name: "Help" }],
        exceptions: [{ id: "X002", description: "Denied" }],
        constraints: [{ id: "C001", description: "Audit cannot be altered" }],
      },
    });

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result as string);
    // First appended test (target F010, type "正常") gets converted from
    // append→replace because existing TC-N-001 also targets F010.
    // Result: 3 tests (original replaced + 2 new appended).
    expect(parsed.test_cases.map((tc: Record<string, unknown>) => tc.id)).toEqual([
      "TC-N-001",
      "TC-E-001",
      "TC-B-001",
    ]);
  });

  it("routes full_replace for markdown content", async () => {
    const originalMd = "## Design\n\nOld content\n\n## Modules\n\nModule A";

    const llm = makeLlm(
      JSON.stringify({
        action: "full_replace",
        content: "## Design\n\nNew content\n\n## Modules\n\nModule A",
      }),
    );

    const agent = new RepairTool(llm);
    const task = createTask({
      id: "design-1",
      type: "design",
      description: "repair design",
    });

    const result = await agent.repair(task, originalMd, [
      { severity: "major", description: "Design content wrong", suggestion: "fix" },
    ], {});

    expect(result).not.toBeNull();
    expect(result).toContain("New content");
    expect(result).toContain("Module A");
  });

  it("falls back to section-based patches when no ops or full_replace", async () => {
    // Existing behavior: LLM returns patches array, content is markdown
    const llm = makeLlm(
      JSON.stringify({
        patches: [
          {
            op: "replace_section",
            section: "Design",
            content: "## Design\n\nFixed content",
          },
        ],
      }),
    );

    const agent = new RepairTool(llm);
    const task = createTask({
      id: "design-1",
      type: "design",
      description: "repair design",
    });

    const result = await agent.repair(
      task,
      "## Design\n\nOld content\n\n## Modules\n\nModule A",
      [{ severity: "major", description: "Design broken", suggestion: "fix" }],
      {},
    );

    expect(result).not.toBeNull();
    expect(result).toContain("Fixed content");
    expect(result).toContain("Module A");
  });
});

// ---------------------------------------------------------------------------
// False-success log gating
// ---------------------------------------------------------------------------

describe("RepairTool false-success log", () => {
  it("does not log success when patches had no effect", async () => {
    const logs: string[] = [];
    const llm = makeLlm(
      JSON.stringify({
        patches: [
          { op: "replace_section", section: "nonexistent", content: "won't apply" },
        ],
      }),
    );

    // Override logger to capture messages
    const agent = new RepairTool(llm);
    const origInfo = agent.logger.info.bind(agent.logger);
    agent.logger.info = (msg: string) => {
      logs.push(msg);
      origInfo(msg);
    };

    const task = createTask({
      id: "design-1",
      type: "design",
      description: "repair design",
    });

    await agent.repair(
      task,
      "## Section A\n\nContent A",
      [{ severity: "major", description: "issue", suggestion: "fix" }],
      {},
    );

    // The old false-success log "成功应用 X 个patches" should NOT appear
    // when patches had no effect
    const falseSuccess = logs.find(
      (l) => l.includes("成功应用") && l.includes("1 个patches"),
    );
    expect(falseSuccess).toBeUndefined();
  });
});
