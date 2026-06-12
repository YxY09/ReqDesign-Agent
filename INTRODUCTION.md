# ReqDesign-Agent 技术内幕

## 1. 系统做什么

输入一份自然语言需求文档，输出一套完整的设计文档——需求分析 JSON、系统设计 Markdown、Mermaid 图表、测试用例。中间经过 Planning → Generation → Evaluation → Repair 的闭环，每个制品都有质量门控。

```
需求文档 (Markdown/XML)
    |
    v
ReqDesign-Agent
    |
    +-- requirement/analysis.json    结构化需求（实体、功能、约束、异常）
    +-- design/system_design.md      系统设计（模块、接口、数据流）
    +-- diagrams/*.mmd               Mermaid 图表（类图、活动图、状态图）
    +-- tests/test_cases.md          测试用例（正常/异常/边界）
    +-- review/result.json           审查报告
```

## 2. 整体架构

### 为什么是单 Agent 多 Tool

系统经历过 Multi-Agent 阶段。四个 Agent（Planner、Generator、Evaluator、Repair）各自维护状态，通过消息总线通信。问题是：状态散落在四个 Agent 之间，调试一个 bug 要追五条消息链；Agent 之间序列化上下文既慢又丢信息；每个 Agent 只看到局部上下文，推理链断裂。

解决方法：四个 Agent 降级为 Tool，由单一 LLM Agent 统一调度。Tool 不做推理，只做具体工作。编排决策集中在一个 Orchestrator 里。

代价是上下文窗口有限。当前通过拆分 Task 缓解——大文档分成多段并行分析，再合并。

### 架构图

```
+------------------------------------------------------------------+
|                       AgentOrchestrator                           |
|                       (编排决策中心)                               |
|                                                                  |
|  +------------------+    +------------------+                    |
|  | Deterministic-   |    | StrategyBrain    |                    |
|  | Policy           |    | (LLM 策略决策)    |                    |
|  | (规则引擎)        |    +------------------+                    |
|  +------------------+        |                                    |
|         |                    |                                    |
|         +-------+------------+                                    |
|                 |                                                 |
|                 v                                                 |
|          PolicyGuard (预算/门控)                                   |
|                 |                                                 |
|                 v                                                 |
|  +-----------+  +-----------+  +-----------+  +-----------+      |
|  | Planning  |  | Generation|  | Evaluation|  | Repair    |      |
|  | Tool      |  | Tool      |  | Tool      |  | Tool      |      |
|  +-----+-----+  +-----+-----+  +-----+-----+  +-----+-----+      |
|        |               |              |               |            |
|        v               v              v               v            |
|  ExecutionPlan    Artifact        Verdict        JsonPatch       |
+------------------------------------------------------------------+
                          |                   |
              +-----------+-----------+       |
              |                       |       |
              v                       v       v
+---------------------------+  +--------------------------+
| Generators                |  | Shared Modules           |
|                           |  |                          |
| +-- AnalyzeMerger         |  | +-- SemanticDeduper      |
| +-- RegistryExtractor     |  | +-- Constraint-          |
| +-- ConstraintExtractor   |  |     Canonicalizer        |
| +-- MermaidValidator      |  | +-- ReferenceNormalizer  |
| +-- TestPlanBuilder       |  | +-- RequirementNormalizer|
| +-- SystemDesigner        |  | +-- AnalysisQualityGate  |
| +-- DiagramGenerator      |  | +-- ReviewValidator      |
| +-- TestCaseGenerator     |  +--------------------------+
+---------------------------+
```

### 核心数据结构

数据在 Tool 之间流转的核心类型：

