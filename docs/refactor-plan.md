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
| P1-2 State mutation 保护 | ✅ 已审计（test-first，2026-06-13） | 结论：无需 clone/freeze，见下方审计结论 |

### State mutation 保护 —— 审计结论（test-first，已完成）
区分两个边界，结论是**不加** defensive clone/freeze：

1. **subdomain view getter**（`artifactsState`/`executionState`/`reviewState`，`state.ts:254-264`）是**有意为之的双向 live 代理**
   （`_linkedView`，注释明确「保证旧版消费者通过视图修改时不会产生状态分叉」），已由 `test_state_subdomains` 锁定。冻结/拷贝会**破坏既定契约**。
2. **OrchestratorSnapshot**（交给 policy/决策层的投影，`snapshot.ts`）才是该只读的边界。审计 `StateReader.fromState` 与所有 `getXxxTaskIds()`：
   每个集合都**新建**（`Object.entries().filter().map().sort()`、`[...set].filter().sort()`、`.slice()`、map 出新字面量），
   **不别名**任何内部可变集合 → 决策层无法经快照回写状态。

落地：新增 `tests/test_state_mutation_safety.test.ts`（3 用例）固化该不变量——对快照集合 push/改字段后，
重建快照与 `WorkflowState` 内部（Set、progress set、Issue 对象）均不受影响。**未改任何生产代码**，仅补回归测试。

---

## 剩余风险优先级（高 → 低）

1. ~~State mutation 保护~~ —— ✅ 已审计：快照边界本就非别名，仅补回归测试；视图别名为有意契约，不动。
2. **validators 去重** —— 收益中 / 风险中，需先补差异用例 → 暂缓。
3. **Tools / orchestration 架构再合并** —— 收益低 / 风险高、面大 → 暂缓。
