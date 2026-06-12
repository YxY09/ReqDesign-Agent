# ReqDesign-Agent 代码地图

> 87 个 TypeScript 源文件，按目录逐文件梳理。每条记录：文件路径 → 导出了什么 → 做了什么 → 依赖了哪些项目文件。

---

## 项目一句话

输入自然语言需求文档 → Planning → Generation → Evaluation → Repair 闭环 → 输出完整设计文档（需求分析、系统设计、Mermaid 图表、测试用例）。

---

## 文件数量分布

| 目录 | 文件数 | 职责 |
|------|--------|------|
| src/ 根目录 | 19 | 入口、运行时、状态、配置、LLM 客户端 |
| src/orchestration/ | 8 | 编排决策（策略引擎、收敛检测、预算管理） |
| src/tools/ | 9 | 四个 Tool + ArtifactPatcher + 校验器 |
| src/generators/ | 11 | 内容生成器（分析、设计、图表、测试、合并、提取） |
| src/shared/ | 16 | 共享基础设施（去重、规范化、质量门控） |
| src/memory/ | 4 | Agent 记忆系统 |
| src/runtime/ | 11 | 运行时子模块（制品管理、任务生命周期、Worker 调度） |
| src/execution/ | 2 | 执行后端 |
| src/utils/ | 2 | 工具函数 |
| src/benchmark/ | 2 | 基准测试和评分 |
| src/tui/ | 3 | 终端 UI |
| **合计** | **87** | |

---

## src/ 根目录（19 个文件）

### src/main.ts
- **导出**：无（纯入口脚本）
- **做什么**：CLI 入口。用 Commander.js 定义命令：`--goal design` 走主流程，`chat` 走交互式聊天，`--benchmark` 跑基准测试。加载 .env、初始化日志。
- **import**：runtime, config, inputLoader, outputManager, benchmark/runBenchmark, tui/chatApp, logger

### src/runtime.ts
- **导出**：`class MultiAgentRuntime`, `interface RuntimeRunOptions`
- **做什么**：核心主循环。run() 实现状态机：Drain（收集完成的 Worker）→ Decide（Orchestrator 决策）→ Dispatch（分发到 handler）。createActionHandlers() 是分发表，覆盖 spawn / repair / regenerate / replan / save / finish / pause / inspect / stop。退出条件：超预算、无可用动作、收到终态 action。
- **import**：state, orchestration/orchestrator, tools/planning, tools/generation, tools/evaluation, tools/repair, logger, workflowEvents, messaging, runtime/workerDispatcher, runtime/resultHandler, runtime/PlanMutator, runtime/TaskLifecycleManager

### src/config.ts
- **导出**：`class AgentConfig`, `parseAndValidate()`, `LLMConfig`, `RetryConfig`, `OrchestrationConfig`, `BenchmarkConfig` 等
- **做什么**：用 Zod 定义配置 schema，解析 config.yaml + 环境变量覆盖。
- **import**：无项目内 import（只依赖 zod、yaml、dotenv）

### src/state.ts
- **导出**：`class WorkflowState`, `type MultiAgentState`, `type RunStatus`, `type QualityStatus`, `type PersistStatus`, `interface ArtifactsState`, `interface ExecutionState`, `interface ReviewState`
- **做什么**：整个系统的运行时状态中心。通过 createXXXStateView() 创建 proxy 对象暴露状态子视图。委托给 runtime/ 子模块管理具体状态。
- **import**：shared/types, xmlParser, shared/documentNormalizer, progress, orchestration/snapshot, runtime/TaskLifecycleManager, runtime/PlanMutator, runtime/ArtifactManager, runtime/ReviewManager, runtime/workflowStores

### src/session.ts
- **导出**：`class SessionRegistry`, `class SessionContext`, `abstract class WorkerSession`, `class SessionDescriptor`, `deepToPlainObject()`, `interface SessionProvenance`
- **做什么**：管理所有活跃的 Worker 会话。WorkerSession 是所有 Worker 的基类。每个会话有唯一 sessionId。
- **import**：shared/types, messaging, utils/isRecord

### src/messaging.ts
- **导出**：`class TaskMailbox` + 消息类型、创建/序列化函数
- **做什么**：Worker 与 Runtime 之间的通信。支持类型化消息和序列化。
- **import**：shared/types, node:crypto