```typescript
// PlanningTool 的输出：任务列表 + 依赖关系
interface ExecutionPlan {
  tasks: Task[];
  goal: string;           // "design" | "analyze"
  registry?: EntityRegistry;
}

// 一个执行单元
interface Task {
  id: string;             // "analyze-1", "design-1", "diagrams-class"
  type: "analyze" | "design" | "diagrams" | "tests";
  dependsOn: string[];    // DAG 依赖
  contextHints: Record<string, unknown>;
  targeted?: boolean;     // 增量修复时只处理特定 Section
  targetIssues?: Issue[];
}

// GenerationTool 的输出：生成的制品
interface Artifact {
  taskId: string;
  type: TaskType;
  revision: number;
  content: unknown;       // JSON (analyze) | string (design/tests) | Record<string,string> (diagrams)
  selfCheckPassed: boolean;
}

// EvaluationTool 的输出：审查结果
interface Verdict {
  passed: boolean;
  issues: Issue[];
  fixes: Task[];          // 为 RepairTool 准备的修复任务
  evaluatedTaskIds: string[];
  isFinalReview: boolean;
}

// Orchestrator 的输出：下一步动作
interface RuntimeAction {
  action: "spawn" | "repair" | "regenerate" | "replan"
        | "save" | "finish" | "pause";
  taskId: string;
  reason: string;
}
```

数据流转路径：`ExecutionPlan → Task[] → GenerationTool → Artifact[] → EvaluationTool → Verdict → RepairTool → Artifact' (循环)`

## 3. 主循环详解

### 状态机

`runtime.ts` 的主循环是一个有限状态机，每轮迭代执行三步：

```
+------------+     +----------------+     +----------------+
| 1. Drain   |---->| 2. Decide      |---->| 3. Dispatch    |
| Backend    |     | (Orchestrator) |     | (ActionHandler)|
| Complete   |     |                |     |                |
+------------+     +----------------+     +----------------+
     ^                                           |
     |                                           v
     |                                    +-------------+
     +------------------------------------| Backend     |
                                          | Execution   |
                                          +-------------+
```

1. **Drain**：收集 Backend 已完成的 Worker 通知，更新 `WorkflowState`（制品、状态、Verdict）
2. **Decide**：`Orchestrator.decide(state, mailbox)` → 返回 `RuntimeAction`
3. **Dispatch**：按 `RuntimeAction.action` 分发到对应 handler

退出条件（按优先级）：

| 条件 | 动作 |
|------|------|
| 运行时间超预算 | `markPartial` + break |
| 决策次数超预算 | `markPartial` + break |
| 连续 3 次无可用动作且无 inflight | `markPaused` + break |
| `save`/`finish`/`pause` action | break |

### 编排策略：DeterministicPolicy vs StrategyBrain

`Orchestrator.decide()` 的决策链：

```
State Snapshot
     |
     v
DeterministicPolicy.decide(snapshot)
     |
     |-- 返回 StrategyDecision?  → 确定性路径（不调 LLM）
     |-- 返回 null?               → 交给 StrategyBrain（调 LLM）
                                       |
                                       v
                                  PolicyGuard.validate()
                                       |
                                       v
                                  ActionCompiler.compile()
                                       |
                                       v
                                  RuntimeAction
```

**DeterministicPolicy** 用 16 条规则覆盖所有可确定的情况。核心规则（按优先级）：

```
规则 1:  有 replan 产出的就绪修复任务  → advance_ready_work
规则 2:  有 failed task               → regenerate_downstream
规则 3:  有 rejected artifact          → repair_local_artifact
规则 4:  全局卡死                      → escalate_to_replan
规则 5:  收敛停滞（同指纹 >=3 轮）      → finish（问题减少）或 pause（问题不降）
规则 7:  初始状态，无 plan             → null（交给 StrategyBrain）
规则 11: 初始路由                      → null（StrategyBrain 决定 start_planning 或 route_direct_diagrams）
规则 12: 有 ready task                → advance_ready_work
规则 13: 最终审查条件满足              → run_final_review
规则 15: 质量门 + 保存门通过           → save_outputs
```

**StrategyBrain** 只在 DeterministicPolicy 返回 null 时启用。典型场景：初始路由（是走完整 Planning 还是直接画图）。LLM 根据请求复杂度自主选择快速路径（route_direct_diagrams）或完整路径（start_planning），简单的图表类请求可跳过 Planning 阶段。

**PolicyGuard** 是最后一道防线：预算控制（每 task 最多 4 次 repair、2 次 replan）、并发限制、保存门控。

### 收敛条件

