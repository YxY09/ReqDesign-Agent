# ReqDesign-Agent 系统设计方案

## 1. 系统架构图

```
┌─────────────────────────────────────────────────────────┐
│                    用户交互层                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  CLI 命令行   │  │ VSCode 插件  │  │  Web API     │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
├─────────┴──────────────────┴──────────────────┴─────────┤
│                    治理框架层                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │  Repair  │ │  Tool    │ │  Trace   │ │Evaluate  │  │
│  │Controller│ │Validator │ │  Logger  │ │ Manager  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│  ┌──────────┐ ┌──────────┐                             │
│  │Consistency│ │ Memory   │                             │
│  │ Checker  │ │  Store   │                             │
│  └──────────┘ └──────────┘                             │
├─────────────────────────────────────────────────────────┤
│                    消息驱动编排层                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Coordinator  │  │  TaskMailbox │  │  Steering    │  │
│  │   Agent      │  │  (消息总线)   │  │   Policy     │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘  │
├─────────┴───────────────────────────────────────────────┤
│                    多 Agent 层                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐               │
│  │ Planner  │ │Generator │ │Evaluator │               │
│  │  Agent   │ │  Agent   │ │  Agent   │               │
│  └──────────┘ └──────────┘ └──────────┘               │
│  ┌──────────────────────────────────────────────────┐  │
│  │          Worker Session（进程/线程隔离）           │  │
│  └──────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│                    工具与数据层                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │LLMClient │ │ Mermaid  │ │  Output  │ │  Prompt  │  │
│  │(Tracing) │ │ Validator│ │ Manager  │ │  Loader  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
└─────────────────────────────────────────────────────────┘
```

## 2. 模块划分

