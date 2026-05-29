# Constraint Registry 重构方案

## 目标

从"LLM 多任务自由分析 + 事后合并"改成"Registry 前置建模 + Traceability Matrix 驱动生成 + Validator 强制门禁"。

核心原则：**让 LLM 负责语义理解，让程序负责 ID、覆盖率、引用一致性和门禁。**

---

## 三阶段路线

### Phase 1: 快速止血（预计 3-5 天）

不改架构，只改 prompt 和 validator，立刻拉约束覆盖率。

#### 1.1 Test prompt 强制约束覆盖
- 文件：src/generators/tests.ts
- buildTestContract：
  - "可用于边界测试的约束 ID" → "必须覆盖的约束 ID"
  - 约束字段从 ["displayId", "id", "description"] 扩展为 ["displayId", "id", "description", "source_text", "related_functions"]
  - 加硬性约束行："每个约束 ID 至少出现在一个边界测试或约束验证测试中"
- test_case.md：确认和 buildTestContract 不矛盾

#### 1.2 Design 输出结构化
- 文件：src/generators/design.ts
- 设计生成 prompt 要求每个设计决策带 implementsConstraints
- validateDesign 加约束覆盖检查：每个 constraintId 至少被一个设计决策覆盖
- 禁止 Design 自己重新编号 C001/C002

#### 1.3 Coverage Validator
- 新文件：src/shared/coverageValidator.ts
- 程序化检查：
  - function test coverage（每个 function 至少一个 test case）
  - constraint verification coverage（每个 constraint 至少一个 test case 或 verification item）
  - exception test coverage（每个 exception 至少一个 test case）
  - constraint design coverage（每个 constraint 至少被一个设计决策实现）
  - invalid reference detection（引用不存在的 ID）
  - self-invented ID detection（下游自己编的 ID）
- 输出：coverage report + uncovered items list
- 位置：在 quality gate 之后、review 之前调用

#### 1.4 Repair prompt 增强
- 文件：src/runtime/repairAgent 或相关
- Repair 时传入 coverage validator 的 uncovered items
- 不是泛泛说"请改进"，而是说"以下 3 个约束未被测试覆盖：C005, C008, C012，请补充"

#### 1.5 验证指标
- constraint verification coverage ≥ 90%
- invalid constraint reference = 0
- design constraint coverage ≥ 90%

---

### Phase 2: Constraint Registry + Canonicalizer（预计 1-2 周）

解决约束提取不稳定、去重失败、ID 冲突、关联指错。

#### 2.1 Constraint Registry 提取
- 新文件：src/generators/constraintExtractor.ts
- 新提示词：prompts/constraint_extraction.md
- 输入：完整需求文档 + Entity Registry + Function Registry
- 输出：Constraint Candidate 列表
- 每个 candidate 包含：
  - descriptionZh（中文描述）
  - canonicalRuleEn（英文规范表述）
  - type/subtype（security/performance/usability/data/integrity...）
  - evidence（sourceText + 章节定位）
  - relatedFunctionCandidates（通过关键词/章节匹配）
  - atomic（是否需要拆分）

#### 2.2 Constraint Atomicizer
- 在 constraintExtractor 内实现
- 判断原则：一个约束只描述一个可验证规则
- 复合约束拆分示例：
  - "搜索响应不超过8秒且不返回无权限记录" → 拆成两个原子约束
- 拆分时保留 evidence 追溯

#### 2.3 Constraint Canonicalizer（替代当前 merge 中的约束处理）
- 新文件：src/shared/constraintCanonicalizer.ts
- 输入：Constraint Candidate 列表（来自 Registry + Analyze 新增 candidate）
- 处理步骤：
  1. 语义规范化：生成 normalizedRule（结构化：condition/subject/modality/action/object）
  2. 分类：type/subtype
  3. 去重（三层）：
     - 第一层：确定性规则（normalizedRule 完全相同、metric/value/unit 相同）
     - 第二层：文本相似度候选召回
     - 第三层：LLM 裁定（带禁止规则：数值不同不合并、对象不同不合并、must vs should 标记冲突）
  4. ID 分配：
     - constraintUid：程序生成（ct_ + hash）
     - canonicalId：CON_TYPE_ENGLISH_SLUG_SHORTHASH（如 CON_SEC_SEARCH_RESULT_ACCESS_CONTROL_A3F2）
     - displayId：C001, C002, ...
  5. 生成 verification strategy（testability、recommendedType、acceptanceCriteria）