什么时候停止迭代？三层判断：

1. **所有制品通过 Evaluation**：`Verdict.passed === true`，无 blocker/major issue
2. **收敛停滞但问题在减少**：同一组 issue 指纹连续 3 轮不变，趋势 decreasing 且 issue 数 <= 8 可 finish；趋势 non-increasing 且 issue 数 <= 10 也可 finish
3. **预算耗尽**：运行时间或决策次数超限 → markPartial

## 4. 四个 Tool 的实现细节

### PlanningTool

**输入**：需求文档文本 + goal

**内部流程**：

```
需求文档
    |
    v
RegistryExtractor (LLM)  →  EntityRegistry
    |
    v
ConstraintExtractor (LLM, temp=0)  →  ConstraintCandidate[]
    |
    v
LLM 生成 ExecutionPlan  →  Task[]
    |
    v
后处理：
  _splitDiagramTasks()   拆分 diagrams 为 class/activity/state 三个独立 Task
  _ensureOrder()         design 依赖所有 analyze，diagrams/tests 依赖所有 design
  _ensureSectionCoverage()  确保 XML 输入的每个 section 都分配到某个 analyze Task
```

**关键细节**：

- **依赖自动补全**：LLM 可能忘记声明依赖。`_ensureOrder()` 强制 design 依赖所有 analyze、diagrams/tests 依赖所有 design，保证执行顺序正确
- **Section 覆盖**：XML 输入有章节索引时，`_ensureSectionCoverage()` 检查所有 section 是否都分配给了某个 analyze Task，未分配的追加到负载最轻的 Task
- **约束注入**：ConstraintExtractor 预提取的约束候选注入到 analyze Task 的 `contextHints.availableConstraints`，按 Task 的 `assignedSections` 过滤，上限 30 条
- **Fallback**：LLM 规划失败时使用固定模板（analyze → design → diagrams × 3 → tests）

**输出**：`ExecutionPlan { tasks, registry }`

### GenerationTool

**输入**：`Task` + `context`（包含 `requirement_text`、`requirement_json`、`design_text`、`registry` 等）

**路由逻辑**：

```
task.type == "analyze"   → RequirementAnalyzer.analyze()
task.type == "design"    → SystemDesigner.generateDesign()
task.type == "diagrams"  → DiagramGenerator.generateClassDiagram/ActivityDiagram/StateDiagram()
task.type == "tests"     → TestCaseGenerator.generate()
```

图表路由细节：先查 `contextHints.diagram_kind`，再从 Task ID 和 description 推断。每个 Task 只生成一种图， diagrams 被 PlanningTool 拆成三个独立 Task。

**自检**（`_ruleCheck`，零 LLM 成本）：

| Task Type | 检查内容 |
|-----------|---------|
| analyze | 必须有 actors/functions/entities 字段；RequirementAnalyzer.validateResult() |
| design | 设计文本不为空；核心类覆盖率检查；异常 ID 引用合法性 |
| diagrams | Mermaid 头部正确；`<br/>` 标签检测；classDiagram 括号匹配 |
| tests | 结构化测试用例格式校验；异常 ID 引用合法性 |

自检问题被记录但**不会自动修复**。历史数据显示自检重试 6/6 全部失败。问题交给下游 Evaluate → Repair 循环处理。

**输出**：`Artifact { taskId, type, content, selfCheckPassed }`

### EvaluationTool

**输入**：`requirementText`、`requirementJson`、`designText`、`diagrams`、`testCases`、`artifactSnapshots`

**两阶段评估**：

```
制品快照 (snapshots)
    |
    v
+---------------------------+
| 阶段 1: 规则检查 (零 LLM) |
|                           |
| - 字段完整性              |
| - Mermaid 语法            |
| - 实体命名一致性          |
| - 功能 ID 一致性          |
| - 约束覆盖率              |
| - 业务流程覆盖率          |
+---------------------------+
    |
    v
+---------------------------+
| 阶段 2: LLM 语义评审      |
|                           |
| 模式选择:                  |
|   quick: snapshot <= 3    |
|   deep:  snapshot > 3     |
|                           |
| Prompt 构建:              |
|   - 原始需求摘要          |
|   - 制品快照 (截断)        |
|   - 前置门禁结果           |
+---------------------------+
    |
    v
Issue[] + scope 分类 (local/upstream/systemic)
```

