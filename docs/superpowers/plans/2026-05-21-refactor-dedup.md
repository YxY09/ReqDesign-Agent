# 消除代码重复实现计划

> **For agentic workers:** Use subagent-driven-development.

**Goal:** 消除 Generators、Tools、Orchestration 层和共享工具的代码重复，减少 ~300 行重复代码。

**Architecture:** 4 个独立改造线：1) Generators 抽取 BaseGenerator 基类；2) Tools 强化 BaseTool + 统一错误类型；3) Orchestration 合并重叠模块；4) 共享工具去重（isRecord, WorkerKind）。

---

## Task 2-1: 抽取 BaseGenerator 基类

### 问题
5 个 LLM-based generator（analyze, design, diagrams, merge, tests）有近乎相同的模板：
- 构造函数: `llm` + `loadPrompt()`
- Prompt 占位符替换: `sanitizePlaceholder + template.replace`
- `_unwrapContent` 在 analyze 和 merge 中各有一份

### 文件
- 新建: `src/generators/base.ts`
- 修改: `src/generators/analyze.ts`, `design.ts`, `diagrams.ts`, `merge.ts`, `tests.ts`

### 方案
创建 `BaseGenerator` 抽象类，提供:
- `constructor(llm, promptFilename, fallback)` — 统一 prompt 加载
- `sanitizePlaceholder(text, placeholder)` — 防占位符碰撞
- `buildPrompt(replacements)` — 统一替换
- `static unwrapContent(result)` — 去重 _unwrapContent
- `formatContractList(items, fields)` — 去重 formatContractList/itemLines

### 注意
- mermaid.ts 是纯同步校验器，不继承
- analyze.ts 的 `_generateWithRetry` 可提升到基类

---

## Task 2-2: 强化 BaseTool + 统一错误类型

### 问题
- `BaseTool.llm: LLMClient | null` 允许 null，但子类全用 `this.llm!`
- `_getSystemPrompt()` 在 4 个子类各有一份 copy-paste
- 无统一错误类型

### 文件
- 修改: `src/tools/base.ts`
- 新建: `src/tools/types.ts`
- 修改: `src/tools/evaluation.ts`, `generation.ts`, `planning.ts`, `repair.ts`

### 方案
- `BaseTool` 构造函数强制 `llm: LLMClient`（非 null）
- 将 `_getSystemPrompt()` cache+load 逻辑提到基类
- 定义 `ToolError` 类型

---

## Task 2-3: 编排层模块合并

### 问题
- `_isSafeFinalMajorRepairTarget()` gates.ts 和 policy.ts 各一份
- `isTaskRunning()` 同样重复
- `ReviewScheduler` 被实例化两次
- 12 个 orchestration 文件职能重叠

### 文件
- 合并: `gates.ts` + `policy.ts` → `policy.ts`（消除重复，共享 ReviewScheduler）
- 合并: `strategy.ts` + `compiler.ts` → `strategy.ts`
- 合并: `config.ts` + `budget.ts` → `budget.ts`
- 合并: `runManager.ts` + `runSummary.ts` → `runManager.ts`
- 合并: `convergence.ts` → `snapshot.ts`

---

## Task 2-4: 共享工具去重

### 问题
- `isRecord()` 在 persistenceService.ts, resultHandler.ts, runtime.ts, session.ts 4 处重复定义（已有 `utils/isRecord.ts`）
- `WorkerKind` 类型在 resultHandler.ts, workerDispatcher.ts, runtime.ts 3 处重复

### 文件
- 修改: 引用 `utils/isRecord.ts` 的 3 个文件
- 修改: `src/agent/types.ts` 添加 WorkerKind
- 修改: resultHandler.ts, workerDispatcher.ts, runtime.ts 引用 WorkerKind
