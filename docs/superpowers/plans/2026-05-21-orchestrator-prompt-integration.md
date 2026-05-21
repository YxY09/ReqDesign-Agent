# Orchestrator Prompt 集成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AgentOrchestrator 通过 BaseTool 的 `_getSystemPrompt()` 加载 `prompts/coordinator.md`，传递给 StrategyBrain 作为 system prompt，使 coordinator.md 的工程规则、宪法约束、Agent 记忆三层组装全部生效。

**Architecture:** 当前 StrategyBrain 硬编码 system prompt（"You are an engineering orchestration strategist..."），coordinator.md 是死文件。改为：AgentOrchestrator 用 `_getSystemPrompt("coordinator.md")` 组装完整 system prompt（含宪法+记忆），传入 StrategyBrain。StrategyBrain 的 `decide()` 方法签名增加 `systemPrompt` 参数。

**Tech Stack:** TypeScript, Vitest

---

## 变更范围

| 文件 | 变更 |
|------|------|
| `src/agent/orchestrator.ts` | 调用 `_getSystemPrompt("coordinator.md")` 并传给 StrategyBrain |
| `src/orchestration/strategyBrain.ts` | `decide()` 接收 `systemPrompt` 参数，移除硬编码 system prompt |
| `tests/test_orchestration.test.ts` | 验证 system prompt 中包含 coordinator.md 内容 |
| `prompts/coordinator.md` | 无变更（已经是写好的，只是之前没人加载） |

**不动的文件：**
- `src/tools/base.ts` — 不变，`_getSystemPrompt()` 已经具备完整功能
- `src/orchestration/policy.ts` — 不变，确定性策略不涉及 LLM
- `src/runtime.ts` — 不变，调用链 `runtime → coordinator.decide()` 不变

---

## Task 1: StrategyBrain.decide() 接收 systemPrompt 参数

**Files:**
- Modify: `src/orchestration/strategyBrain.ts`

- [ ] **Step 1: 修改 `decide()` 方法签名，增加 `systemPrompt` 参数**

```typescript
// 旧签名：
async decide(snapshot: OrchestratorSnapshot): Promise<StrategyDecision>

// 新签名：
async decide(snapshot: OrchestratorSnapshot, systemPrompt: string): Promise<StrategyDecision>
```

- [ ] **Step 2: 在 `decide()` 方法体内，用 `systemPrompt` 替换硬编码值**

旧代码：
```typescript
const system =
  "You are an engineering orchestration strategist. " +
  "Choose a high-level strategy only. Do not choose low-level spawn/save actions.";
```

新代码：
```typescript
// systemPrompt 由调用方通过 BaseTool._getSystemPrompt() 组装
// 包含 coordinator.md 内容 + 宪法约束 + Agent 记忆
```

方法体中 `system` 变量改为使用 `systemPrompt` 参数：
```typescript
const { onChunk, done } = makeStreamPrinter("[Orchestrator]");
try {
  const response = await this.llm.generateJson(prompt, systemPrompt, onChunk);
  return StrategyBrain._parseResponse(response);
} catch (exc) {
  // ... 不变
}
```

- [ ] **Step 3: 运行测试确认影响范围**

Run: `npx vitest run`
Expected: 可能会有测试失败，因为 StrategyBrain.decide() 的调用签名变了。

- [ ] **Step 4: Commit**

```bash
git add src/orchestration/strategyBrain.ts
git commit -m "refactor: StrategyBrain.decide() accepts systemPrompt parameter"
```

---

## Task 2: AgentOrchestrator 加载 coordinator.md 并传入 StrategyBrain

**Files:**
- Modify: `src/agent/orchestrator.ts`

- [ ] **Step 1: 修改 `resolveNonDeterministicStrategy()` 方法**

旧代码：
```typescript
private async resolveNonDeterministicStrategy(
  snapshot: ReturnType<typeof StateReader.fromState>,
): Promise<StrategyDecision> {
  if (!this.strategyBrain) {
    return createStrategyDecision({
      strategy: "pause_for_user",
      reason: "no deterministic strategy and no LLM strategy brain available",
    });
  }
  try {
    const result = await this.strategyBrain.decide(snapshot);
    this.logger.info(`decide: LLM strategy=${result.strategy}，confidence=${result.confidence}`);
    return result;
  } catch (exc) {
    this.logger.warn(`decide: LLM 策略决策失败: ${exc instanceof Error ? exc.message : String(exc)}`);
    return createStrategyDecision({
      strategy: "pause_for_user",
      reason:
        exc instanceof Error
          ? `strategy brain failed: ${exc.message}`
          : "strategy brain failed",
    });
  }
}
```

新代码：
```typescript
private async resolveNonDeterministicStrategy(
  snapshot: ReturnType<typeof StateReader.fromState>,
): Promise<StrategyDecision> {
  if (!this.strategyBrain) {
    return createStrategyDecision({
      strategy: "pause_for_user",
      reason: "no deterministic strategy and no LLM strategy brain available",
    });
  }
  try {
    const systemPrompt = await this._getSystemPrompt(
      "coordinator.md",
      "You are an engineering orchestration strategist. Choose a high-level strategy only.",
    );
    const result = await this.strategyBrain.decide(snapshot, systemPrompt);
    this.logger.info(`decide: LLM strategy=${result.strategy}，confidence=${result.confidence}`);
    return result;
  } catch (exc) {
    this.logger.warn(`decide: LLM 策略决策失败: ${exc instanceof Error ? exc.message : String(exc)}`);
    return createStrategyDecision({
      strategy: "pause_for_user",
      reason:
        exc instanceof Error
          ? `strategy brain failed: ${exc.message}`
          : "strategy brain failed",
    });
  }
}
```