**Issue 范围分类**：

- `systemic`：analyze blocker（影响所有下游）
- `upstream`：analyze 本身的问题（修复需重做 analyze）
- `local`：design/diagrams/tests 的问题（可通过 patch 修复）

**Verdict 结构**：`passed = blockers.length === 0`。major issue 不阻止通过但会触发修复。

**跨制品检查**（规则检查的一部分）：

- 命名一致性：需求分析中的实体名 vs 设计文本 vs 类图，检测重命名
- 功能 ID 一致性：设计/测试中引用的 Fxxx ID 必须在分析中存在（检测幽灵 ID）
- 约束覆盖率：每个约束必须有对应的边界测试
- 业务流程覆盖率：活动图必须覆盖分析中的所有业务流程

### RepairTool

**输入**：`Task`（带 `targetIssues`）、`currentContent`、`fixInstructions`

**修复策略**：

```
fixInstructions
    |
    v
+----------------------------------+
| Step 1: 确定性修复 (零 LLM)       |
|                                  |
| 模式匹配 issue description:       |
| - 命名不一致 → 字符串替换         |
| - 缺少类图实体 → 从 registry      |
|   注入类定义                      |
| - 约束未覆盖 → 追加测试用例模板   |
| - 幽灵功能 ID → 移除引用          |
+----------------------------------+
    |
    |-- 全部修复? → 返回 (跳过 LLM)
    |-- 部分/无法修复? ↓
    v
+----------------------------------+
| Step 2: LLM 修复                 |
|                                  |
| task.type == "analyze"           |
|   → full rewrite (JSON 结构)     |
|                                  |
| task.type == "design/tests"      |
|   → ops 模式:                    |
|     {"ops": [{"action":          |
|       "replace|append|delete",   |
|       "path": "...",             |
|       "match": {...},            |
|       "value": ...}]}            |
|                                  |
| task.type == "diagrams"          |
|   → section patch 模式           |
+----------------------------------+
    |
    v
+----------------------------------+
| 保护机制                         |
|                                  |
| - 测试用例去模板化检查            |
| - append→replace 转换            |
|   (避免重复测试)                  |
| - 输出长度 >= 原始 50%            |
| - 类定义丢失恢复 (safety net)     |
+----------------------------------+
```

**ArtifactPatcher 的 Section 操作**：

ArtifactPatcher 把制品拆成多个 Section（Markdown 按标题拆、JSON 按顶层 key 拆、diagrams 按 diagram kind 拆），支持三种操作：

```
replace_section  → 替换整个 Section 内容
insert_after     → 在指定 Section 之后插入新 Section
remove_section   → 删除指定 Section
```

对于 JSON 格式的测试用例（`{"test_cases": [...]}`），用 `ops` 格式操作：

```
replace  → match 某个 field=value 的条目，替换为 value
append   → 追加 items 到数组
delete   → 删除 match 的条目
```

**确定性修复 vs LLM 修复的分界线**：能用正则/模板/registry 查找解决的问题不调 LLM。具体来说：命名替换（正则）、缺少实体类定义（从 registry 取属性生成）、缺少约束测试（模板追加）、幽灵 ID 移除（正则）。只有需要语义理解的问题才走 LLM。

## 5. 生成器层的实现

### AnalyzeMerger

多段并行分析后的合并器。流程：