| 模块 | 职责 | 对应文件 |
|------|------|----------|
| 用户交互层 | CLI命令解析、IDE集成 | main.py |
| 消息驱动运行时 | Coordinator 决策循环 + Worker 生命周期 | agent/runtime.py |
| Worker Session | 会话状态机、序列化、生命周期 | agent/session.py |
| 消息总线 | TaskMessage/TaskNotification 投递 | agent/messaging.py |
| Coordinator | LLM 驱动的下一步决策 | agents/coordinator.py |
| Planner | plan（初始规划）+ replan（动态调整） | agents/planner.py |
| Generator | 产物生成 + 自检 + 自修正循环 | agents/generator.py |
| Evaluator | 规则校验 + LLM 语义审查 | agents/evaluator.py |
| 执行后端 | ThreadBackend + ProcessBackend（长生命周期） | execution/backend.py, execution/process_backend.py |
| 驾驭策略 | 自修正轮数、审查阈值、策略预设 | agent/steering.py |
| 进展追踪 | 拒绝计数、停滞检测、评分趋势 | agent/progress.py |
| 记忆系统 | 文件存储 + LLM 相关性检索 + prompt 注入 | agent/memory/store.py |
| 项目宪法 | ReqDesign.md 加载与 prompt 注入 | agent/constitution.py |
| 输入处理 | 读取、清洗需求文档 | input_loader.py |
| 输出管理 | 文件写入、报告生成 | output_manager.py |
| 重试管理 | 失败重试、历史记录 | retry_manager.py |
| LLM客户端 | 统一API调用 | llm_client.py |
| **Agent 支撑工具** | | **governance/** |
| 工具校验 | JSON/Mermaid/Markdown校验 | tool_validator.py |
| 修复控制 | 多轮修复策略 | repair_controller.py |
| 全链路追踪 | LLM调用/阶段追踪 | trace_logger.py |
| 评估管理 | Benchmark与趋势分析 | evaluation_manager.py |
| 一致性检查 | 跨产物一致性检查 | consistency_checker.py |
| 配置管理 | 配置加载、验证 | config.py |
| 日志系统 | 日志记录 | logger.py |

## 3. 数据流

```
requirements.md
    │
    ▼
InputLoader.load()  ← 编码容错、大小限制、代码围栏感知
    │
    ▼ (标准化需求文本)
PlannerAgent.plan()  ← LLM 将需求分解为 ExecutionPlan（任务图）
    │
    ▼ (ExecutionPlan: [analyze, design, diagrams, tests, ...])
Coordinator 决策循环:
    │
    ├── spawn → GeneratorSession.run() → Artifact
    │       └── self-check → self-correct 循环（最多 N 轮）
    │
    ├── spawn → EvaluatorSession.run() → Verdict (passed/rejected)
    │       ├── passed: 记录记忆，Coordinator 继续下一个任务
    │       └── rejected: Coordinator 决定 continue / replan / finish
    │
    ├── continue → 同一 GeneratorSession 接收 fix_instructions，修复产物
    │       └── 复用进程内 intermediate_state（长生命周期 ProcessBackend）
    │
    ├── replan → PlannerAgent.replan() → PlanMutation（增量调整任务图）
    │
    └── finish → OutputManager.save_all()
            │
            ▼
        输出目录/
        ├── requirement_analysis.json
        ├── requirement_analysis.md
        ├── system_design.md
        ├── class_diagram.mmd
        ├── activity_diagram.mmd
        ├── state_diagram.mmd
        ├── test_cases.md
        ├── review_report.md
        ├── review_result.json
        └── summary_report.md
```

Coordinator 在每个决策点重新评估全部状态（已完成/失败/挂起任务、评分趋势、停滞检测），自主选择最优动作。MemoryStore 在 evaluator verdict 后写 checkpoint，后续 agent 调用自动获取相关历史经验。

## 4. 核心类/接口设计

### 4.1 AgentConfig

配置管理类，保存模型、温度、重试次数等配置。

| 方法 | 说明 |
|------|------|
| load_from_yaml(path) | 从YAML文件加载配置 |
| validate() | 验证配置有效性 |
| get_api_key() | 获取API密钥 |

### 4.2 LLMClient

统一封装不同大模型API调用。

| 方法 | 说明 |
|------|------|
| chat(messages) | 发送对话请求 |
| generate_json(prompt, system) | 发送请求并解析JSON响应 |
| generate_text(prompt, system) | 发送请求并返回文本响应 |

### 4.3 RequirementAnalyzer

需求分析Agent。

| 方法 | 说明 |
|------|------|
| analyze(requirement_text) | 分析需求文本，返回结构化JSON |
| validate_result(result) | 验证分析结果完整性 |

### 4.4 DesignPlanner

设计规划Agent。

| 方法 | 说明 |
|------|------|
| generate_design(requirement_json) | 生成系统设计说明 |
| validate_design(design_text, req_json) | 验证设计覆盖度 |

### 4.5 DiagramGenerator

图模型生成Agent。

| 方法 | 说明 |
|------|------|
| generate_class_diagram(req, design) | 生成类图 |
| generate_activity_diagram(req, design) | 生成活动图 |
| generate_state_diagram(req, design) | 生成状态机图 |
| generate_all(req, design) | 生成所有图 |

### 4.6 MermaidValidator

Mermaid语法校验工具。

| 方法 | 说明 |
|------|------|
| validate(content, type) | 校验语法，返回(is_valid, error_msg) |
| validate_and_report(content, type) | 校验并返回可读报告 |

### 4.7 ReviewAgent

审查与修复Agent。

| 方法 | 说明 |
|------|------|
| validate_mermaid_syntax(diagrams) | 校验所有图的语法 |
| review(req, design, diagrams) | 审查所有设计产物 |
| repair_diagram(name, content, error) | 修复有错误的图 |
| review_and_repair(req, design, diagrams) | 审查并自动修复 |
| generate_report(review_result) | 生成审查报告 |

### 4.8 AgentRuntime

统一 Agent 运行时，负责状态初始化、规划、工具执行、完成判定、追踪和结束保存。

| 方法 | 说明 |
|------|------|
| run(goal, input_path, output_dir) | 执行 Agent 主循环 |
| _run_loop(state) | Observe/Plan/Act/Validate 循环 |
| _force_save(state) | 结束时保存已有产物 |

### 4.9 RetryManager

重试管理器。

| 方法 | 说明 |
|------|------|
| retry(func, *args) | 执行函数，失败时重试 |
| get_history() | 获取重试历史 |

## 5. 关键技术选型

| 技术 | 选型 | 理由 |
|------|------|------|
| 主语言 | Python 3.10+ | 生态丰富，LLM SDK支持好 |
| 图格式 | Mermaid | 浏览器原生支持，语法简洁 |
| CLI | argparse | 标准库，无需额外依赖 |
| 日志 | logging | 标准库，灵活可配置 |
| 配置 | YAML | 人类可读，支持嵌套结构 |
| 测试 | pytest | 流行、功能强大 |
| IDE集成 | VSCode插件 | 轻量，直接调用CLI |