### src/progress.ts
- **导出**：`class ProgressSnapshot`
- **做什么**：纯数据类，记录运行进度。hasStalled() 检测停滞。
- **import**：无

### src/streaming.ts
- **导出**：`makeStreamPrinter()`
- **做什么**：流式输出，处理 Windows GBK 控制台编

### src/workflowEvents.ts
- **导出**：`type WorkflowEvent`, `class ConsoleWorkflowStreamer`
- **做什么**：定义工作流事件类型。ConsoleWorkflowStreamer 输出到控制台。
- **import**：无

### src/llmClient.ts
- **导出**：`class LLMClient`, `OnChunk`, `LlmCallInfo`, `LlmStreamEvent`, `ChatMessage`
- **做什么**：封装 OpenAI 兼容接口（支持 OpenAI 和 Anthropic）。内置 JSON 修复管道（代码块包裹、截断补全、转义修复）。用 AsyncLocalStorage 实现流式 tag 上下文传播。
- **import**：config, logger, utils/retry

### src/logger.ts
- **导出**：`createLogger()`
- **做什么**：分级日志器（DEBUG/INFO/WARN/ERROR）。ERROR 写 stderr，其余写 stdout。
- **import**：无

### src/constitution.ts
- **导出**：`const CONSTITUTION`
- **做什么**：Agent 行为章程文本，注入到 LLM prompt 中约束行为。
- **import**：无

### src/inputLoader.ts
- **导出**：`loadInput()`, `interface SectionInfo`
- **做什么**：加载需求文档，支持 Markdown 和 XML 格式。
- **import**：xmlParser

### src/outputManager.ts
- **导出**：`class OutputManager`
- **做什么**：把运行结果写入文件系统，按制品类型分目录。生成 summary_report.md。
- **import**：logger, formatReviewReport, generators/tests, shared/outputSnapshot

### src/promptBuilder.ts
- **导出**：`buildPrompt()`, `buildPromptWithMemory()`
- **做什么**：加载 prompt 模板 + constitution + memory 注入。
- **import**：constitution, memory/store（动态 import）

### src/promptLoader.ts
- **导出**：`loadPrompt()`, `listPrompts()`
- **做什么**：从 prompts/ 加载 .md 模板，支持 {{variable}} 替换。
- **import**：无

### src/traceLogger.ts
- **导出**：`class TraceLogger`
- **做什么**：全链路追踪日志，写入 traces/ 目录。
- **import**：logger

### src/xmlParser.ts
- **导出**：`parseXmlSections()`, `interface XmlSection`
- **做什么**：用 fast-xml-parser 解析 XML 需求文档。
- **import**：无

### src/formatReviewReport.ts
- **导出**：`formatReviewReport()`
- **做什么**：把 Verdict 格式化为 Markdown 审查报告。
- **import**：无

---

## src/orchestration/（8 个文件）

### src/orchestration/orchestrator.ts
- **导出**：`class AgentOrchestrator`
- **做什么**：系统决策中枢。decide() 流程：state → snapshot → DeterministicPolicy → (null 则 StrategyBrain) → PolicyGuard → ActionCompiler → RuntimeAction。
- **import**：policy, strategy, strategyBrain, snapshot, budget, reviewScheduler, state, shared/types, shared/traceabilityMatrix, shared/coverageValidator, shared/reviewValidator, logger, traceLogger

### src/orchestration/policy.ts
- **导出**：`class PolicyGuard`, `class DeterministicPolicy`
- **做什么**：DeterministicPolicy 用 15 步规则链做确定性决策。PolicyGuard 是防线：预算控制（每 task 最多 4 次 repair、2 次 replan）、并发限制、canSave() 门控。
- **import**：snapshot, budget, shared/types

### src/orchestration/strategy.ts
- **导出**：`type StrategyName`, `interface StrategyDecision`, `createStrategyDecision()`, `class ActionCompiler`
- **做什么**：策略名称枚举 + ActionCompiler 把 StrategyDecision 编译为 RuntimeAction。
- **import**：shared/types, budget, state

### src/orchestration/strategyBrain.ts
- **导出**：`class StrategyBrain`
- **做什么**：DeterministicPolicy 无法决策时，用 LLM 选最优策略。
- **import**：llmClient, promptLoader, strategy, snapshot, logger

