# PROBLEM.md — ReqDesign-Agent 输出质量问题

> 生成日期：2026-06-03
> 项目：ReqDesign-Agent（AI 需求设计助手）
> 目标读者：LLM 应用工程师 / Agent 架构师

---

## a. 系统是做什么的

ReqDesign-Agent 是一个**多步骤 LLM 管道系统**：用户输入一份自然语言需求文档，系统自动输出结构化分析（实体、功能、约束、异常）、系统设计文档、Mermaid 图表和测试用例。它面向软件开发团队，将需求文档从"自然语言"转化为"可执行的设计规格"。

系统核心流程是：需求文档 → 分析（analyze） → 设计（design） → 图表（diagrams） → 测试（tests），中间有评审（review）和修复（repair）循环。所有步骤由 LLM（当前使用 DeepSeek-V3）驱动，通过 prompt 模板控制输出格式和质量。

---

## b. 相关架构

```
需求文档 → RegistryExtractor → RequirementAnalyzer (×N 并行)
                    ↓                        ↓
              实体/角色注册表          分析产物 (JSON)
                    ↓                        ↓
                    └──── AnalyzeMerger ←─────┘
                              ↓ (preMerge + postProcess LLM)
                              ↓ (ConstraintExtractor)
                              ↓ (ConstraintCanonicalizer)
                     analysis.json (统一分析结果)
                              ↓                    ↓
                     SystemDesigner          DiagramGenerator
                              ↓                    ↓
                     design.md              diagrams.json
                              ↓                    ↓
                              └──── TestCaseGenerator ←────┘
                                          ↓
                                  test_cases.json
                                          ↓
                                  Evaluator (LLM 评审)
                                     ↙        ↘
                               Repair (LLM)   通过/拒绝
                                    ↓
                              修复后的产物 → 回到 Evaluator
```

### 关键模块说明

| 模块 | 职责 |
|------|------|
| **RegistryExtractor** | 从需求文档中预提取实体/角色注册表，作为后续分析的命名锚点 |
| **RequirementAnalyzer** | LLM 驱动的需求分析，从文档提取 functions/entities/constraints/exceptions |
| **AnalyzeMerger** | 合并多份分析结果（preMerge 程序化并集 + postProcess LLM 补全） |
| **ConstraintExtractor** | 从需求文档中提取原子约束候选项（temperature=0） |
| **ConstraintCanonicalizer** | 对约束去重、分配 ID、关联功能（程序化，无 LLM） |
| **SystemDesigner** | 基于分析 JSON 生成 Markdown 设计文档 |
| **TestCaseGenerator** | 基于分析 JSON + 设计文档生成结构化测试用例 |
| **Evaluator** | LLM 评审员，检查产物质量，输出结构化 issues |
| **Repair** | 根据 Evaluator 的问题列表，用 LLM 生成修复 patch |

### 问题出在哪些环节

- **去重失败**：AnalyzeMerger + ConstraintCanonicalizer（P0）
- **测试用例质量差**：TestCaseGenerator + Repair（P1）
- **设计浮于表面**：SystemDesigner prompt（P2）
- **引用错误**：ConstraintCanonicalizer 关联逻辑 + canonicalizer ID 映射（P3）

---

## c. 问题是什么

### 一句话概括

ReqDesign-Agent 管道已经能跑通，但**输出产物存在系统性质量问题**：分析结果不去重、测试用例模板化且质量不足、设计文档缺乏深度、约束引用错乱。8 个 review issues（5 major, 3 minor）中虽约束覆盖完整，但 17/31 个边界测试为模板化生成。

### 现象（具体数据）

以最新 E2E 运行（cctns-final-v2，CCTNS 案件管理系统需求）为例：

**P0: 去重失败 — 28 个约束中有多组语义重复（约束、异常、功能、实体关系、业务流程均受影响）**
- X002（"用户尝试访问无权限的案件"）、X009（"Unauthorized access attempt"）、X010（"Unauthorized access attempt"）描述同一件事 → 3 条异常应合并为 1 条（其中 X009 和 X010 描述完全相同）
- Case 实体关系里，Suspect 同时有 name 引用（`-> Suspect`）和 entityRef 引用（`-> E_SUSPECT`）两条重复关系。Property、Document 同理
- `FUN_SEARCH_CASE` (F009) 的 sub_capabilities 里 `"SimpleSearch"` 和 `"Simple search"` 语义重复，`"AdvancedSearch"` 和 `"Advanced search"` 同理 → 2 组重复
- business_processes 中"案件注册流程"和 `"CaseRegistration"` 可能描述同一流程（因为 `_mergeByName` 按小写匹配，但中英文不匹配），`"DefectTrackingProcess"` 和 `"DefectReporting"` 同理
- C004（"UI customizations must be saved in user profile"）和 C019（"User interface customizations must be saved in the user profile"）来自几乎相同的源文本 → 2 条约束应合并为 1 条
- C013（"Secure data transmission with SSL"）和 C023（"系统应支持HTTPS作为通信协议"）语义等价（均关于 SSL 安全传输） → 2 条约束应合并为 1 条
- C022（"Audit trail data cannot be modified"）和 C024（"系统必须维护不可更改的审计跟踪"）语义重复（均关于审计跟踪不可修改性，C024 的源文本包含 C022 的源文本） → 2 条约束应合并为 1 条

