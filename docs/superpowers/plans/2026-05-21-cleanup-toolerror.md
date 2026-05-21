# 死代码清理 + ToolError/ToolCapabilities 接入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1) 清理 3 处死代码（streamLlm、copy-assets 死路径） 2) 实现 ToolError + ToolCapabilities 类型体系并接入所有 Tool 子类。

**Architecture:** 
- ToolError 替代裸 `new Error()`，提供 `createToolError(code, message, recoverable)` 工厂函数
- ToolCapabilities 声明每个 Tool 的能力（需不需要 LLM、支持哪些 task type）
- BaseTool 增加 `abstract get capabilities(): ToolCapabilities`，各子类实现
- `streamLlm` + 其专属 `LLMClient` interface 从 streaming.ts 移除

**Tech Stack:** TypeScript, Vitest

---

## Task 1: 删除 streaming.ts 中的 streamLlm 死代码

**Files:**
- Modify: `src/streaming.ts`

**风险：低。** `streamLlm` 已确认零调用，`LLMClient` interface 也零引用。`makeStreamPrinter` 保留不动。

- [ ] **Step 1: 删除 streamLlm 函数和 LLMClient interface**

删除行 92-105（`streamLlm` 函数体）和行 29-37（`LLMClient` interface）。`makeStreamPrinter` 和 `StreamPrinter` type 保留。

- [ ] **Step 2: 删除 import 中的 `LLMClient` 引用（如果有）**

检查文件顶部 — `LLMClient` interface 是本地定义的，不需要改 import。

- [ ] **Step 3: 运行测试**

Run: `npx vitest run`
Expected: ALL PASS（687 tests），streaming.ts 没有直接的单元测试文件

- [ ] **Step 4: Commit**

```bash
git add src/streaming.ts
git commit -m "chore: remove dead streamLlm() and unused LLMClient interface from streaming.ts"
```

---

## Task 2: 删除 copy-assets.mjs 死路径

**Files:**
- Modify: `scripts/copy-assets.mjs`

- [ ] **Step 1: 删除第二行 copy entry**

```javascript
// 删除这一行：
{ from: join(root, "src", "agents", "prompts"), to: join(root, "dist", "agents", "prompts") },
```

保留第一行（`prompts → dist/prompts`）和 for 循环逻辑不变。

- [ ] **Step 2: Commit**

```bash
git add scripts/copy-assets.mjs
git commit -m "chore: remove dead copy path in copy-assets.mjs (src/agents/prompts/ no longer exists)"
```

---

## Task 3: 完善 tools/types.ts — 添加 createToolError 工厂函数

**Files:**
- Modify: `src/tools/types.ts`
- Create: `tests/test_tool_types.test.ts`

- [ ] **Step 1: 为 ToolError 接口添加工厂函数**

在 `src/tools/types.ts` 现有接口下方添加：

```typescript
/** 创建一个 ToolError 实例（实际是普通 Error + 额外字段）。 */
export function createToolError(
  code: string,
  message: string,
  options: { recoverable?: boolean; details?: Record<string, unknown> } = {},
): Error & ToolError {
  const error = Object.assign(new Error(message), {
    code,
    recoverable: options.recoverable ?? true,
    details: options.details ?? undefined,
  });
  return error as Error & ToolError;
}

/** 检查一个错误是否是 ToolError。 */
export function isToolError(error: unknown): error is Error & ToolError {
  return (
    error instanceof Error &&
    typeof (error as Record<string, unknown>).code === "string" &&
    typeof (error as Record<string, unknown>).recoverable === "boolean"
  );
}
```

- [ ] **Step 2: 写测试**

```typescript
// tests/test_tool_types.test.ts
import { describe, expect, it } from "vitest";
import { createToolError, isToolError } from "../src/tools/types.js";

describe("ToolError", () => {
  it("createToolError creates an Error with ToolError fields", () => {
    const err = createToolError("GEN_EMPTY", "生成结果为空", { recoverable: true });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("GEN_EMPTY");
    expect(err.message).toBe("生成结果为空");
    expect(err.recoverable).toBe(true);
  });

  it("createToolError defaults recoverable to true", () => {
    const err = createToolError("UNKNOWN", "未知错误");
    expect(err.recoverable).toBe(true);
  });

  it("createToolError stores details", () => {
    const err = createToolError("PARSE_FAIL", "解析失败", {
      details: { raw: "garbage" },
    });
    expect(err.details).toEqual({ raw: "garbage" });
  });

  it("isToolError returns true for ToolError", () => {
    const err = createToolError("E001", "test");
    expect(isToolError(err)).toBe(true);
  });

  it("isToolError returns false for plain Error", () => {
    expect(isToolError(new Error("plain"))).toBe(false);
  });

  it("isToolError returns false for non-Error", () => {
    expect(isToolError("string")).toBe(false);
    expect(isToolError(null)).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run tests/test_tool_types.test.ts`