### src/orchestration/reviewScheduler.ts
- **导出**：`interface ReviewPlan`, `class ReviewScheduler`
- **做什么**：根据阶段完成情况决定是否触发 final review。
- **import**：shared/types

### src/orchestration/runManager.ts
- **导出**：`class RunManager`, `class RunSummaryBuilder`
- **做什么**：追踪执行生命周期。RunSummaryBuilder 生成运行总结（事件分类、失败分类、质量状态）。
- **import**：shared/types

### src/orchestration/snapshot.ts
- **导出**：`interface OrchestratorSnapshot`, `interface IssueFingerprint`, `interface EvaluationRound`, `type Trend`, `class ConvergenceTracker`
- **做什么**：编排决策的只读状态视图。ConvergenceTracker 用 issue 指纹检测收敛停滞，计算趋势（decreasing / non-increasing / increasing）。
- **import**：shared/types, logger

### src/orchestration/budget.ts
- **导出**：`interface OrchestrationConfigRaw`, `interface OrchestrationConfig`, `class BudgetManager`
- **做什么**：预算管理。解析配置参数，追踪消耗，isExhausted() 判断超限。
- **import**：snapshot

---

## src/tools/（9 个文件）

### src/tools/base.ts
- **导出**：`abstract class BaseTool`
- **做什么**：所有 Tool 的基类。注入 LLMClient 和 PromptLoader。
- **import**：llmClient, promptLoader, logger, tools/types, traceLogger

### src/tools/types.ts
- **导出**：`type ToolError`, `interface ToolCapabilities`, `createToolError()`, `isToolError()`
- **做什么**：Tool 的通用错误类型和能力接口。
- **import**：无

### src/tools/planning.ts
- **导出**：`class PlanningTool extends BaseTool`
- **做什么**：需求规划。流程：RegistryExtractor → ConstraintExtractor (temp=0) → LLM 生成 ExecutionPlan → 后处理（拆图表任务、强制依赖顺序、保证章节覆盖、注入约束上限 30 条）→ 失败时固定模板 fallback。
- **import**：base, llmClient, promptLoader, promptBuilder, shared/types, generators/registryExtractor, generators/constraintExtractor, traceLogger

### src/tools/generation.ts
- **导出**：`class GenerationTool extends BaseTool`
- **做什么**：按 Task.type 路由到不同 Generator。含 _ruleCheck() 零成本自检（自检只记录不修复，历史 6/6 失败）。
- **import**：base, llmClient, promptLoader, promptBuilder, generators/analyze, generators/design, generators/diagrams, generators/tests, generators/mermaid, tools/validator, traceLogger

### src/tools/evaluation.ts
- **导出**：`class EvaluationTool extends BaseTool`
- **做什么**：两阶段评估。阶段 1 规则检查（零 LLM），阶段 2 LLM 评审（quick/deep）。Issue 分 scope：systemic / upstream / local。
- **import**：base, llmClient, promptLoader, promptBuilder, shared/types, shared/minimizeJsonForPrompt, shared/reviewValidator, traceLogger

### src/tools/repair.ts
- **导出**：`class RepairTool extends BaseTool`
- **做什么**：两步修复。Step 1 确定性（正则/模板，零 LLM），Step 2 LLM（analyze 全重写，design/tests 用 ops，diagrams 用 section patch）。保护机制：输出 ≥ 原始 50%、类定义丢失恢复。
- **import**：base, artifactPatcher, llmClient, promptLoader, promptBuilder, shared/types, generators/mermaid, traceLogger, logger

### src/tools/artifactPatcher.ts
- **导出**：`interface Section`, `type PatchOp`, `type JsonPatchOp`, `class ArtifactPatcher`
- **做什么**：按格式拆制品为 Section。三种 Section 操作：replace_section / insert_after / remove_section。JSON 支持 ops：replace / append / delete。
- **import**：无

### src/tools/sessions.ts
- **导出**：`class GenerationSession`, `class EvaluationSession`, `class PlanningSession`, `class RepairSession`
- **做什么**：四个 Tool 对应的 WorkerSession 子类，封装执行上下文。
- **import**：planning, generation, evaluation, repair, session, shared/types, state, logger, tools/validator, runtime/outputSnapshotBuilder, runtime/artifactAcceptanceService