**P1: 测试用例质量差 — 52 个测试用例（12 正常 + 9 异常 + 31 边界），8 个 review issues（5 major, 3 minor）**
- 10 个异常（X001-X010）均有测试覆盖，但 X009 和 X010 描述完全相同（均为 "Unauthorized access attempt"），说明异常本身未去重
- 10 个功能（F001-F010）均有测试覆盖，但 review 指出 Help Module（F010 TrackDefect）测试不充分
- 28/28 个约束均有边界测试覆盖，但 TC-B-015 至 TC-B-031（17 个）为模板化生成（步骤仅为"尝试违反[约束ID]约束"，无实际测试逻辑）

**P2: 设计文档浮于表面**
- 无数据库 schema 设计
- 无部署架构说明
- 无认证/授权详细设计
- 约束实现描述是一句话（"系统必须确保..."）无技术方案

**P3: 引用错误**
- C006（搜索懒加载）错误关联到 `FUN_MANAGE_USER_PROFILE`
- C010（上下文帮助）只关联了用户管理功能
- canonicalId 混乱：约束用 hash（如 `CON_FUNC_9IC67N00`），而功能用可读名（`FUN_SEARCH_CASE`），不一致

### 影响

- **下游使用者（开发团队）** 无法信任自动化输出，需要人工逐条检查和修复
- **信任度**：每轮运行 8 个 issues，虽然 `passed=false` 但 `acceptedNoBlockers=true`（即因无阻断性问题而被接受），实际质量远未达标
- **修复成本**：人工修正一份输出可能比重写更快

### 为什么重要

如果不解决，这个系统只能作为 demo 使用，无法进入实际工作流。解决后的收益是：需求 → 设计的自动化管道真正可用，节省 60-80% 的需求分析时间。

---

## d. 根因分析

### 1. 已确认的根因

#### 根因 A: 去重只做字面匹配，无语义理解

**证据**：`ConstraintCanonicalizer`（`src/shared/constraintCanonicalizer.ts`）的去重逻辑：

```typescript
// 第 96-103 行：去重只用 normalizeForComparison 字面匹配
const normSource = normalizeForComparison(rawSource);
const normDesc = normalizeForComparison(rawDesc);
// Layer 1: sourceText match
if (normSource) {
  groupIdx = sourceTextIndex.get(normSource);
}
// Layer 2: description match (only if no sourceText match)
if (groupIdx === undefined && normDesc) {
  groupIdx = descIndex.get(normDesc);
}
```

`normalizeForComparison` 只做大小写+标点+空格归一化，不处理：
- 中英文翻译等价（"未授权访问" ≈ "Unauthorized access"）
- 描述粒度差异（"用户尝试访问无权案件" ≈ "Unauthorized case access attempt"）
- 子集关系（"Unauthorized access attempt" ⊂ "Unauthorized case access attempt"）

同理，`AnalyzeMerger._mergeByExceptionRef`（`src/generators/merge.ts`）的 exception 去重只按 `source_text` 字面匹配。

**结果**：X002/X009/X010 三个异常逃过去重。

#### 根因 B: Case 实体关系重复 — preMerge 逻辑缺陷

**证据**：Case 实体同时有两条到 Suspect 的关系：

```
-> Suspect one-to-many 案件关联的嫌疑人       (name 引用)
-> E_SUSPECT one-to-many Case can have multiple suspects  (entityRef 引用)
```

原因：`AnalyzeMerger._mergeEntities` 的关系去重（`_mergeEntityInPlace`）用 `target+type` 作为去重键：

```typescript
// merge.ts 第 ~340 行
const relKey = `${String(r.target ?? "")}|${String(r.type ?? "")}`;
```

`Suspect` 和 `E_SUSPECT` 的 target 不同，所以不被去重。preMerge 之前，不同分析分片可能分别用 name 引用和 entityRef 引用生成关系。

#### 根因 C: 测试用例模板化 — prompt 和 repair 双重不足

**证据**：

