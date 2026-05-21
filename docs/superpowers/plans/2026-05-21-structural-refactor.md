# ReqDesign-Agent 结构重构计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 generators/ 与 tools/ 之间的职责重叠、修复分层违规、清理 state.ts God Object 倾向、整理测试目录结构。

**Architecture:** 项目存在清晰的分层（generators → tools → orchestration → session/state → runtime），但有 3 处层级违规和大量职责重叠。重构策略是"先补测试，再小步移动代码"，每步保持测试全绿。不改变外部行为，只调整内部结构。

**Tech Stack:** TypeScript, Vitest, Node.js

---

## 当前问题摘要

| # | 问题 | 严重性 | 涉及文件 |
|---|------|--------|----------|
| P1 | `generators/analyze.ts` 从 `tools/normalizer.ts` 导入（L1→L2 违规） | 🔴 | generators/analyze.ts, tools/normalizer.ts |
| P2 | `state.ts` 从 `tools/normalizer.ts` 导入（L4→L2 违规） | 🔴 | state.ts, tools/normalizer.ts |
| P3 | `tools/` 与 `generators/` 职责重叠（tools/base vs generators/base，tools/generation 包装 generators） | 🔴 | tools/base.ts, generators/base.ts, tools/generation.ts |
| P4 | `state.ts` 1424 行 God Object | 🟡 | state.ts |
| P5 | `runtime.ts` 1477 行职责过宽 | 🟡 | runtime.ts |
| P6 | `llmClient.ts` 1012 行承担过多 | 🟡 | llmClient.ts |
| P7 | 测试目录混入非测试文件 | 🟡 | tests/evaluationManager.ts, tests/retryManager.ts |
| P8 | orchestration/ 5/6 模块无测试覆盖 | 🟡 | orchestration/*.ts |
| P9 | `agent/orchestrator.ts` 继承 `tools/base.ts` 的 `BaseTool` | 🟡 | agent/orchestrator.ts |

## 重构优先级

```
Phase 1: 修复层级违规 (P1, P2) — 把 normalizer 提升为独立模块
Phase 2: 理清 tools vs generators 边界 (P3) — 明确谁调谁
Phase 3: 拆分 state.ts (P4) — 按子域拆分
Phase 4: 清理测试目录 (P7) — 最容易，穿插做
Phase 5: 补充 orchestration 测试 (P8) — 为未来重构铺路
```

> P5(runtime.ts)、P6(llmClient.ts)、P9(orchestrator 继承) 属于较大改动，不在本次范围内，记录为 follow-up。

---

## Phase 1: 修复层级违规 — 提取 normalizer 为共享模块

**核心思路：** `tools/normalizer.ts` 是一个纯文本处理模块（无 LLM 调用、无外部依赖），不应留在 tools 层。把它移到 `src/shared/normalizer.ts`，让 generators 和 state 都从共享层导入。

### Task 1.1: 为 normalizer 补充边界测试

**Files:**
- Read: `src/tools/normalizer.ts`
- Modify: `tests/test_normalizer.test.ts`

- [ ] **Step 1: 阅读 `src/tools/normalizer.ts` 的全部公共方法**

确认 `RequirementNormalizer` 类暴露了哪些方法（已知：`normalize`，可能还有其他）。记录每个方法的签名和边界条件。

- [ ] **Step 2: 在 `tests/test_normalizer.test.ts` 中补充边界测试**

为每个公共方法添加至少一个边界 case 测试：
- 空输入
- 只有 shell entities 的输入
- 含特殊字符的输入
- 超长输入

这些测试确保后续移动文件时行为不变。

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run tests/test_normalizer.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/test_normalizer.test.ts
git commit -m "test: add edge case tests for RequirementNormalizer before refactor"
```

### Task 1.2: 将 normalizer 移到 shared 层

**Files:**
- Create: `src/shared/normalizer.ts`
- Delete: `src/tools/normalizer.ts` (内容移至 shared)
- Modify: `src/generators/analyze.ts` (更新 import 路径)
- Modify: `src/state.ts` (更新 import 路径)
- Modify: `tests/test_normalizer.test.ts` (更新 import 路径)
- Modify: 所有其他引用 `tools/normalizer` 的文件

- [ ] **Step 1: 创建 `src/shared/` 目录并移动文件**

```bash
mkdir -p src/shared
cp src/tools/normalizer.ts src/shared/normalizer.ts
```

- [ ] **Step 2: 更新 `src/shared/normalizer.ts` 的导出路径注释（如果有）**

不需要改代码内容，文件完全复制。

- [ ] **Step 3: 全局搜索所有导入 `tools/normalizer` 的文件**

Run: `grep -rn "tools/normalizer" src/ tests/`

预期命中：
- `src/generators/analyze.ts`
- `src/state.ts`
- `tests/test_normalizer.test.ts`
- 可能还有 `src/runtime.ts`

- [ ] **Step 4: 逐一更新 import 路径**

在每个命中的文件中，将：
```typescript
import { RequirementNormalizer } from '../tools/normalizer.js';
// 或
import { RequirementNormalizer } from './normalizer.js';
```
改为：
```typescript
import { RequirementNormalizer } from '../shared/normalizer.js';
// 或相应相对路径
```

- [ ] **Step 5: 删除旧文件**

```bash
rm src/tools/normalizer.ts
```

- [ ] **Step 6: 运行全部测试**

Run: `npx vitest run`
Expected: ALL PASS（特别是 test_normalizer、test_state_subdomains、test_integration）

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: move RequirementNormalizer to shared/ to fix layer violation"
```

---

## Phase 2: 理清 tools vs generators 边界

**核心思路：** 当前 `tools/generation.ts` 只是简单包装 4 个 generators，`tools/evaluation.ts` 包装 2 个 generators + 评分逻辑。重构目标是：
1. 明确 generators 是"LLM 内容生产"层，tools 是"编排 + 后处理"层
2. `tools/base.ts` 和 `generators/base.ts` 的区分要清晰：BaseGenerator = LLM 调用 + prompt，BaseTool = 状态感知 + 多步编排
3. 给两个 base 类添加文档注释，明确各自的契约

### Task 2.1: 为 generators/base 和 tools/base 添加文档注释

**Files:**
- Modify: `src/generators/base.ts`
- Modify: `src/tools/base.ts`

- [ ] **Step 1: 在 `src/generators/base.ts` 类头部添加 JSDoc**

```typescript
/**
 * BaseGenerator — LLM 内容生产层
 *
 * 职责：加载 prompt 模板 → 调用 LLM → 返回结构化输出
 * 不涉及：状态管理、多步编排、后处理、评分
 *
 * 实现类：SystemDesigner, TestCaseGenerator, RequirementAnalyzer,
 *         DiagramGenerator, AnalyzeMerger
 */
