# ReqDesign-Agent 系统设计方案

## 1. 系统架构图

```
┌─────────────────────────────────────────────────────────┐
│                    用户交互层                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  CLI 命令行   │  │ VSCode 插件  │  │  Web API     │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
├─────────┴──────────────────┴──────────────────┴─────────┤
│                    智能体编排层                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ WorkflowCtrl │  │ ContextMgr   │  │ RetryManager │  │
│  └──────┬───────┘  └──────────────┘  └──────────────┘  │
├─────────┴───────────────────────────────────────────────┤
│                    核心智能体层                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ 需求分析 │ │ 设计规划 │ │ 图生成   │ │ 测试生成 │  │
│  │ Agent    │ │ Agent    │ │ Agent    │ │ Agent    │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │              审查与修复 Agent                      │  │
│  └──────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│                    工具与数据层                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ LLMClient│ │ Mermaid  │ │ FileManager│ │ PromptLib│  │
│  │          │ │ Validator│ │          │ │          │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
└─────────────────────────────────────────────────────────┘
```

## 2. 模块划分

| 模块 | 职责 | 对应文件 |
|------|------|----------|
| 用户交互层 | CLI命令解析、IDE集成 | main.py |
| 工作流控制 | 任务编排、流程控制 | workflow_controller.py |
| 输入处理 | 读取、清洗需求文档 | input_loader.py |
| 需求分析 | 抽取角色/功能/实体/约束 | requirement_analyzer.py |
| 设计规划 | 生成模块划分、核心类 | design_planner.py |
| 图模型生成 | 生成Mermaid类图/活动图/状态图 | diagram_generator.py |
| 测试用例生成 | 生成测试用例草案 | test_case_generator.py |
| 审查与修复 | 质量检查、自动修复 | review_agent.py |
| Mermaid校验 | 图语法检查 | mermaid_validator.py |
| 重试管理 | 失败重试、历史记录 | retry_manager.py |
| 输出管理 | 文件写入、报告生成 | output_manager.py |
| LLM客户端 | 统一API调用 | llm_client.py |
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
RequirementAnalyzer.analyze()  ← 自动重试、类型规范化、prompt注入防护
    │
    ▼ (需求JSON)
DesignPlanner.generate_design()  ← 大小写不敏感验证
    │
    ▼ (系统设计说明)
DiagramGenerator.generate_all()  ← 优先mermaid代码块提取
    │
    ├──▶ class_diagram.mmd
    ├──▶ activity_diagram.mmd
    └──▶ state_diagram.mmd
    │
    ▼ (Mermaid代码)
ReviewAgent.review_and_repair()  ← 多轮修复验证
    │
    ├──▶ 修复后的图文件
    └──▶ review_result.json
    │
    ▼
TestCaseGenerator.generate()
    │
    ▼ (测试用例)
OutputManager.save_all()  ← 路径穿越防护
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

注意：每个阶段都有try/except降级处理，单个阶段失败不阻塞后续阶段。

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

### 4.8 WorkflowController

工作流控制器。

| 方法 | 说明 |
|------|------|
| run_analyze_task(input, output) | 运行需求分析任务 |
| run_design_task(input, output) | 运行完整设计任务 |

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