1. **TestCaseGenerator prompt 问题**：`prompts/test_case.md` 虽然在合同（contract）中列出了所有功能/约束/异常 ID，但 LLM 在实际生成时倾向于生成"它理解的"测试，而不是机械地覆盖每个 ID。52 个测试用例覆盖了 10/10 功能和 28/28 约束，但 17 个边界测试（TC-B-015 至 TC-B-031）为模板化生成，缺乏实际测试逻辑。

2. **Repair 修复低效**：repair prompt（`prompts/repair.md`）生成了 JSON ops patch 来修复，但：
   - repair 的 LLM 倾向于生成模板化测试（`["检查数据传输方式"]` 一句话步骤）
   - repair 只修复被报告的问题，不提升已有测试的质量
   - 多次 repair 迭代会累积低质量测试而不替换

#### 根因 D: 约束 canonicalId 使用 hash，不可读且不利于去重

**证据**：中文约束的 canonicalId 是 hash（如 `CON_FUNC_9IC67N00`），因为 `textToCanonicalId` 对中文文本无法提取英文关键词：

```typescript
// canonicalizer.ts 第 ~200 行
function textToCanonicalId(prefix: string, text: string): string {
  if (/^[A-Za-z]/.test(text)) {
    // 英文：提取关键词
  }
  // 中文：用 hash
  return `${prefix}_${hash}`;
}
```

这导致：
- displayId 和 canonicalId 完全脱节（C001 → CON_FUNC_9IC67N00）
- 无法通过 ID 理解约束内容
- review 报告中需要写完整 canonicalId，冗长且不可读

### 2. 怀疑但不确定的根因

#### 怀疑 A: analyze 阶段 LLM 仍在自行造约束（置信度：中）

ConstraintExtractor 已经用 temperature=0 提取了约束候选，但 `RequirementAnalyzer` 的 analyze prompt 仍然要求 LLM 提取 constraints。虽然 `merge_post_process.md` prompt 声称只补全缺失约束，但 analyze 阶段的 LLM 可能也在生成约束，导致两套约束来源不一致。

**依据**：分析结果中有英文约束（如 "Multilingual interface support must be implemented"），这不像是从中文需求文档直接提取的，更像是 LLM 推理生成的。

#### 怀疑 B: postProcess LLM 补全会引入新约束（置信度：高）

`merge_post_process.md` 的约束补全逻辑会追加约束到 merged 结果中。虽然有 description 去重（字面匹配），但语义等价的约束（中英翻译不同）会逃过去重。

**依据**：analysis.json 中有 28 个约束，但 ConstraintExtractor 提取的候选数量不同（commit `c7f07a3` 提到从 10 到 117 不等），说明 analyze + postProcess 的 LLM 补全可能在 ConstraintExtractor 之外额外生成约束。

#### 怀疑 C: by_task/ 目录残留影响（置信度：低）

by_task/ 目录不清除旧文件，多次运行可能让 repair 读取到旧版本产物。但这更可能是运维问题而非根因。

### 3. 已排除的可能原因

- ~~LLM 模型能力不足~~：同一模型在单步任务（如 generate design）表现良好，问题出现在多步骤协调和去重逻辑，不是模型推理能力的问题。
- ~~Prompt 模板格式错误~~：所有 prompt 模板语法正确，placeholder 替换正常工作。
- ~~JSON 解析失败~~：已修复 code fence stripping（commit `4b69735`），所有产物都能正确解析。

---

## e. 已经尝试过的方案

### 1. 设置 temperature=0（commit `c7f07a3`）
- **做了什么**：ConstraintExtractor 的 LLM 调用从默认 temperature 改为 0
- **效果**：候选提取数量从 10-117 波动稳定到固定值
- **不足**：只稳定了 ConstraintExtractor，analyze 和 postProcess 的 LLM 调用仍然 temperature=0.3

### 2. 修复 JSON ops repair 机制（commits `13667df`, `4b69735`）
- **做了什么**：统一 JSON patch 系统 + 修复 code fence stripping
- **效果**：repair 现在能正确解析 JSON 产物并执行 replace/append/delete 操作
- **不足**：repair 生成的测试用例质量仍低（模板化步骤）

### 3. 约束爆炸防护（commit `bb395ef`）
- **做了什么**：section 过滤注入 + prompt scoping + planner 反约束任务
- **效果**：约束数量从爆炸级别降到合理范围
- **不足**：仍然有语义重复约束逃过

### 4. 禁用 analyze-constraints 自动注入（commit `b1ea967`）
- **做了什么**：移除 analyze 阶段自动注入约束任务的逻辑，改为 ConstraintExtractor 专门处理
- **效果**：减少了约束重复来源
- **不足**：postProcess LLM 仍在补全约束

