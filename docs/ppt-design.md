# ReqDesign —— 需求驱动的自动化系统设计引擎

## PPT 完整设计文档

---

## 第一部分：问题定义与系统定位（建议 2 页）

### 1.1 行业痛点

在软件工程实践中，从一篇需求文档到可交付的系统设计文档，传统流程依赖人工完成全链路工作：

- **需求分析师**阅读需求文档，手动提取功能列表、约束条件、异常场景、业务实体
- **系统架构师**基于需求分析，手动设计模块划分、类结构、接口定义、数据流、状态机
- **开发工程师**手动绘制架构图（类图、状态图、活动图）
- **测试工程师**基于需求分析和系统设计，手动编写测试用例

这个过程存在三个核心问题：

1. **遗漏约束**：人工分析容易漏掉非功能性约束（安全、性能、数据规格），尤其当约束以陈述句而非"必须/不得"等明示词语表达时
2. **设计测试不一致**：系统设计和测试用例由不同阶段产出，容易出现"设计写了规则但测试没覆盖"的追溯断裂
3. **不可追溯**：无法回答"这个约束在设计里怎么实现的？在测试里怎么验证的？"——约束→设计→测试的追溯链断裂

### 1.2 ReqDesign 的定位

ReqDesign 是一个**需求驱动的自动化系统设计引擎**。输入一篇需求文档（Markdown），自动产出五类交付物：

| 交付物 | 格式 | 内容 |
|---|---|---|
| 需求分析 | analysis.json + analysis.md | 功能列表、约束条件、异常场景、业务实体、实体关系 |
| 系统设计 | system_design.md | 模块划分、核心类设计、约束实现段落、异常处理设计、覆盖矩阵 |
| 架构图 | class_diagram.mmd + state_diagram.mmd + activity_diagram.mmd | 类图、状态图、活动图（Mermaid 格式） |
| 测试用例 | test_cases.json + test_cases.md | 正常路径、边界条件、异常路径三类测试 |
| 追溯矩阵 | traceability_matrix.json | 约束→设计元素→测试用例的三层映射关系 |

**核心价值主张**：多阶段 pipeline + 三层防御（生成→评审→修复）+ 规则驱动调度，让每个约束都有设计实现、有测试验证、有追溯记录。

---

## 第二部分：系统架构（建议 4 页）

### 2.1 总体架构图

系统分为四层，从上到下：

**第一层：Plan（规划层）**

Plan 是整个 pipeline 的起点。它不靠 LLM 决定"先做什么后做什么"，而是用代码硬编码任务拆分逻辑。

Plan 阶段做三件事：
1. **RegistryExtractor（LLM 调用）**：从需求文档中提取业务实体、角色、功能
2. **ConstraintExtractor（LLM 调用）**：从需求文档中提取约束候选
3. **buildDeterministicPlan（代码逻辑）**：基于预提取结果，拆分出固定结构的任务列表并设置依赖关系

**设计理念**：流程决策从 LLM 手里拿走，用代码保证 pipeline 结构稳定。LLM 只负责内容生成，不负责流程决策。

**第二层：Orchestrator（调度引擎）**

Orchestrator 是整个系统的大脑。决策机制采用**规则优先 + LLM 兜底**的双层策略：

- **13 条确定性策略**（零 LLM 调用），按优先级匹配：work-running / rejected-artifacts / convergence-stalled / final-review / failed-regenerate / forward-progress 等
- **LLM 兜底（StrategyBrain）**：当 13 条规则都没命中时，才调用 LLM

**设计理念**：90% 的调度决策是纯代码规则，零成本、零延迟、零不确定性。

**第三层：Generator + Evaluator + Repair（三层防御闭环）**

每个任务经历三个阶段，形成收敛闭环：

- **Generator（生成）**：LLM 生成产物 + 自检（完整性校验）+ 重试
- **Evaluator（评审）**：规则检查（零 LLM）+ LLM 语义评审 → 输出 Verdict（issue 列表）
- **Repair（修复）**：确定性修复优先（零 LLM）→ LLM 兜底 → 收敛控制（blocker 门控 + 轮次上限 + 趋势检测）

闭环：生成 → 评审 → 修复 → 再评审 → 收敛