```
Artifact[] (多段分析结果)
    |
    v
preMerge() -- 程序化并集
    |
    | 按类型分别合并：
    |   actors:     按 actorRef 或 name 归一化去重
    |   entities:   按 entityRef 或 name 去重，属性 union
    |   functions:  按 name 去重，sub_capabilities union
    |   constraints: 按 constraintRef 或 source_text 去重
    |   exceptions: 按 exceptionRef 或 source_text 去重
    |   NFR:        按 category 去重（中英文映射）
    |   BP:         按 name 去重
    |
    v
_postProcess() -- LLM 补全 (1 次调用)
    |
    | 一个 prompt 同时完成：
    |   1. 关系补全（补充缺失的实体间关系）
    |   2. 约束补全（补充遗漏的约束 → missingConstraintCandidates）
    |   3. 关系实体补全（补充缺失的实体定义）
    |   功能语义去重已禁用（LLM 误删过 BasicSearch）
    |
    v
RequirementNormalizer.normalize()
    |
    v
canonicalizeAndLink() → 统一 ID 格式
    |
    v
canonicalizeConstraintsPipeline() → 约束去重+规范化
    |
    v
normalizeEntityIdentities() → 实体 ID 归一化 + 关系 target 去重
```

**实体合并的细节**：同名实体的属性取 union（按属性名去重，保留描述更长的版本），关系取 union（按 `normalizedTarget|normalizedType` 去重）。不同名但描述相似的实体（Jaccard < 0.3 且无包含关系）保持独立，加数字后缀。

### RegistryExtractor

流程开始前先用 LLM 扫描需求文档，提取全局实体/角色/功能注册表。

```typescript
interface EntityRegistry {
  entities: RegistryEntity[];   // {id: "E_CASE", canonicalName: "Case", aliases: ["案件", "Case Record"]}
  actors?: RegistryActor[];     // {id: "A_ADMIN", canonicalName: "Admin", aliases: ["管理员"]}
  functions?: RegistryFunction[];
}
```

为什么需要它：没有全局注册表时，不同分析轮次自由命名——第一轮叫"用户"，第二轮叫"系统用户"，第三轮叫"注册账户"。下游无法判断是否同一个东西。RegistryExtractor 提供统一的命名锚点，后续所有分析引用 registry ID（`entityRef`）而非自由文本。

### ConstraintExtractor

从需求文档中提取结构化约束候选。特点：

- **temperature=0**：保证提取结果稳定（之前 temperature=0.3 时候选数从 10 到 117 波动）
- **输出格式**：`ConstraintCandidate[]`，包含 description、sourceText、type/subtype、sectionId、relatedFunctionCandidates
- **与 analyze 阶段的关系**：ConstraintExtractor 是独立管道，不依赖 analyze 结果。提取的候选注入到 PlanningTool，再分发到各 analyze Task

### Mermaid 语法校验

`MermaidValidator` 做三层检查（纯同步，零 LLM）：

```
1. 结构检查
   ├── 头部声明正确（classDiagram / flowchart / stateDiagram-v2）
   ├── 声明类型与实际内容匹配
   └── 有实际内容（不只头部）

2. 括号匹配
   ├── ( ) [ ] { } 配对
   ├── 忽略注释 (%%) 和字符串内的括号
   └── 处理转义

3. 语义检查
   ├── classDiagram: 重复类定义、关系引用未定义类
   ├── flowchart: 重复节点 ID
   └── stateDiagram: 重复状态定义
```

LLM 自检 Mermaid 的历史记录：6/6 全部失败。自检机制已移除，语法问题交给 Evaluate → Repair 循环。

### TestPlanBuilder

测试计划的程序化规划器。不依赖 LLM。

```
analysis.json
    |
    v
对每个 function:
    1. 生成 1 个 normal task (覆盖正常流程 + sub_capabilities + acceptance_criteria)
    2. 如果 function 有相关约束 → 生成 1 个 boundary task

对每个未被 function 覆盖的 constraint:
    3. 生成独立 boundary task

对每个 exception:
    4. 生成 1 个 exception task

按 moduleContext 分组（每组 <=5 个 task）
```

每个 Task 都有明确的覆盖目标（`mustCover` 列表），下游 TestCaseGenerator 按 mustCover 逐条生成测试，避免"模板化"问题。

## 6. 去重与规范化管道

这是系统在中文需求场景下最难的部分。PROBLEM.md 的记录：17/31 模板测试中存在重复异常和重复约束。

### 管道顺序