关键变化：
1. 在调用 `this.strategyBrain.decide()` 之前，先调用 `this._getSystemPrompt("coordinator.md", fallback)`
2. fallback 保留原来的硬编码字符串，确保 coordinator.md 加载失败时仍有合理行为
3. `_getSystemPrompt()` 内部自动做宪法注入 + 记忆注入 + 缓存

- [ ] **Step 2: 运行全部测试**

Run: `npx vitest run`
Expected: ALL PASS（StrategyBrain 的调用签名已同步更新）

- [ ] **Step 3: Commit**

```bash
git add src/agent/orchestrator.ts
git commit -m "feat: AgentOrchestrator loads coordinator.md via BaseTool._getSystemPrompt()"
```

---

## Task 3: 验证 coordinator.md 内容正确注入

**Files:**
- Modify: `tests/test_orchestration.test.ts`

- [ ] **Step 1: 添加测试验证 system prompt 包含 coordinator.md 内容**

现有测试 `"injects coordinator memory into strategy-brain prompts"` 已经验证了 memory 注入到 user prompt。我们需要增加一个测试验证 **system prompt** 包含 coordinator.md 内容。

找到现有测试文件中的 LLM mock 结构：

```typescript
function createMockLLM(
  response?: Record<string, unknown>,
): LLMClient {
  return {
    generateJson: vi.fn().mockResolvedValue(response ?? {}),
    generateText: vi.fn().mockResolvedValue(""),
  } as unknown as LLMClient;
}
```

`generateJson` 的调用签名是 `generateJson(prompt, system, onChunk)`，所以 `mock.calls[0][1]` 是 system prompt。

在现有 `"delegates initial routing to LLM — start_planning for complex request"` 测试附近，添加新测试：

```typescript
it("loads coordinator.md into system prompt for LLM strategy", async () => {
  const mockLLM = createMockLLM({
    strategy: "start_planning",
    reason: "test",
    confidence: 0.8,
  });
  const coordinator = new AgentOrchestrator(mockLLM);
  const state = new WorkflowState();
  state.requirementText = "Build a complex multi-module system.";

  await coordinator.decide(state, makeMailbox());

  const llmCall = vi.mocked(mockLLM.generateJson).mock.calls[0];
  expect(llmCall).toBeDefined();
  // llmCall[0] = user prompt, llmCall[1] = system prompt
  const systemPrompt = String(llmCall[1]);
  // coordinator.md 包含这些独特的文本片段
  expect(systemPrompt).toContain("orchestrator");
  expect(systemPrompt).toContain("Allowed strategies");
  expect(systemPrompt).toContain("engineering rules");
});
```

注意：如果 coordinator.md 不存在或加载失败，fallback 是 "You are an engineering orchestration strategist. Choose a high-level strategy only."。测试应该通过，因为 fallback 中包含 "orchestration strategist"。但如果 coordinator.md 存在（它确实存在），system prompt 会包含更丰富的内容。

为了更健壮，也验证 coordinator.md 的特有内容：
```typescript
// coordinator.md 包含 "Prefer advancing ready work" 这样的工程规则
expect(systemPrompt).toContain("Prefer advancing ready work");
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run tests/test_orchestration.test.ts`
Expected: 新测试通过，现有测试不受影响。

- [ ] **Step 3: 运行全部测试**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/test_orchestration.test.ts
git commit -m "test: verify coordinator.md is loaded into LLM strategy system prompt"
```

---

## Task 4: 更新 BaseTool 的 JSDoc 注释

**Files:**
- Modify: `src/tools/base.ts`

- [ ] **Step 1: 更新 BaseTool 类注释中的实现类列表**

之前写的注释说 `AgentOrchestrator` 是 BaseTool 的实现类但没有说明它用了哪个功能。现在它确实使用了 `_getSystemPrompt()`，注释更准确了。

当前注释：
```typescript
/**
 * BaseTool — 编排 + 后处理层 (Layer 2)
 * ...
 * 实现类：GenerationTool, EvaluationTool, PlanningTool, RepairTool, AgentOrchestrator
 */
```

更新为：
```typescript
/**
 * BaseTool — 编排 + 后处理层 (Layer 2)
 *
 * 职责：组合多个 Generator 的输出 + 执行后处理逻辑（验证、评分、修复）
 * 持有 LLMClient 引用用于策略决策（如 orchestrator 的 LLM routing）
 * 提供统一的 prompt 加载管道（宪法注入 + 记忆注入 + 缓存）
 * 可感知全局状态（通过参数传入）
 *
 * 实现类：GenerationTool, EvaluationTool, PlanningTool, RepairTool, AgentOrchestrator
 *   - AgentOrchestrator 使用 _getSystemPrompt() 加载 coordinator.md
 */
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/base.ts
git commit -m "docs: update BaseTool JSDoc to reflect AgentOrchestrator prompt usage"
```

---

## 自检清单

完成后确认：

- [ ] `npx vitest run` 全部通过
- [ ] `npx tsc --noEmit` 无新增类型错误
- [ ] `grep -rn "coordinator\.md" src/` — 确认 coordinator.md 在 orchestrator.ts 中被引用
- [ ] `grep -rn "You are an engineering orchestration strategist" src/` — 确认硬编码只作为 fallback 存在，不再是主 prompt
- [ ] StrategyBrain 不再自己硬编码 system prompt
- [ ] coordinator.md 的工程规则（"Prefer advancing ready work" 等）出现在 LLM 调用的 system prompt 中