#### 2.4 Constraint-Function Linker
- 在 constraintCanonicalizer 内实现
- 候选生成（程序）：
  - 同一章节下的功能
  - sourceText 中出现功能关键词
  - 约束 scope 中出现功能别名
  - 约束涉及的实体与功能输入/输出实体重叠
- LLM 确认：只判断候选是否正确，不要从全部功能里自由选择
- 输出：relatedFunctions 带 relation 类型和 confidence

#### 2.5 Analyze 任务改造
- 文件：src/generators/analyze.ts, prompts/requirement_analysis.md
- Analyze 不再自己创建约束 ID
- 只能引用已有 constraintRef
- 发现新约束只能输出 missingConstraintCandidates
- 最终约束只能由 ConstraintCanonicalizer 统一生成

#### 2.6 Merge 改造
- 文件：src/generators/merge.ts
- 约束不再按 source_text 硬合并
- Merge 只负责：
  - 收集 Analyze 的 constraintRef 引用
  - 收集 missingConstraintCandidates
  - 新 candidate 交给 ConstraintCanonicalizer 增量处理
  - 合并证据（同一约束的多条 evidence）
  - 冻结 final constraints

#### 2.7 canonicalId 格式升级
- 从纯 hash（CON_HKDT6200）改为语义 slug + hash
- 英文：CON_PERF_SEARCH_RESPONSE_TIME_8S_91BC
- 中文：先让 LLM 生成 canonicalRuleEn，再生成 slug
- hash 保留 4 位防碰撞

#### 2.8 验证指标
- 约束数量波动 < 20%（同一文档跑 3 次）
- 零重复 canonicalId
- relatedFunctions 准确率 > 90%

---

### Phase 3: Registry 驱动架构（预计 2-3 周）

完整升级为 Registry + Traceability Matrix + Validator 三层架构。

#### 3.1 Document Normalizer（文档锚点化）
- 新文件：src/shared/documentNormalizer.ts
- XML/Word → sections / paragraphs / sentences
- 每句话有稳定 spanId（如 S_0042_03）
- 所有后续模块通过 spanId 引用原文，不再用 source_text 模糊匹配

#### 3.2 Function Registry
- 扩展现有 Registry 提取
- 新文件或扩展：src/generators/registryExtractor.ts
- 提取功能名、别名、所属章节
- Analyze 任务引用 functionRef，不再自己编号

#### 3.3 Exception Candidate Registry
- 半前置：先抽候选，Analyze 时补充
- 异常通常依附功能，不需要完全前置

#### 3.4 Traceability Matrix
- 新文件：src/shared/traceabilityMatrix.ts
- analysis.json 新增 traceability 字段：
  - functionToConstraints
  - constraintToFunctions
  - functionToExceptions
  - constraintToEvidence
  - constraintToDesign
  - constraintToTests
- 所有下游模块围绕这个矩阵工作

#### 3.5 三层架构分离
- Knowledge Layer：Registry + Evidence + Traceability
- Generation Layer：Design / Test / Diagrams，只消费 analysis.json
- Validation Layer：Coverage Validator + Reference Validator + LLM Semantic Review

#### 3.6 Review 拆分
- 程序化 Validator：ID 唯一性、引用完整性、覆盖率、重复检测
- LLM Review：只做语义审查（测试步骤是否真验证了约束、related_functions 是否合理、设计是否真实现了约束）
- Review 不再负责硬规则检查

#### 3.7 验证指标
- coverage validator 所有检查 100% 通过
- 零 invalid reference
- 零 self-invented ID
- constraint verification coverage = 100%
- constraint design coverage = 100%

---

## 数据结构演进

