# ReqDesign-Agent 重构计划

> 初版: 2026-05-21（4 路并行 scout 代码审查）
> 最近同步: 2026-06-13（与代码现状逐项对齐）
> 状态: 第一批 / 第二批（去重）/ 第三批 Memory TTL 均已落地；剩余实质项仅「运行时安全 - State mutation 保护」一条。

> 注: `docs/superpowers/plans/2026-05-21-*.md` 为历史执行计划，绝大多数已实现，仅作存档参考。以本文件为准。

---

## 第一批：基础设施强化 — ✅ 全部完成

| # | 问题 | 实际落点 | 状态 |
|---|------|----------|------|
| 1 | RetryConfig 扩展 | `config.ts` `RetryConfigSchema` | ✅ |
| 2 | withRetry 工具函数 | `src/utils/retry.ts` | ✅ |
| 3 | chat() 集成 retry | `llmClient.ts`（withRetry 包裹流式/非流式） | ✅ |
| 4 | AbortController 超时 | `llmClient.ts:272+` | ✅ test_llm_client_timeout |
| 5 | Config zod 严格验证 | `config.ts` 内联 zod schema（**无独立 `configSchema.ts`**，原计划路径已过时） | ✅ test_config_schema |
| 6 | XML Parser 替换库 | `src/xmlParser.ts`（fast-xml-parser） | ✅ test_xml_parser |
| 7 | 清理 OCR 硬编码 | src/ 已无 OCR 残留 | ✅ |
| 8 | 全量测试 + 类型检查 | `npm run check` | ✅ 持续保绿（58 文件 / 1100+ 用例） |

## 第二批：消除重复 — ✅ 基本完成（validators 去重除外）

已落地：
- **BaseGenerator 基类**（`src/generators/base.ts`）：5 个 generator 统一 prompt 加载、`unwrapContent`、`formatContractList`、`generateJsonWithRetry`。
- **生成器进一步去重**（2026-06-13）：
  - `design.ts`：约束/异常两段逐字节相同的覆盖检查 → `collectUncoveredIds`（顺带修掉「先过滤 id 再用下标回查原数组」导致的 canonicalId 错配）。
  - `merge.ts`：`_mergeByConstraintRef` + `_mergeByExceptionRef` → `_mergeByRefField(items, refField)`。
  - `merge.ts`：`_mergeByCategory` / `_mergeByName` / `_dedupByName` / `_dedupByDescription` → `_dedupByKey(items, keyFn)`。
- **Tools 层**：`BaseTool`（`src/tools/base.ts`）+ 统一 `createToolError`（`tools/types.ts`）。
- **Orchestration**：`RemediationLadder`（`src/orchestration/remediation.ts`）统一 DeterministicPolicy 主路径与 PolicyGuard 兜底路径的 regenerate→repair→replan→pause 阶梯（消除两套漂移逻辑）。
- **共享工具**：`isRecord`（`src/utils/isRecord.ts`）、`WorkerKind`（`src/shared/types.ts`）已单一来源；**normalizer 已迁至 `src/shared/`**（原计划仍写在 src 根，已过时）。

⏸ 暂缓 —— validators 去重（风险偏高）：
`tests.ts` 的 `collectIds` / `collectAllIdForms` / `extract*Refs` 与 `RequirementIndex` 看似重复，但**语义不一致**（例：tests.ts 会保留只有 `id`、没有 `displayId` 的条目，而 `RequirementIndex.refKindFromCollection` 会直接丢弃）。直接抽公共函数**不是行为保持**，必须先补差异用例再动。

⏸ 暂缓 —— 架构面合并（不宜紧接 policy/remediation 重构之后）：
P0-3 Tools 接口再统一、P1-1 orchestration/runtime 模块再合并。runtime 已拆为 11 个模块（`src/runtime/*`），继续合并收益递减、风险升高。

## 第三批：运行时安全

| 项 | 状态 | 说明 |
|----|------|------|
| P0-4 Memory TTL / GC | ✅ 已完成 | `store.ts pruneOldFiles()`：deprecated / 超龄(MAX_MEMORY_AGE_DAYS) / 超量(MAX_MEMORY_FILES) 三规则，构造时触发；test_memory_policy 覆盖 |
| P1-2 State mutation 保护 | ⬜ **下一步（test-first）** | `WorkflowState` 的 `artifactsState` / `executionState` / `reviewState` getter 直接 `return this._xxxStateView`（`state.ts:254-264`），疑似把内部可变引用暴露给调用方 |

### 下一步：State mutation 保护（窄范围、测试先行）
1. 先写**泄漏探针测试**：取 `WorkflowState` 各 view getter 的返回值，尝试 mutate（push/改字段），断言内部状态不被外部改动影响。
2. 仅在**测试证实泄漏**后，对真正泄漏的出口加最小防御（`Object.freeze` 或浅/深拷贝），不做无证据的预防式加固。
3. 改动范围限定在 `state.ts` 及其 view 构造，避免外溢到 runtime 各 manager。

---

## 剩余风险优先级（高 → 低）

1. **State mutation 保护** —— 有真实安全收益、范围可控、test-first 可验证 → 进行中。
2. **validators 去重** —— 收益中 / 风险中，需先补差异用例 → 暂缓。
3. **Tools / orchestration 架构再合并** —— 收益低 / 风险高、面大 → 暂缓。
