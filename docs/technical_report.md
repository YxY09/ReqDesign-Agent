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

## 6. 治理框架

### 6.1 设计理念

治理框架采用"可选叠加"架构：不修改现有Agent代码，通过适配器/装饰器模式在流水线各阶段注入治理逻辑。默认不启用，通过 `--enable-governance` CLI参数开启。

### 6.2 阶段门控（StageGate）

每个阶段执行后，StageGate根据校验结果决定下一步：
- **PROCEED**：校验通过，进入下一阶段
- **RETRY**：可恢复错误（如空响应、超时），**实际重新执行stage_fn**（循环回到阶段开头）
- **REPAIR**：不可恢复错误，触发LLM修复流程，修复后重新校验并再次门控
- **HALT**：分数过低或达到修复上限，终止流水线

`_run_stage` 实现为while循环状态机：RETRY分支递增retry_count并continue重新执行，REPAIR分支调用修复后重新校验并再次评估门控，支持多轮修复直到PROCEED或HALT。Agent自校验warnings（如requirement_analyzer.validate_result返回的警告）被合并到ValidationResult中，每个warning降低score 0.05。

### 6.3 全链路追踪（TraceLogger）

TracingLLMClient透明包装LLMClient，捕获每次LLM调用的：
- 输入消息数量和字符数
- 输出字符数
- 调用耗时
- 错误信息

追踪数据导出为JSON，支持事后分析和性能优化。

### 6.4 修复控制（RepairController）

多轮修复策略：
1. 校验失败时，将错误信息和原始输出交给LLM修复
2. 修复后立即重新校验
3. 最多N轮修复（可配置），每轮记录 error → action → result
4. 超过轮次标记为失败，不阻塞后续阶段

### 6.5 人工检查点（HumanCheckpoint）

在配置的阶段暂停，输出当前结果摘要，等待人工决策。`_run_stage` 末尾统一调用检查点，因此**所有阶段**都可配置为检查点（不仅限于requirement_analysis）。决策选项：
- **CONTINUE**：继续执行
- **MODIFY**：提供修改建议后继续
- **REGENERATE**：重新生成当前阶段输出
- **ABORT**：终止流水线

### 6.6 Prompt注册（PromptRegistry）

扫描 `prompts/` 目录，为每个Prompt模板计算内容hash作为版本号。支持按名称/版本查询，为A/B测试和Prompt迭代提供基础。

### 6.7 跨产物一致性检查（ConsistencyChecker）

在所有阶段完成后、ReviewAgent之前，执行基于关键词匹配的一致性检查（不依赖LLM）：
- **需求→设计**：设计文档是否覆盖需求中的所有功能点
- **实体→类图**：类图中是否包含需求定义的所有实体
- **设计→测试**：测试用例是否覆盖设计文档中的章节关键词
- **类图→状态图**：状态图引用的类是否在类图中存在

返回ConsistencyResult(errors, warnings, score)，errors影响一致性评分，warnings仅记录。

### 6.8 需求分析轻量审查

需求分析阶段成功后，执行纯规则的轻量审查（不调用LLM）：
- 检查actors、functions、entities字段是否非空
- 检查功能点和实体数量是否合理（≥2）
- 检查每个功能点是否有名称和描述

结果写入治理报告，帮助在早期发现明显的遗漏。

### 6.9 效果评估（EvaluationManager）

封装benchmark运行流程，支持多次运行取平均（消除LLM随机性），与历史结果对比生成趋势报告。

## 7. 工程优化

### 7.1 共享Prompt加载器（prompt_loader.py）

5个Agent模块（RequirementAnalyzer、DesignPlanner、DiagramGenerator、TestCaseGenerator、ReviewAgent）原本各自实现相同的 `_load_prompt` 方法。提取为共享的 `agent/prompt_loader.py` 模块，带文件级缓存，消除重复代码并避免benchmark多次运行时的磁盘重复读取。

### 7.2 状态图评分（score_state_diagram）

benchmark评分体系新增状态图完整性指标（权重5%），检查状态图是否有开始/结束标记、转换箭头、足够的状态数量以及对预期流程的覆盖。综合得分权重调整为：需求覆盖35%、图语法20%、实体准确20%、流程完整10%、状态图5%、一致性10%。

### 7.3 LLM客户端快速失败

`LLMClient` 在初始化时检测API密钥缺失，立即抛出 `ValueError` 并给出明确的配置提示，而非延迟到运行时产生不透明的SDK错误。

### 7.4 统一入口（TaskOrchestrator）

`WorkflowController` 已移除，所有模式（标准/治理）统一使用 `TaskOrchestrator`。治理功能通过 `GovernanceConfig` 控制开关：标准模式使用默认配置，治理模式可通过CLI参数启用追踪、人工检查点等增强功能。`StageRecord.to_dict()` 保存完整数据，`to_summary()` 提供截断版本用于治理报告。

### 7.5 并行图生成

`DiagramGenerator.generate_all` 使用 `ThreadPoolExecutor(max_workers=3)` 并行生成类图、活动图、状态图，将3次串行LLM调用缩短为1次并行调用。

## 8. 自主实现与框架边界

本项目的核心流程控制、Agent编排、上下文管理均为自主实现，未使用LangGraph、CrewAI等框架。这种选择基于以下考虑：

1. 本项目的场景是顺序流水线，复杂度不需要框架支持
2. 自主实现更容易在课程报告中说明技术细节
3. 减少外部依赖，降低环境配置复杂度

如需使用框架，可将 `TaskOrchestrator` 替换为LangGraph实现，Agent接口保持不变。