```
Artifact 合并 (preMerge)
    |
    v
ReferenceNormalizer      ← 关系 target 归一化
    |
    v
SemanticDeduper          ← 约束/异常去重
    |
    v
ConstraintCanonicalizer  ← 约束规范化 + ID 分配
    |
    v
normalizeEntityIdentities ← 实体 ID 归一化
```

### SemanticDeduper：五层匹配

```
+---------------------------------------------------------------+
| Layer 1: same_source                                          |
| 归一化后的 sourceText 完全相同                                  |
| 置信度: 1.0 → 直接合并                                        |
+---------------------------------------------------------------+
| Layer 2: normalized_text                                      |
| 归一化后的 description 完全相同                                 |
| 置信度: 1.0 → 直接合并                                        |
+---------------------------------------------------------------+
| Layer 3: sourceText containment + keyword overlap             |
| 一个 sourceText 包含另一个 + Jaccard >= 0.8                   |
| 置信度: 1.0 → 直接合并                                        |
+---------------------------------------------------------------+
| Layer 4: glossary_equiv                                       |
| 两个文本命中同一个术语等价组且 >= 2 个术语                      |
| 置信度: 0.75 → 需要另一层确认                                  |
+---------------------------------------------------------------+
| Layer 5: token_overlap                                        |
| Jaccard token 重合度 >= 0.6                                    |
| 置信度: 浮动 → 需要另一层确认或 LLM 仲裁                       |
+---------------------------------------------------------------+
```

**Union-Find**：Layer 1-3 的得分 >= 0.8，直接用 Union-Find 做传递性合并（A≈B, B≈C → A,B,C 合并）。Layer 4-5 得分 < 0.8，需要互相确认或 LLM 仲裁。

**CJK 分词问题**：`tokenize()` 按空格分词。中文没有空格，整句话变成一个 token。Jaccard 相似度只能是 0 或 1。这就是为什么 Layer 4（术语等价表）对中文去重至关重要——它用 `text.includes(term)` 做子串匹配而非分词。

**术语等价表**（`DEFAULT_GLOSSARY`）示例：

```typescript
["ssl", "https", "secure transmission", "安全传输", "通信协议", "encrypted"]
["audit trail", "审计跟踪", "不可修改", "不可更改", "immutable"]
["unauthorized", "无权限", "未授权", "access denied", "权限"]
```

C004（"UI customizations must be saved in user profile"）和 C019（"User interface customizations must be saved in the user profile"）在 Layer 3 命中（sourceText 包含 + keyword overlap）。

### ConstraintCanonicalizer

多层规范化管道：

```
ConstraintCandidate[]
    |
    v
Step 1: SemanticDeduper 去重
    |   用 findDuplicateCandidates() + applyDeterministicMerges()
    |   合并后的每组保留 description 最长的作为 survivor
    v
Step 2: 构建 CanonicalConstraint
    |   - type/subtype 推断: 正则匹配关键词 (security/performance/...)
    |   - canonicalId: CON_{TYPE_PREFIX}_{KEYWORDS}_{HASH}
    |     英文: 提取前 4 个关键词
    |     中文: hash (因为 extractEnglishKeyWords 对中文返回空)
    |   - displayId: C001, C002, ... (顺序分配)
    |   - verification: 按 type 映射测试策略
    v
Step 3: canonicalId 碰撞解决
    |   同一 canonicalId 加数字后缀
    v
Step 4: displayId 顺序分配
    v
CanonicalConstraint[]
```

**中文 canonicalId 问题**：中文约束无法提取英文关键词，只能用 hash。`CON_FUNC_9IC67N00` 比 `CON_SEC_SSL_HTTPS_5A2F` 不可读得多。这是当前的一个技术债。

### ReferenceNormalizer

解决"用户"和"该用户"和"User"和"本系统的用户"是同一个实体的问题。

```typescript
resolveEntityRef(target: string, registry?: EntityRegistry): string
```

优先级：

1. 已经是 canonical ID（以 `E_` 或 `A_` 开头）→ 直接返回
2. 在 registry 中查找（case-insensitive，匹配 id/canonicalName/displayName/aliases）
3. 无匹配 → 返回原文

关系类型也做归一化：`"1:N"` → `"one-to-many"`，`"一对多"` → `"one-to-many"`。