```

- [ ] **Step 2: 在 `src/tools/base.ts` 类头部添加 JSDoc**

```typescript
/**
 * BaseTool — 编排 + 后处理层
 *
 * 职责：组合多个 Generator 的输出 + 执行后处理逻辑（验证、评分、修复）
 * 持有 LLMClient 引用用于策略决策（如 orchestrator 的 LLM routing）
 * 可感知全局状态（通过参数传入）
 *
 * 实现类：GenerationTool, EvaluationTool, PlanningTool, RepairTool, AgentOrchestrator
 */
```

- [ ] **Step 3: 运行类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/generators/base.ts src/tools/base.ts
git commit -m "docs: add layer contract comments to BaseGenerator and BaseTool"
```

### Task 2.2: 精简 tools/generation.ts — 减少对 generators 的透传

**Files:**
- Read: `src/tools/generation.ts` (478 行)
- Read: `src/generators/design.ts`, `src/generators/tests.ts`, `src/generators/diagrams.ts`, `src/generators/analyze.ts`

- [ ] **Step 1: 审计 generation.ts 的方法**

列出 `GenerationTool` 的每个公共方法，标注：
- 纯透传到 generator（可直接在调用方使用 generator）
- 有编排/后处理逻辑（应保留在 tool 中）
- 有状态管理逻辑（应保留）

- [ ] **Step 2: 记录审计结果**

在 plan 中记录每个方法的分类（此步骤仅分析不改代码）。

- [ ] **Step 3: Commit 审计文档（可选）**

如果产出了有价值的分析文档，可提交到 docs/。

---

## Phase 3: 拆分 state.ts — 按子域拆分

**核心思路：** `state.ts`（1424 行）包含 `ArtifactsState`、`ExecutionState`、`ReviewState` 三个子域视图 + `WorkflowState` 主类。将子域视图拆到独立文件，WorkflowState 保持为门面（facade），委托给子模块。

### Task 3.1: 为 state.ts 补充迁移安全测试

**Files:**
- Modify: `tests/test_state_subdomains.test.ts`

- [ ] **Step 1: 阅读 state.ts 的全部公共 API**

列出 `WorkflowState` 的所有公共方法，标注哪些操作哪个子域（artifacts/execution/review）。

- [ ] **Step 2: 确认现有测试覆盖了核心状态转换**

检查 `test_state_issue_serialization.test.ts` 和 `test_state_subdomains.test.ts` 是否覆盖了：
- `addArtifact` / `updateArtifact`
- `addVerdict` / `getVerdicts`
- `addIssue` / `resolveIssue`
- 子域视图同步