### 5. Function Registry + Review Validator（commit `4743f3c`）
- **做了什么**：确定性验证规则（ID 覆盖检查、格式检查）
- **效果**：能检测出覆盖不足的问题
- **不足**：只检测不修复，repair 修复质量不够

### 6. LLM 功能去重禁用（merge.ts 注释）
- **做了什么**：曾尝试让 LLM 判断功能语义重复并合并，但误删了 BasicSearch（合并到 AdvancedSearch），已禁用
- **效果**：避免了误删，但也失去了语义去重能力

---

## f. 当前卡在哪

### 核心不确定点 1：语义去重应该在哪一层做？

当前架构有三个可能的去重时机：
1. **ConstraintExtractor 输出后**（候选阶段）——此时还没有全局 ID，可以用 embedding 或 LLM 判断语义等价
2. **ConstraintCanonicalizer 内部**（程序化阶段）——当前只做字面匹配，可扩展为语义匹配
3. **postProcess LLM 阶段**——让 LLM 在补全约束时同时去重（但 LLM 去重不可靠，已证明过会误删）

**纠结点**：如果用 LLM 做语义去重，成本高、延迟大、可能误删。如果不用 LLM，需要设计足够好的程序化规则（中英文词典、子集关系检测等）。哪种方案性价比更高？

### 核心不确定点 2：测试用例模板化是 prompt 问题还是架构问题？

当前 28/28 约束已有边界测试覆盖，但 TC-B-015 至 TC-B-031（17 个）为模板化生成（步骤仅为"尝试违反[约束ID]约束"）。两种假说：
- **Prompt 问题**：test_case.md 的 prompt 未能引导 LLM 为每个约束生成有意义的测试步骤，修复 prompt 即可
- **架构问题**：Repair 阶段追加的测试用例倾向于模板化（直接引用约束 ID 作为步骤），单次 LLM 调用无法为 28+ 个约束同时生成高质量测试，需要改为按约束分批生成

如果是架构问题，需要重新设计 TestCaseGenerator 的内部流程（按约束/功能分组调用 LLM），这是一个较大的改动。

---

## g. 约束条件

### 不能改什么

- **LLM 提供商**：当前使用华为 ModelArts 的 DeepSeek-V3，不能切换到 OpenAI/Anthropic
- **管道主干流程**：analyze → merge → design → diagrams → tests → review → repair 的顺序不能打破
- **JSON 产物格式**：下游消费者（benchmark scorer）依赖 analysis.json / test_cases.json 的字段结构
- **单次运行成本**：不能让 LLM 调用次数翻倍以上

### 必须保持什么

- **实体注册表机制**：RegistryExtractor + entityRef 是核心锚点，不能移除
- **Contract 机制**：各 Generator 的 buildDesignContract / buildTestContract 确保 ID 一致性
- **Review + Repair 循环**：至少保留 1 轮 review-repair
- **config.yaml 兼容**：现有配置格式不能破坏

---

## 附录：问题汇总表

| 优先级 | 问题 | 数量 | 根因模块 |
|--------|------|------|----------|
| P0 | 异常语义重复（X002/X009/X010） | 3→1 | AnalyzeMerger |
| P0 | 约束语义重复（C004/C019, C013/C023, C022/C024） | 3 组 | ConstraintCanonicalizer |
| P0 | 功能子能力重复（SimpleSearch/Simple search, AdvancedSearch/Advanced search） | 2 组 | AnalyzeMerger._mergeFunctions |
| P0 | 实体关系重复（name vs entityRef） | 3 实体 | AnalyzeMerger._mergeEntityInPlace |
| P1 | 异常未去重（X009/X010 描述完全相同） | 2/10 | AnalyzeMerger |
| P1 | 功能测试不充分（F010 TrackDefect review 指出不足） | 1/10 | TestCaseGenerator |
| P1 | 边界测试模板化（TC-B-015~TC-B-031 无实际测试逻辑） | 17/31 | TestCaseGenerator + Repair |
| P1 | 缺少 Help/Audit Module 测试充分性 | 2 项 | TestCaseGenerator |
| P2 | 缺少数据库 schema | 1 | SystemDesigner prompt |
| P2 | 缺少部署架构 | 1 | SystemDesigner prompt |
| P2 | 缺少认证设计 | 1 | SystemDesigner prompt |
| P2 | 约束实现一句话 | ~28 | SystemDesigner prompt |
| P3 | 约束关联功能错误 | 2+ | ConstraintCanonicalizer.linkFunctions |
| P3 | canonicalId 不可读 | ~20 | canonicalizer.textToCanonicalId |