**第四层：Persistence（产物持久化）**

双层写入：
- **by_task/（中间产物）**：每个任务完成后立即落盘，崩溃不丢失
- **顶层（最终产物）**：质量门通过后写完整快照

### 2.2 Pipeline 数据流

```
需求文档 → Plan（预提取 + 任务拆分）
→ Analyze（LLM 提取功能/约束/异常 → analysis.json）
→ Design（LLM 生成约束实现 + 模块/类/覆盖矩阵 → system_design.md）
→ Diagrams（LLM 生成 class/state/activity 图）
→ Tests（LLM 按功能/约束/异常分组生成测试）
→ Review（规则检查 + LLM 语义评审）
→ Repair（确定性修复优先 + LLM 兜底）
→ 最终产物
```

### 2.3 横切关注点

- **ID 系统**：约束 C001、功能 F001、异常 X001，在 merge 阶段统一分配
- **增量持久化 + Resume**：中断后恢复
- **收敛机制**：blocker 门控 + 轮次上限（maxRepairPerTask=4, maxRegeneratePerTask=1, maxReplanCount=2）+ 趋势检测

---

## 第三部分：各组件详细介绍（建议 6 页）

### 3.1 Plan（规划）—— 确定性骨架

**输入**：需求文档（Markdown）

**处理流程**：
1. RegistryExtractor（LLM）→ 提取实体、角色、功能
2. ConstraintExtractor（LLM）→ 提取约束候选（含描述、原文片段、类型、关联功能）
3. buildDeterministicPlan（代码）→ 拆任务 + 串依赖

**输出**：ExecutionPlan（analyze-N → design-1 → diagrams-{class,state,activity} → tests-1）

**价值**：流程决策用代码保证，LLM 只负责内容生成。

### 3.2 Analyze（需求分析）—— 结构化需求模型

**输入**：需求文档 + Plan 预提取的候选

**处理流程**：
1. LLM 提取功能/约束/异常/实体 → analysis JSON
2. Merge（多分片合并）+ canonicalizeConstraintsPipeline（ID 规范化 + 去重 + missing 候选提升）
3. source_text 修复（缺失时 LLM 从原文找回）

**输出**：analysis.json

**质量保障**：REQUIRED_FIELDS 校验 + analysisQualityGate（9 项检查）

### 3.3 Design（系统设计）—— 约束驱动的深度设计

**输入**：analysis.json

**处理流程**：
1. buildDesignBrief（代码）→ 精简设计简报（minimize：compactList/publicIdsOnly/termsOverlap）
2. LLM 生成 DesignModel JSON：constraintImplementations（每约束含实现机制/触发/处理/参数/影响模块类）+ exceptionImplementations + modules + classes + coverageMatrix + dataFlows
3. 自检 + 重试：parseDesignModel（容错）→ validateDesignModel（结构完整性）→ checkCoverageGaps（每个约束有具体实现）→ reconcileDesignModel（确定性修复悬空引用）
4. renderDesignMarkdown → system_design.md

**输出**：system_design.md + DesignModel JSON

**质量保障**：coverage gap 检测 + dataFlow null 检查 + 类图悬空类补全 + 参数保真校验

### 3.4 Diagrams（架构图）—— 三类 Mermaid 图

**输入**：system_design.md + DesignModel JSON

**处理流程**：
1. 类图（class_diagram.mmd）：LLM 基于 classes + entities → classDiagram（类名/属性/方法/继承/关联）
2. 状态图（state_diagram.mmd）：LLM 基于 exceptionImplementations + 业务流程 → stateDiagram-v2（复合状态/转换/标注约束异常 ID）
3. 活动图（activity_diagram.mmd）：LLM 基于业务流程 → flowchart（流程步骤/分支/异常子图）

**质量保障**：类图悬空类检测 + 确定性补类（_patchMissingClassDefinitions）+ Mermaid 语法校验 + 三图一致性

### 3.5 Tests（测试生成）—— 分组覆盖 + 质量校验

**输入**：analysis.json + system_design.md