### src/tools/validator.ts
- **导出**：`class PostGenerationValidator`
- **做什么**：确定性后处理（零 LLM）。去除占位符、修复格式、规范化 ID 引用。
- **import**：无

---

## src/generators/（11 个文件）

### src/generators/base.ts
- **导出**：`abstract class BaseGenerator<TOutput>`
- **做什么**：所有 LLM 内容生成器基类。提供 buildPrompt、unwrapContent、generateJsonWithRetry 等方法。
- **import**：llmClient, tools/types

### src/generators/analyze.ts
- **导出**：`class RequirementAnalyzer extends BaseGenerator`, 静态 `REQUIRED_FIELDS`, `OPTIONAL_FIELDS`, `validateResult`, `_normalizeResult`
- **做什么**：从自然语言提取结构化 JSON。LLM → 解包 → 规范化（强制数组、priority 中文→英文、属性解析）→ RequirementNormalizer.normalize()。
- **import**：llmClient, promptLoader, shared/normalizer, tools/types, base

### src/generators/design.ts
- **导出**：`class SystemDesigner extends BaseGenerator` + 辅助函数
- **做什么**：生成系统设计 Markdown。构建设计合同（功能 ID + 实体白名单 + 约束/异常 ID），LLM 生成。validateDesign 做程序化校验。
- **import**：llmClient, promptLoader, shared/minimizeJsonForPrompt, shared/requirementIndex, tools/types, base

### src/generators/diagrams.ts
- **导出**：`class DiagramGenerator extends BaseGenerator`
- **做什么**：生成 Mermaid 类图/活动图/状态图。三种图表独立 prompt。generateAll() 先串行类图，再并行活动图和状态图。
- **import**：llmClient, promptLoader, shared/minimizeJsonForPrompt, base

### src/generators/tests.ts
- **导出**：`class TestCaseGenerator extends BaseGenerator`
- **做什么**：三阶段测试生成。Phase 1 程序化枚举覆盖目标 → Phase 2 按模块分组调 LLM → Phase 3 程序化质量校验。
- **import**：llmClient, promptLoader, shared/minimizeJsonForPrompt, shared/requirementIndex, tools/types, base, testPlanBuilder, testQualityValidator

### src/generators/merge.ts
- **导出**：`class AnalyzeMerger extends BaseGenerator`, `canonicalizeConstraintsPipeline()`
- **做什么**：**系统最大单模块（1471 行）**。合并多份分析结果。preMerge 无损合并 → 单次 LLM 后处理补全 → 完整规范化管道。功能语义去重已禁用（误删过 BasicSearch）。
- **import**：llmClient, promptLoader, shared/normalizer, shared/analysisQualityGate, shared/canonicalizer, shared/constraintCanonicalizer, shared/types, shared/referenceNormalizer, tools/types, base

### src/generators/mermaid.ts
- **导出**：`class MermaidValidator`
- **做什么**：纯同步 Mermaid 语法校验（零 LLM）。三阶段：结构检查 → 括号匹配 → 语义分析。
- **import**：无

### src/generators/registryExtractor.ts
- **导出**：`class RegistryExtractor extends BaseGenerator<EntityRegistry>`
- **做什么**：用 LLM 提取全局实体/角色/功能注册表（ID + canonicalName + aliases）。
- **import**：base, llmClient, promptLoader, shared/types

### src/generators/constraintExtractor.ts
- **导出**：`class ConstraintExtractor extends BaseGenerator<ConstraintCandidate[]>`
- **做什么**：用 LLM（**temperature=0**）提取结构化约束候选。后处理：过滤空描述、推断 type/subtype。
- **import**：base, llmClient, promptLoader, shared/constraintCanonicalizer

### src/generators/testPlanBuilder.ts
- **导出**：`buildTestPlan()`, `groupByModule()`, `formatTaskGroupForPrompt()`
- **做什么**：纯程序化规划器（零 LLM）。从 analysis 枚举覆盖目标，按模块分组。每个 Task 带 mustCover 列表。
- **import**：无

### src/generators/testQualityValidator.ts
- **导出**：`validateTestCases()`, `isTemplateLike()`, `hasMissingInput()`, `hasVagueExpected()`, `hasWrongTarget()`
- **做什么**：纯程序化校验（零 LLM）。4 项检查：模板化、缺失输入、模糊预期、错误引用。
- **import**：无

---

## src/shared/（16 个文件）

