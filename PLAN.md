# Refactoring Plan: Canonicalize and Link

## 目标
Analyze 阶段的 ID 只是局部临时句柄，全局 ID 在 Merge 之后统一分配。下游只消费 canonicalId，displayId 给人看。

## Phase 1: Analyze 输出格式改造（提示词）
- 改 prompts/requirement_analysis.md：Function/Constraint/Exception 的 id 改名为 localId
- 改 prompts/requirement_analysis_constraints.md：同上
- 内部引用改为 {type, localId} 格式
- Entity/Actor 保持 entityRef/actorRef 不变

## Phase 2: Merge 改造（src/generators/merge.ts）
### Phase 2.1: preMerge 适配 localId
- Function 按 name 分组，保留 localId
- Constraint/Exception 按 source_text 分组，保留 localId

### Phase 2.2: 新增 canonicalizeAndLink 模块（src/shared/canonicalizer.ts）
- assignCanonicalIds：Function 分配 FUN_SEARCH_CASE，Constraint 分配 CON_AUDIT_IMMUTABLE，Exception 分配 EXC_SEARCH_TIMEOUT
- assignDisplayIds：F001, C001, X001
- buildRawMap：localId/name 到 canonicalId 映射
- resolveReferences：替换所有内部引用
- validateIntegrity：无重复、无 dangling reference

在 merge() pipeline 的 _verifySourceRefs 之后、qualityGate 之前调用

## Phase 3: Quality Gate 改造（src/shared/analysisQualityGate.ts）
- id_format 分类型检查：E_/A_/FUN_/CON_/EXC_
- cross_reference_integrity 用 canonicalId 匹配
- 新增 displayId 唯一性检查

## Phase 4: 下游适配
- design.ts：validateDesign 用 displayId 做 containsToken
- tests.ts：test case target 用 displayId
- diagrams.ts：图表用 canonicalId 或 displayId

## Phase 5: 提示词改造
- 最后做，先让代码兼容两种格式

## 执行顺序
1. Phase 2.2（核心：新增 canonicalizer）
2. Phase 3（Quality Gate 适配）
3. Phase 4（下游适配）
4. Phase 1 + 5（提示词改造，最后做）