**处理流程**：
1. buildTestPlan（代码）→ 按功能/约束/异常构建任务（正常 TC-N / 边界 TC-B / 异常 TC-E）→ 按模块分组
2. LLM 生成 → 每个测试含 id/type/target/preconditions/steps/expected_result/priority
3. mergeGroupResults → 跨组统一编号 + 语义去重（_dedupTestCases）
4. testQualityValidator → 幻觉 ID 检测 + 模板检测 + canonical_only_target 检测 + target_content_alignment

**输出**：test_cases.json + test_cases.md

### 3.6 Review + Repair（评审与修复）—— 收敛闭环

**Review**：
1. 规则检查（零 LLM）：命名一致性/功能覆盖/约束覆盖/Mermaid 语法/测试 target 格式/实体关系完整性
2. LLM 语义评审（quick/deep）：设计质量/测试有效性/产物间一致性 → issue 列表（blocker/major/minor）

**Repair**：
1. 确定性修复优先（零 LLM）：命名修正/类图补类/ID 修正/source_text 补全
2. LLM 兜底：patch 模式修补 → 再评审
3. 收敛控制：blocker 必须清零 + 轮次上限 + 趋势检测 + maxConvergenceRounds=6

---

## 第四部分：Benchmark 设计（建议 4 页）

### 4.1 对比方案

- **Baseline**：单轮强 prompt LLM（同一模型/配置，明确角色+产出要求+schema+质量指引，但不给 pipeline 结构）
- **Agent**：完整 ReqDesign 多阶段 pipeline
- **Judge**：同一个 LLM，evidence-based 评分

### 4.2 评分体系

**Sanity Gate（前置门槛）**：产物不完整 = N/A，不进打分

**四个维度**：

| 维度 | 权重 | 评什么 | 怎么评 |
|---|---|---|---|
| Gold Obligation Coverage | 40% | 约束/功能/异常在 design 里有没有具体实现证据 | evidence extraction + rubric 0-3 |
| Traceability Truthfulness | 20% | design 证据和 test 证据能否连成可信链 | design_supported && test_supported && design_test_aligned |
| Test Effectiveness | 20% | 测试有没有可判定 assertion | has_test_alignment |
| Design Depth | 20% | design 有没有具体业务规则 | has_concrete_rule + trigger + handling |

**Rubric（0-3）**：0=无证据；1=只有ID/关键词；2=有具体规则但测试未对齐；3=规则+触发+处理+测试对齐

**铁律（代码强制）**：没evidence→0；只有ID→≤1；没testable rule→不给2；没test alignment→不给3；矛盾→≤1

### 4.3 Gold Contract

每个 obligation 含：id / type / severity / source_span（逐字摘录）/ expected_design_evidence / expected_test_evidence / anti_patterns

| case | 领域 | 需求行数 | gold obligations |
|---|---|---|---|
| ecommerce_order_system | 电商订单 | 279 | 12 |
| smart_campus | 智慧校园 | 144 | 11 |
| pure_qheadache | 健康问卷 | 70 | 11 |
| pure_keepass | 密码管理 | 69 | 10 |
| mid_complex_system | 图书馆管理 | 119 | 8 |

配置：模型 qwen3.5-flash，max_tokens 65536，Judge 同模型。

---

## 第五部分：实验结果（建议 4 页）

### 5.1 总体对比

| case | 领域 | baseline | agent | delta | 赢家 |
|---|---|---|---|---|---|
| pure_qheadache | 健康问卷 | 46.7 | **100.0** | +53.3 | AGENT |
| ecommerce_order_system | 电商订单 | 32.7 | **87.8** | +55.1 | AGENT |
| smart_campus | 智慧校园 | 61.8 | **86.1** | +24.3 | AGENT |
| mid_complex_system | 图书馆管理 | 51.7 | **71.7** | +20.0 | AGENT |
| pure_keepass | 密码管理 | 61.3 | **71.3** | +10.0 | AGENT |
| **平均** | | **50.8** | **83.4** | **+32.5** | **AGENT 5/5** |

### 5.2 各维度平均 delta