### 当前约束结构
```json
{
  "id": "CON_HKDT6200",
  "displayId": "C001",
  "description": "审计跟踪数据不可修改",
  "source_text": "The word 'unalterable' is to mean...",
  "related_functions": []
}
```

### Phase 2 目标结构
```json
{
  "constraintUid": "ct_9f2a13d7",
  "displayId": "C001",
  "canonicalId": "CON_SEC_AUDIT_DATA_IMMUTABLE_32FA",
  "type": "security",
  "subtype": "data_integrity",
  "descriptionZh": "审计数据不可修改",
  "canonicalRuleEn": "Audit data must be immutable and cannot be modified or deleted by any user",
  "sourceText": "The word 'unalterable' is to mean...",
  "relatedFunctions": [
    { "functionId": "FUN_EXPORT_AUDIT_TRAIL", "relation": "constrains", "confidence": 0.92 }
  ],
  "verification": {
    "testability": "testable",
    "recommendedType": "security_integration_test",
    "acceptanceCriteria": [
      "No user role can modify audit trail records",
      "No user role can delete audit trail records"
    ]
  }
}
```

### Phase 3 目标结构
```json
{
  "constraintUid": "ct_9f2a13d7",
  "displayId": "C001",
  "canonicalId": "CON_SEC_AUDIT_DATA_IMMUTABLE_32FA",
  "type": "security",
  "subtype": "data_integrity",
  "descriptionZh": "审计数据不可修改",
  "canonicalRuleEn": "Audit data must be immutable and cannot be modified or deleted by any user",
  "normalizedRule": {
    "condition": "any user",
    "subject": "audit trail data",
    "modality": "must_not",
    "action": "modify or delete",
    "object": "audit trail records"
  },
  "evidence": [
    { "sentenceId": "S_0042_03", "sectionId": "SEC_AUDIT", "sourceText": "..." }
  ],
  "relatedFunctions": [
    { "functionId": "FUN_EXPORT_AUDIT_TRAIL", "relation": "constrains", "confidence": 0.92, "evidence": "explicit section overlap" }
  ],
  "verification": {
    "testability": "testable",
    "recommendedType": "security_integration_test",
    "acceptanceCriteria": [
      "No user role can modify audit trail records",
      "No user role can delete audit trail records"
    ]
  }
}
```

---

## 文件清单

### Phase 1 新增/修改
- 修改：src/generators/tests.ts（prompt 改造）
- 修改：src/generators/design.ts（约束覆盖检查）
- 新增：src/shared/coverageValidator.ts
- 修改：src/runtime/repair 相关（传入 uncovered items）

### Phase 2 新增/修改
- 新增：src/generators/constraintExtractor.ts
- 新增：prompts/constraint_extraction.md
- 新增：src/shared/constraintCanonicalizer.ts（含 atomicizer、deduplicator、linker）
- 修改：src/generators/merge.ts（约束处理委托给 canonicalizer）
- 修改：src/generators/analyze.ts（Analyze 只引用不创建约束）
- 修改：prompts/requirement_analysis.md（constraintRef 引用模式）
- 删除：当前 canonicalizer.ts 中的约束相关逻辑（合并到 constraintCanonicalizer）

### Phase 3 新增/修改
- 新增：src/shared/documentNormalizer.ts
- 修改：src/generators/registryExtractor.ts（扩展 Function Registry）
- 新增：src/shared/traceabilityMatrix.ts
- 修改：src/shared/analysisQualityGate.ts（拆分为 validator + semantic review）
- 修改：analysis.json schema（新增 traceability 字段）

---

## 执行优先级

Phase 1 > Phase 2.3-2.4（Canonicalizer + Linker）> Phase 2.1-2.2（Registry 提取）> Phase 2.5-2.6（Analyze 改造）> Phase 3

理由：
- Phase 1 不依赖架构改动，立刻见效
- Phase 2.3-2.4 是核心逻辑，解决去重和关联问题
- Phase 2.1-2.2 解决提取不稳定
- Phase 2.5-2.6 是最后一步——只有 Registry 准备好了，Analyze 才能切换到引用模式
- Phase 3 是最终形态，可以在 Phase 2 验证后再做
