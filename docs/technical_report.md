# ReqDesign-Agent 技术报告

## 1. 大模型选择

### 1.1 模型方案

本系统采用可切换的多模型架构，通过配置文件支持以下大语言模型：

| 模型 | 优点 | 可能问题 | 使用方式 |
|------|------|----------|----------|
| GPT-4o | 推理和长上下文能力强 | API成本较高 | 主要实验模型 |
| Claude | 代码生成质量高 | API访问限制 | 可选模型 |
| DeepSeek | 中文能力好，成本低 | 复杂推理稳定性需测试 | 可替代模型 |
| Qwen | 中文理解好，阿里云支持 | 格式稳定性 | 可替代模型 |

### 1.2 模型切换机制

通过 `config.yaml` 配置文件切换模型，无需修改代码：

```yaml
llm:
  provider: deepseek  # openai, anthropic, deepseek, qwen
  model: deepseek-chat
  api_key: ""
  temperature: 0.3
```

`LLMClient` 类统一封装了不同模型的API调用差异，对上层Agent透明。

## 2. 提示工程策略

### 2.1 多Prompt分任务设计

系统不使用单个大Prompt，而是将任务拆分为7个专用Prompt：

1. **需求抽取Prompt**：要求输出JSON格式，字段包括actors、functions、entities、constraints、exceptions、non_functional_requirements、business_processes
2. **设计生成Prompt**：要求输出Markdown格式，包含系统概述、分层架构、模块划分、核心类、数据流
3. **类图Prompt**：只输出Mermaid classDiagram代码
4. **活动图Prompt**：只输出Mermaid flowchart代码
5. **状态机Prompt**：只输出Mermaid stateDiagram-v2代码
6. **测试用例Prompt**：要求Markdown表格格式，按正常/异常/边界分类
7. **审查Prompt**：要求输出JSON格式的审查结果，含评分和修复建议

### 2.2 输出格式控制

每个Prompt都明确指定输出格式（JSON或Markdown），并给出格式示例。对于JSON输出，Prompt中包含完整的字段定义和示例结构，减少LLM输出格式错误的概率。

### 2.3 Mermaid代码提取

LLM返回的Mermaid代码可能包含在markdown代码块中或直接输出。`DiagramGenerator._extract_mermaid()` 方法实现了多种提取策略：
- 从 ` ```mermaid ``` ` 代码块中提取（优先）
- 从 ` ``` ``` ` 通用代码块中提取（仅匹配后跟换行的裸 ```，避免误匹配python等语言标记）
- 直接匹配以关键字开头的纯文本（支持classDiagram/flowchart/graph/stateDiagram）

### 2.4 JSON截断恢复

LLM输出可能因token限制被截断。`LLMClient._try_complete_json()` 实现了括号跟踪和自动补全：
- 跟踪未闭合的 `{` 和 `[`，自动添加对应的 `}` 和 `]`
- 检测字符串中间截断，自动添加闭合引号
- 清理尾部不完整的key/value
- 与 `_parse_json_robust()` 配合，逐级尝试：直接解析 → 移除注释 → 移除尾逗号 → 截取到最后有效位置 → 补全截断

### 2.5 输入安全防护

- **Prompt注入防护**：移除输入文本中的所有模板变量模式 `{xxx}`
- **路径穿越防护**：文件名白名单 + 双重路径校验（`startswith`检查）
- **文件大小限制**：512KB文件大小 + 100K字符数双重限制
- **编码容错**：自动尝试UTF-8/GBK/Latin-1编码

## 3. 任务分解与编排机制

### 3.1 确定性流程 + LLM推理 + 工具校验

系统采用混合架构：
- **确定性流程**：`WorkflowController` 控制任务顺序、文件读写、校验与重试
- **LLM推理**：各Agent负责语义理解和设计生成
- **工具校验**：`MermaidValidator` 执行语法检查

### 3.2 工作流

```
InputLoader → RequirementAnalyzer → DesignPlanner → DiagramGenerator
    → MermaidValidator → ReviewAgent → TestCaseGenerator → OutputManager
```

### 3.3 上下文管理

每阶段的输出保存为结构化中间结果，后续阶段只读取必要内容：
- 需求分析阶段：完整输入原始需求文本
- 设计规划阶段：只输入需求JSON
- 图生成阶段：输入需求JSON + 设计说明
- 审查阶段：输入需求摘要 + 当前输出

## 4. 错误处理与重试逻辑

### 4.1 重试机制

`RetryManager` 实现指数退避重试策略：
- 最大重试次数可配置（默认3次）
- 每次重试等待时间：min(2^attempt, 10)秒
- 保留完整的失败历史记录

### 4.2 Mermaid语法修复

当Mermaid语法校验失败时：
1. 将错误信息和原始代码交给LLM修复
2. 修复后再次校验
3. 支持多轮修复（最多2轮），每轮修复后立即验证
4. 仍失败则保留原始内容，审查报告记录问题

### 4.3 工作流阶段降级

`WorkflowController.run_design_task()` 中每个阶段（设计规划、图生成、测试用例、审查）都包裹在try/except中。单个阶段失败不会阻塞整个流水线，后续阶段继续执行，输出中该阶段为空。这保证了即使LLM在某一阶段返回异常，用户仍能获得其他阶段的输出。

### 4.4 LLM响应健壮性

- 空响应检测：检查`choices`和`content`是否为空，抛出明确错误
- 类型规范化：LLM返回字符串而非数组时，`_normalize_result()`自动转换
- JSON解析容错：5级容错策略（直接解析→注释清理→尾逗号移除→截取→补全）
- 分数类型安全：`overall_score`转为float后再做算术运算

### 4.3 日志系统

所有关键操作记录日志：
- LLM调用请求和响应
- Agent执行过程
- 校验结果和重试操作
- 错误和异常

日志同时输出到控制台和文件，便于调试和问题追踪。

## 5. 工具调用

### 5.1 内置工具

| 工具 | 功能 | 实现方式 |
|------|------|----------|
| InputLoader | 读取MD/TXT/JSON文件 | Python文件IO |
| MermaidValidator | Mermaid语法校验 | 正则表达式 + 可选CLI |
| OutputManager | 文件写入和目录管理 | Python文件IO |
| Logger | 日志记录 | Python logging模块 |

### 5.2 可选外部工具

- `mmdc` (mermaid-cli)：用于Mermaid图渲染和高级语法校验
- `pandoc`：用于Markdown转PDF（文档生成）

## 6. 自主实现与框架边界

本项目的核心流程控制、Agent编排、上下文管理均为自主实现，未使用LangGraph、CrewAI等框架。这种选择基于以下考虑：

1. 本项目的场景是顺序流水线，复杂度不需要框架支持
2. 自主实现更容易在课程报告中说明技术细节
3. 减少外部依赖，降低环境配置复杂度

如需使用框架，可将 `WorkflowController` 替换为LangGraph实现，Agent接口保持不变。