Expected: 6/6 PASS

- [ ] **Step 4: Commit**

```bash
git add src/tools/types.ts tests/test_tool_types.test.ts
git commit -m "feat: add createToolError factory and isToolError guard to tools/types"
```

---

## Task 4: BaseTool 增加 ToolCapabilities 抽象声明

**Files:**
- Modify: `src/tools/base.ts`
- Modify: `src/agent/orchestrator.ts` (实现 capabilities getter)
- Modify: `src/tools/generation.ts` (实现 capabilities getter)
- Modify: `src/tools/evaluation.ts` (实现 capabilities getter)
- Modify: `src/tools/planning.ts` (实现 capabilities getter)
- Modify: `src/tools/repair.ts` (实现 capabilities getter)

- [ ] **Step 1: BaseTool 增加 abstract getter**

在 `src/tools/base.ts` 中，`abstract get name()` 下方添加：

```typescript
import type { ToolCapabilities } from "./types.js";

// 在类体内，name getter 后面：
abstract get capabilities(): ToolCapabilities;
```

- [ ] **Step 2: AgentOrchestrator 实现 capabilities**

```typescript
// src/agent/orchestrator.ts
import type { ToolCapabilities } from "../tools/types.js";

get capabilities(): ToolCapabilities {
  return {
    requiresLlm: true,
    supportedTaskTypes: [],  // orchestrator 不直接执行 task
  };
}
```

- [ ] **Step 3: GenerationTool 实现 capabilities**

```typescript
// src/tools/generation.ts
import type { ToolCapabilities } from "./types.js";

get capabilities(): ToolCapabilities {
  return {
    requiresLlm: true,
    supportedTaskTypes: ["analyze", "design", "diagrams", "tests"],
  };
}
```

- [ ] **Step 4: EvaluationTool 实现 capabilities**

```typescript
// src/tools/evaluation.ts
get capabilities(): ToolCapabilities {
  return {
    requiresLlm: true,
    supportedTaskTypes: ["evaluate"],
  };
}
```

- [ ] **Step 5: PlanningTool 实现 capabilities**

```typescript
// src/tools/planning.ts
get capabilities(): ToolCapabilities {
  return {
    requiresLlm: true,
    supportedTaskTypes: ["plan"],
  };
}
```

- [ ] **Step 6: RepairTool 实现 capabilities**

```typescript
// src/tools/repair.ts
get capabilities(): ToolCapabilities {
  return {
    requiresLlm: true,
    supportedTaskTypes: ["repair"],
  };
}
```

- [ ] **Step 7: 运行类型检查和测试**

Run: `npx tsc --noEmit` + `npx vitest run`
Expected: 无新增类型错误，687 tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/tools/base.ts src/agent/orchestrator.ts src/tools/generation.ts src/tools/evaluation.ts src/tools/planning.ts src/tools/repair.ts
git commit -m "feat: add abstract ToolCapabilities declaration to BaseTool and all subclasses"
```

---

## Task 5: 将 ToolError 接入 GenerationTool 的 throw 点

**Files:**
- Modify: `src/tools/generation.ts`

这是 throw 最密集的 Tool（5 个 throw 点）。用 `createToolError` 替换裸 `new Error()`。

- [ ] **Step 1: 更新 throw 点**

```typescript
// 45 行：生成返回空结果
throw createToolError("GEN_EMPTY", `生成 ${task.type} 返回空结果`, { recoverable: true });

// 108 行：未知任务类型
throw createToolError("GEN_UNKNOWN_TYPE", `未知任务类型: ${task.type}`, { recoverable: false });

// 118 行：缺少输入
throw createToolError("GEN_MISSING_INPUT", "缺少 requirement_text 和 requirement_json", { recoverable: false });

// 138 行：缺少 requirement_json
throw createToolError("GEN_MISSING_REQJSON", "缺少 requirement_json", { recoverable: false });