### 三个模块的协作

实体关系去重的关键是三者配合：

1. `ReferenceNormalizer` 先把 `"Suspect"` 和 `"E_SUSPECT"` 解析到同一个 canonical ID
2. 然后 `_mergeEntityInPlace` 用 `normalizedTarget|normalizedType` 做去重键
3. `ConstraintCanonicalizer` 调用 `SemanticDeduper` 做约束级别的语义去重

没有 ReferenceNormalizer，`"Suspect"` 和 `"E_SUSPECT"` 的关系无法去重（target 不同）。没有 SemanticDeduper，`"密码不少于8位"` 和 `"密码长度最低8个字符"` 的约束无法去重。

## 7. 质量门控体系

四层门控，从源头到输出逐层拦截：

```
Layer 1: 分析后门控 (Post-Analysis)
  位置: AnalyzeMerger.merge() 内
  检查: AnalysisQualityGate
  内容: 实体数/功能数是否合理，覆盖率检查
  作用: 标记但不阻塞

Layer 2: 生成后门控 (Post-Generation)
  位置: GenerationTool.execute() 内
  检查: _ruleCheck (零 LLM)
  内容: 字段完整性、Mermaid 语法、格式校验
  作用: 标记在 Artifact.selfCheckIssues，不阻塞

Layer 3: 保存前门控 (Pre-Save)
  位置: PolicyGuard.canSave()
  检查:
    - 无 inflight tasks
    - plan 全部完成
    - 无 unaccepted artifacts
    - final review 已执行 (除非 skipEvaluation)
    - 无 blocker issues
    - major issues <= maxFinalMajorIssues
  作用: 不通过则拒绝保存

Layer 4: 评估门控 (Evaluation)
  位置: EvaluationTool.evaluate()
  检查: ReviewValidator (前置门禁)
  内容: 设计文本存在性、测试用例存在性
  作用: 未通过的门禁结果注入到 LLM 评审 prompt 中作为参考
```

门控之间的数据传递：Layer 2 的 `selfCheckIssues` 记录在 Artifact 上，Layer 3 检查 `finalReviewCurrent` 确保 Layer 4 已执行，Layer 4 的 issue 是 Layer 3 拒绝保存的主要依据。

## 8. 配置与扩展

### config.yaml 关键配置

```yaml
llm:
  provider: openai
  model: DeepSeek-V3
  base_url: "https://api.modelarts-maas.com/openai/v1"
  temperature: 0.3          # 生成温度（ConstraintExtractor 用 0）
  max_tokens: 32768

orchestration:
  skip_evaluation: false     # 跳过评估（调试用）

# 以下两张表是中文去重的核心基础设施
benchmark:
  entity_name_map:           # 实体中英文别名
    用户: ["User", "Account", "Member"]
    管理员: ["Admin", "Administrator"]

  function_synonyms:         # 功能同义词
    图书搜索: ["搜索图书", "图书查询", "查询图书", "检索"]
    用户注册: ["注册", "用户注册与登录", "注册与登录"]
```

**entity_name_map 和 function_synonyms 不是锦上添花**——没有它们，SemanticDeduper 的术语等价表为空，中文去重几乎失效。PROBLEM.md 的数据：X002/X009/X010 是同一异常、C004/C019 是同一约束，都是因为没有中文语义匹配能力。

### 适配新领域

| 需要改什么 | 说明 |
|-----------|------|
| `config.yaml` 的 `entity_name_map` | 添加新领域的实体中英文映射 |
| `config.yaml` 的 `function_synonyms` | 添加新领域的功能同义词 |
| `src/shared/semanticDeduper.ts` 的 `DEFAULT_GLOSSARY` | 添加新领域的术语等价组 |
| `src/shared/constraintCanonicalizer.ts` 的 `TYPE_INFERENCE_RULES` | 添加新领域的约束类型识别正则 |
| `prompts/` 目录下的 prompt 模板 | 按领域调整生成/评估 prompt |

不需要改的部分：主循环、编排策略、Tool 接口、去重算法本身。这些是领域无关的。