- [ ] **Step 3: 如有遗漏，补充测试**

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/test_state_subdomains.test.ts tests/test_state_issue_serialization.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test: strengthen state.ts tests before subdomain extraction"
```

### Task 3.2: 提取 ArtifactsState 到独立文件

**Files:**
- Create: `src/state/artifactsState.ts`
- Modify: `src/state.ts` (改为 re-export + 委托)

- [ ] **Step 1: 在 `src/state/` 目录下创建 `artifactsState.ts`**

将 `ArtifactsState` interface + `WorkflowState` 中所有只操作 artifacts 的方法移到新文件。

- [ ] **Step 2: 在 `state.ts` 中导入并委托**

```typescript
export { ArtifactsState } from './state/artifactsState.js';
// WorkflowState 内部委托给 ArtifactsState 实例
```

- [ ] **Step 3: 运行全部测试**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: extract ArtifactsState to state/artifactsState.ts"
```

### Task 3.3: 提取 ExecutionState 和 ReviewState

**Files:**
- Create: `src/state/executionState.ts`
- Create: `src/state/reviewState.ts`
- Modify: `src/state.ts`

- [ ] **Step 1-4: 同 Task 3.2 流程，分别提取两个子域**

- [ ] **Step 5: 最终确认 WorkflowState 成为薄 facade**

`state.ts` 应缩减到 < 200 行，只做 re-export 和子域协调。

- [ ] **Step 6: 运行全部测试**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: extract ExecutionState and ReviewState to state/ subdirectory"
```

---

## Phase 4: 清理测试目录

### Task 4.1: 将测试辅助文件移到 tests/helpers/

**Files:**
- Create: `tests/helpers/evaluationManager.ts`
- Create: `tests/helpers/retryManager.ts`
- Delete: `tests/evaluationManager.ts`
- Delete: `tests/retryManager.ts`
- Modify: 所有引用这两个文件的测试

- [ ] **Step 1: 创建 helpers 目录**

```bash
mkdir -p tests/helpers
```

- [ ] **Step 2: 移动文件**

```bash
mv tests/evaluationManager.ts tests/helpers/evaluationManager.ts
mv tests/retryManager.ts tests/helpers/retryManager.ts
```

- [ ] **Step 3: 搜索并更新引用**

Run: `grep -rn "from.*evaluationManager\|from.*retryManager" tests/`

更新所有 import 路径。

- [ ] **Step 4: 运行全部测试**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move test helpers to tests/helpers/ directory"
```

---

## Phase 5: 补充 orchestration 模块测试

### Task 5.1: 为 orchestration/strategy.ts 补充单元测试

**Files:**
- Create: `tests/test_strategy.test.ts`
- Read: `src/orchestration/strategy.ts`

- [ ] **Step 1: 阅读 strategy.ts，列出所有公共 API**

`StrategyName` type, `StrategyDecision` interface, `createStrategyDecision` factory, `ActionCompiler` class。

- [ ] **Step 2: 为 `createStrategyDecision` 写测试**

测试 factory 函数的各种输入组合。

- [ ] **Step 3: 为 `ActionCompiler` 写测试**

测试 action 编译逻辑的各种分支。

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/test_strategy.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add tests/test_strategy.test.ts
git commit -m "test: add unit tests for orchestration/strategy"
```

### Task 5.2: 为 orchestration/budget.ts 补充单元测试

**Files:**
- Create: `tests/test_budget.test.ts`
- Read: `src/orchestration/budget.ts`

- [ ] **Step 1-5: 同 Task 5.1 流程**

测试预算消耗、超限判断、重置逻辑。

### Task 5.3: 为 orchestration/policy.ts 补充单元测试

**Files:**
- Create: `tests/test_policy.test.ts`
- Read: `src/orchestration/policy.ts`

- [ ] **Step 1-5: 同 Task 5.1 流程**

测试策略守卫、确定性策略、策略降级。

---

## Follow-up（不在本次范围）

| 问题 | 建议 | 优先级 |
|------|------|--------|
| P5: runtime.ts 1477 行 | 拆分 phase execution 为独立模块 | 下次迭代 |
| P6: llmClient.ts 1012 行 | 提取 streaming 逻辑到 streaming.ts，提取 provider 适配到 providers/ | 下次迭代 |
| P9: AgentOrchestrator 继承 BaseTool | 改为组合：orchestrator 持有 tool dispatcher 而非继承 BaseTool | 需要设计讨论 |
| `tools/sessions.ts` 与具体 tool 类的双向依赖 | 引入 interface 解耦 | 随 P5 一起做 |
| memory/ 模块重构 | constants.ts 重命名为 types.ts，extractors 与 store 合并 | 低优先级 |

---

## 执行检查清单

每完成一个 Phase，确认：

- [ ] 全部测试通过 (`npx vitest run`)
- [ ] TypeScript 编译无错 (`npx tsc --noEmit`)
- [ ] 无 import 路径错误
- [ ] 已 commit，commit message 以 `refactor:` 或 `test:` 开头