| 维度 | 平均 delta | 解读 |
|---|---|---|
| Test Effectiveness | **+66.8** | agent 最大优势——多阶段测试生成+质量校验远超单轮 |
| Traceability | **+56.4** | agent 的追溯矩阵+evidence-based 评分让链可验证 |
| Coverage | **+19.3** | agent 约束实现段落更完整 |
| Design Depth | **+0.8** | 基本持平——baseline 单轮深度也不差 |

### 5.3 各维度详细数据

| case | 维度 | baseline | agent | delta |
|---|---|---|---|---|
| ecommerce | coverage | 44.4 | 83.3 | +38.9 |
| ecommerce | traceability | 8.3 | 83.3 | +75.0 |
| ecommerce | test_eff | 8.3 | 100.0 | +91.7 |
| ecommerce | design_depth | 58.3 | 88.9 | +30.6 |
| smart_campus | coverage | 72.7 | 87.9 | +15.2 |
| smart_campus | traceability | 36.4 | 81.8 | +45.4 |
| smart_campus | test_eff | 36.4 | 81.8 | +45.4 |
| smart_campus | design_depth | 90.9 | 90.9 | 0.0 |
| mid_complex | coverage | 66.7 | 66.7 | 0.0 |
| mid_complex | traceability | 12.5 | 62.5 | +50.0 |
| mid_complex | test_eff | 12.5 | 87.5 | +75.0 |
| mid_complex | design_depth | 100.0 | 75.0 | -25.0 |
| pure_keepass | coverage | 73.3 | 73.3 | 0.0 |
| pure_keepass | traceability | 30.0 | 60.0 | +30.0 |
| pure_keepass | test_eff | 30.0 | 70.0 | +40.0 |
| pure_keepass | design_depth | 100.0 | 80.0 | -20.0 |
| pure_qheadache | coverage | 57.6 | 100.0 | +42.4 |
| pure_qheadache | traceability | 18.2 | 100.0 | +81.8 |
| pure_qheadache | test_eff | 18.2 | 100.0 | +81.8 |
| pure_qheadache | design_depth | 81.8 | 100.0 | +18.2 |

### 5.4 关键发现

1. **Test Effectiveness 是 agent 最大优势（+66.8）**：多阶段 pipeline 的分组测试生成 + 质量校验 + 幻觉检测 + 语义去重远超单轮。典型案例：ecommerce 100.0 vs 8.3
2. **Traceability 大幅领先（+56.4）**：agent 天然产生约束→设计→测试追溯链。典型案例：pure_qheadache 100.0 vs 18.2
3. **Coverage 稳定领先（+19.3）**：agent 为每个约束写独立实现段落
4. **Design Depth 基本持平（+0.8）**：baseline 单轮深度本身不差，agent 优势在覆盖更全+可追溯+测试对齐
5. **agent 5/5 全面赢 baseline，平均赢 32.5 分**

### 5.5 典型案例：ecommerce_order_system

- 需求：电商订单系统，279 行，12 个约束
- baseline（32.7）：架构概览+SQL+状态机，但测试几乎无效（8.3），追溯断裂（8.3）
- agent（87.8）：12 个约束各写独立实现段落，测试全覆盖（100.0），追溯完整（83.3）
- 差距来源：agent 保证了每个约束都有"设计实现+测试验证+追溯记录"

---

## 第六部分：总结与展望（1 页）

### 总结
- 多阶段 pipeline 在 5/5 case 上全面赢 baseline，平均赢 32.5 分
- 核心优势：Test Effectiveness（+66.8）和 Traceability（+56.4）
- 关键架构：三层防御（生成→评审→修复）+ 规则驱动调度（13 条确定性策略）

### 展望
- 约束权威架构重构（registry-authoritative）
- 多次运行取平均
- 更多 case + 更强模型适配

---

## 附录：PPT 制作建议

### 页数分配
| 部分 | 页数 |
|---|---|
| 问题定义 | 1-2 |
| 系统架构 | 3-4 |
| 各组件介绍 | 5-6 |
| Benchmark 设计 | 3-4 |
| 实验结果 | 3-4 |
| 总结展望 | 1 |
| 合计 | 16-21 |

### 视觉建议
- 架构图：从上到下分层，三层防御用环形箭头表示闭环
- 数据图：总分柱状图 + 四维雷达图
- 主色调：深蓝（技术）+ 橙色（强调）