### src/shared/types.ts
- **导出**：所有核心类型（WorkerKind, TaskType, ActionType, Task, ExecutionPlan, Artifact, Verdict, RuntimeAction, Issue, EntityRegistry, ConstraintCandidate, CanonicalConstraint 等）
- **做什么**：整个系统的数据模型。**项目中被 import 最多的文件。**
- **import**：无

### src/shared/outputSnapshot.ts
- **导出**：`interface OutputSnapshot`
- **做什么**：输出快照接口。
- **import**：无

### src/shared/normalizer.ts
- **导出**：`class RequirementNormalizer`
- **做什么**：7 步规范化管道：强制数组 → 移除空项 → priority 映射 → 属性解析 → 异常规范化 → NFR 规范化 → BP 规范化。normalizeAgainstSource() 做源文本验证。
- **import**：无

### src/shared/canonicalizer.ts
- **导出**：`class Canonicalizer`
- **做什么**：ID 分配（E_XXX / FUN_XXX / CON_XXX / EXC_XXX）。英文约束用关键词，中文用 hash。canonicalizeAndLink() 统一 ID 并建立引用。
- **import**：无

### src/shared/constraintCanonicalizer.ts
- **导出**：`class ConstraintCanonicalizer`
- **做什么**：约束专用规范化管道。SemanticDeduper 去重 → 构建 CanonicalConstraint（type 推断、canonicalId、displayId C001/C002/...、verification 策略）→ 碰撞解决。
- **import**：semanticDeduper

### src/shared/semanticDeduper.ts
- **导出**：`class SemanticDeduper`
- **做什么**：**五层语义匹配去重（446 行）**。Layer 1-3 置信度 1.0（直接合并），Layer 4-5 需确认。Union-Find 传递性合并。**CJK 问题**：中文无空格，Jaccard 只能 0 或 1，术语等价表是中文去重主力。
- **import**：无

### src/shared/referenceNormalizer.ts
- **导出**：`class ReferenceNormalizer`
- **做什么**：解析实体引用到 canonical ID。优先级：canonical ID → registry 查找 → 返回原文。关系类型归一化。
- **import**：types

### src/shared/coverageValidator.ts
- **导出**：`class CoverageValidator`
- **做什么**：需求到设计的覆盖率检查。
- **import**：traceabilityMatrix

### src/shared/traceabilityMatrix.ts
- **导出**：`class TraceabilityMatrix`
- **做什么**：需求到设计元素的映射矩阵。
- **import**：documentNormalizer

### src/shared/analysisQualityGate.ts
- **导出**：`class AnalysisQualityGate`, `checkAnalysisQuality()`
- **做什么**：9 项分析质量检查。标记但不阻塞。
- **import**：无

### src/shared/reviewValidator.ts
- **导出**：`class ReviewValidator`
- **做什么**：评估前门禁（设计/测试存在性）。结果注入 LLM 评审 prompt。
- **import**：requirementIndex

### src/shared/documentNormalizer.ts — 文档格式规范化
### src/shared/minimizeJsonForPrompt.ts — JSON 精简（塞入 LLM prompt）
### src/shared/registrySummary.ts — 注册表摘要生成
### src/shared/requirementIndex.ts — 需求索引（按 ID/名称/类型查找）
### src/shared/taskUtils.ts — Task 工具函数

---

## src/memory/（4 个文件）

### src/memory/store.ts
- **导出**：`class MemoryStore`, `getMemory()`, `setMemory()`
- **做什么**：Agent 持久化记忆。三种记忆：coordinator_decisions、evaluator_insights、generator_lessons。写入 JSON。单例模式。
- **import**：constants, helpers, extractors, logger, llmClient

### src/memory/constants.ts — 记忆路径和最大条目数等常量
### src/memory/extractors.ts — 从运行结果提取记忆（coordinator/evaluator/generator 三种）
### src/memory/helpers.ts — 记忆合并、去重、裁剪

---

## src/runtime/（11 个文件）

### src/runtime/artifactAcceptanceService.ts
- **做什么**：制品接受/拒绝门控。新制品 vs 已有制品比较，决定 accept 还是 keep_existing。

### src/runtime/ArtifactManager.ts
- **做什么**：制品生命周期管理。add（revision + SHA-256）、get、accept/reject。