// 169 行：未知图表类型
throw createToolError("GEN_UNKNOWN_DIAGRAM", `未知图表类型: ${diagramKind}`, { recoverable: false });
```

- [ ] **Step 2: 添加 import**

```typescript
import { createToolError } from "./types.js";
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run`
Expected: 687 tests PASS（错误格式变了但行为不变——catch 块用 `e.message` 提取消息，不受影响）

- [ ] **Step 4: Commit**

```bash
git add src/tools/generation.ts
git commit -m "refactor: GenerationTool throws ToolError instead of bare Error"
```

---

## Task 6: 将 ToolError 接入其余 Tool 和 Generator 的 throw 点

**Files:**
- Modify: `src/tools/evaluation.ts` — 检查有没有 throw 点
- Modify: `src/tools/repair.ts` — 检查有没有 throw 点
- Modify: `src/tools/planning.ts` — 检查有没有 throw 点
- Modify: `src/agent/orchestrator.ts` — 检查有没有 throw 点
- Modify: `src/generators/analyze.ts` — 1 个 throw
- Modify: `src/generators/design.ts` — 1 个 throw
- Modify: `src/generators/tests.ts` — 1 个 throw
- Modify: `src/generators/merge.ts` — 2 个 throw
- Modify: `src/generators/base.ts` — 2 个 throw

Generator 层的 throw 也换成 ToolError（虽然 Generator 不是 Tool，但它们产生的错误最终会被 Tool 层捕获，用统一格式方便处理）。

- [ ] **Step 1: 逐个更新 throw 点**

generators/analyze.ts:31
```typescript
throw createToolError("ANALYZE_EMPTY_INPUT", "需求文本和已有分析结果不能同时为空", { recoverable: false });
```

generators/design.ts:189
```typescript
throw createToolError("DESIGN_EMPTY_INPUT", "需求JSON不能为空且必须是字典类型", { recoverable: false });
```

generators/tests.ts:29
```typescript
throw createToolError("TESTS_EMPTY_INPUT", "需求JSON不能为空且必须是字典类型", { recoverable: false });
```

generators/merge.ts:37
```typescript
throw createToolError("MERGE_NO_RESULTS", "没有可合并的分析结果", { recoverable: false });
```

generators/merge.ts:62
```typescript
throw createToolError("MERGE_NON_DICT", "merge 返回了非字典类型", { recoverable: false });
```

generators/base.ts:78
```typescript
throw createToolError("GEN_NON_DICT", `LLM returned non-dict type: ${typeof result}`, { recoverable: true });
```

generators/base.ts:84
```typescript
throw createToolError("GEN_FAILED", `Generation failed after ${maxRetries} attempts: ${lastError.message}`, { recoverable: true });
```

- [ ] **Step 2: 每个文件添加 import**

```typescript
import { createToolError } from "../tools/types.js";
// generators 路径为: "../../tools/types.js"
```

- [ ] **Step 3: 检查 evaluation/repair/planning/orchestrator 的 throw 点**

根据前面的 grep 结果，这些文件没有直接的 `throw new Error` 语句（主要在 catch 块中处理），无需修改。

- [ ] **Step 4: 运行全部测试**

Run: `npx vitest run`
Expected: 687 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/generators/analyze.ts src/generators/design.ts src/generators/tests.ts src/generators/merge.ts src/generators/base.ts
git commit -m "refactor: generators throw ToolError instead of bare Error"
```

---

## Task 7: 最终验证

- [ ] **Step 1: 运行全部测试**

Run: `npx vitest run`
Expected: 693 tests PASS（+6 from new test_tool_types test file）

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 3: 确认清理干净**

```bash
# streamLlm 不再存在
grep -n "streamLlm" src/streaming.ts   # → 无结果

# copy-assets 只有一条 copy entry
grep -c "from:" scripts/copy-assets.mjs  # → 1

# 裸 new Error 在 tools/ 和 generators/ 中已替换
grep -n "throw new Error" src/tools/*.ts src/generators/*.ts src/agent/orchestrator.ts
# → 应只剩 0 条结果
```

---

## 自检清单

- [ ] 687→693 tests 全部通过
- [ ] `streamLlm` 已删除
- [ ] `copy-assets.mjs` 死路径已删除
- [ ] 所有 Tool 子类实现了 `capabilities` getter
- [ ] 所有 `throw` 点使用 `createToolError`
- [ ] `TracingLLMClient` 保留不动