### src/runtime/eventBridge.ts — 状态变更 → WorkflowEvent → 控制台输出
### src/runtime/outputSnapshotBuilder.ts — 构建最终 OutputSnapshot
### src/runtime/persistenceService.ts — 运行状态持久化到磁盘
### src/runtime/PlanMutator.ts — 修改 ExecutionPlan（replan / targetedRepair）
### src/runtime/resultHandler.ts — Worker 结果类型判断和分派
### src/runtime/ReviewManager.ts — 审查流程管理 + 收敛检测
### src/runtime/TaskLifecycleManager.ts — Task 状态转换 + 通知历史
### src/runtime/workerDispatcher.ts — 创建/调度 Worker Session
### src/runtime/workflowStores.ts — 各子系统状态存储（Facade 模式）

---

## src/execution/（2 个文件）

### src/execution/backend.ts — ExecutionBackend 接口 + InProcessBackend 进程内实现
### src/execution/factory.ts — 根据配置创建执行后端

## src/utils/（2 个文件）

### src/utils/isRecord.ts — 判断是否是普通对象
### src/utils/retry.ts — 通用重试包装器（指数退避）

## src/benchmark/（2 个文件）

### src/benchmark/runBenchmark.ts — 运行基准测试
### src/benchmark/scorer.ts — 多维度评分（实体 35% / 功能 20% / 约束 20% / 异常 10% / 测试 5% / 整体 10%）

## src/tui/（3 个文件）

### src/tui/chatApp.ts — 交互式聊天模式
### src/tui/terminalInput.ts — 高级终端输入（多行、快捷键、历史）
### src/tui/wheelAccel.ts — 滚轮加速器（带动量模型）

---

## prompts/（18 个 prompt 模板）

| 文件 | 用途 |
|------|------|
| coordinator.md | 编排器决策 |
| planner.md | 规划（生成 ExecutionPlan） |
| planner_replan.md | 重新规划 |
| design_planner.md | 设计规划 |
| requirement_analysis.md | 需求分析 |
| generator.md | 通用生成 |
| evaluator.md | 评估 |
| repair.md | 修复 |
| registry_extraction.md | 实体注册表提取 |
| constraint_extraction.md | 约束提取 |
| merge_constraints.md | 约束合并 |
| merge_relationships.md | 关系合并 |
| merge_post_process.md | 合并后处理 |
| class_diagram.md | 类图生成 |
| activity_diagram.md | 活动图生成 |
| state_diagram.md | 状态图生成 |
| test_case.md | 测试用例生成 |
| test_case_task.md | 单任务测试生成 |

---

## tests/（58 个测试文件）

### 端到端与集成
test_core, test_integration, test_batch_b/c/d

### 编排层
test_orchestration, test_policy, test_strategy, test_convergence, test_budget, test_replan, test_systemic_routing

### 运行时
test_runtime_agentic, test_execution_backends, test_backend_contract, test_persistenceService_consistency

### 各阶段
test_phase25_constraint_ref, test_phase3_design, test_phase4_diagrams, test_phase5_tests

### Tool 层
test_artifact_patcher, test_json_patch, test_patch_safety_net, test_repair_prompt, test_evaluator_fixes, test_validator

### 生成器
test_constraint_extractor, test_entity_registry

### 去重与规范化
test_semantic_deduper, test_constraint_canonicalizer, test_constraint_canonicalizer_integration, test_canonicalizer, test_normalizer, test_reference_normalizer, test_coverage_validator, test_traceability_matrix, test_review_validator, test_document_normalizer, test_minimizeForPrompt, test_quality_gate_id_format, test_display_id_adaptation

### 基础设施
test_llm_client, test_llm_client_config, test_llm_client_timeout, test_config_schema, test_retry, test_memory_policy, test_inputLoader, test_outputManager, test_formatReviewReport, test_xml_parser, test_state_issue_serialization, test_state_subdomains, test_progress_model, test_session_descriptor, test_tool_types, test_benchmark

---

## 根目录文件

| 文件 | 作用 |
|------|------|
| config.yaml | 主配置（LLM、编排、entity_name_map、function_synonyms） |
| package.json | 依赖和脚本 |
| tsconfig.json | TypeScript 配置 |
| README.md | 项目文档 |
| PROBLEM.md | 已知问题和技术债 |
| INTRODUCTION.md | 技术内幕介绍 |
