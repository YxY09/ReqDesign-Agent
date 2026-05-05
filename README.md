# ReqDesign-Agent

基于大语言模型的需求分析与系统设计智能体。

## 功能概述

以自然语言需求文档为输入，自动完成：

1. **需求要素抽取**：识别角色、功能、实体、约束、异常流程、非功能需求
2. **系统设计**：生成模块划分、核心类、接口与数据流
3. **图模型生成**：输出Mermaid格式的类图、活动图、状态机图
4. **测试用例草案**：按正常/异常/边界生成测试用例
5. **一致性审查**：检查需求覆盖、图语法、模型一致性，自动修复语法错误

## 安装

```bash
# 克隆仓库
git clone <repo-url>
cd ReqDesign-Agent

# 安装依赖
pip install -r requirements.txt

# 可选：安装mermaid-cli用于图语法校验
npm install -g @mermaid-js/mermaid-cli
```

## 配置

编辑 `config.yaml` 设置LLM参数：

```yaml
llm:
  provider: openai        # 可选: openai, anthropic, deepseek, qwen
  model: gpt-4o
  api_key: ""             # 留空则从环境变量读取
  temperature: 0.3
  max_tokens: 8192
```

或通过环境变量设置API密钥：

```bash
export OPENAI_API_KEY="your-key"
export ANTHROPIC_AUTH_TOKEN="your-key"  # 或 ANTHROPIC_API_KEY
export DEEPSEEK_API_KEY="your-key"
export QWEN_API_KEY="your-key"
```

## 使用方法

### CLI命令

```bash
# 生成完整设计结果
python -m agent.main --task design --input requirements.md --output outputs/demo

# 只生成需求分析结果
python -m agent.main --task analyze --input requirements.md --output outputs/analyze

# 指定模型与重试次数
python -m agent.main --task design --input requirements.md --output outputs/demo --model deepseek --max-retry 3

# 指定日志级别
python -m agent.main --task design --input requirements.md --output outputs/demo --log-level DEBUG
```

### 运行基准测试

```bash
python benchmark/run_benchmark.py --cases benchmark/cases --output benchmark/results
```

### 运行测试

```bash
python3 -m pytest tests/ -v
```

## 项目结构

```
ReqDesign-Agent/
├── agent/                  # 核心智能体代码
│   ├── main.py             # CLI入口
│   ├── config.py           # 配置管理（YAML加载、验证、环境变量）
│   ├── logger.py           # 日志配置（控制台+文件双输出，自动轮转）
│   ├── llm_client.py       # LLM API封装（OpenAI/Claude/DeepSeek/Qwen）
│   ├── input_loader.py     # 输入处理（编码容错、大小限制、代码围栏感知）
│   ├── requirement_analyzer.py  # 需求分析Agent
│   ├── design_planner.py   # 设计规划Agent
│   ├── diagram_generator.py # 图生成Agent（类图/活动图/状态图）
│   ├── mermaid_validator.py # Mermaid语法校验（正则+可选CLI）
│   ├── test_case_generator.py # 测试用例生成
│   ├── review_agent.py     # 审查Agent（多轮修复验证）
│   ├── retry_manager.py    # 重试管理（指数退避）
│   ├── workflow_controller.py # 工作流编排（阶段降级）
│   └── output_manager.py   # 输出管理（路径穿越防护）
├── prompts/                # 7个Prompt模板
├── benchmark/              # 基准测试（5个案例+评分器）
│   ├── cases/              # 测试案例需求文档
│   ├── gold_labels/        # 人工标注
│   ├── run_benchmark.py    # 运行器
│   └── scorer.py           # 评分函数
├── vscode-extension/       # VSCode插件
├── docs/                   # 文档
├── tests/                  # 测试（103个用例）
├── config.yaml             # 默认配置
├── requirements.txt        # Python依赖
└── README.md
```

## 输出示例

```
outputs/demo/
├── requirement_analysis.json   # 结构化需求抽取结果
├── requirement_analysis.md     # 需求分析说明（Markdown）
├── system_design.md            # 模块划分、核心类、接口与数据流
├── class_diagram.mmd           # Mermaid类图
├── activity_diagram.mmd        # Mermaid活动图
├── state_diagram.mmd           # Mermaid状态机图
├── test_cases.md               # 测试用例草案
├── review_report.md            # 一致性审查记录
├── review_result.json          # 审查结果（JSON）
└── summary_report.md           # 汇总报告
```

## 评价指标

| 指标 | 权重 | 说明 |
|------|------|------|
| 需求覆盖率 | 40% | 输出是否覆盖输入中的主要功能点、约束、异常 |
| 图语法通过率 | 20% | Mermaid图是否可正常渲染 |
| 实体识别准确率 | 20% | 核心业务实体是否识别正确 |
| 流程完整性 | 10% | 活动图是否包含主流程、异常流程、结束条件 |
| 一致性 | 10% | 类图、活动图、状态图之间是否矛盾 |

## 基准测试结果

| 案例 | 需求覆盖 | 图语法 | 实体准确 | 流程完整 | 一致性 | 综合 |
|------|----------|--------|----------|----------|--------|------|
| 图书管理系统 | 100.0 | 100.0 | 100.0 | 100.0 | 95.0 | 99.5 |
| 学生选课系统 | 100.0 | 100.0 | 100.0 | 83.3 | 90.0 | 97.3 |
| 在线商城 | 95.8 | 100.0 | 100.0 | 100.0 | 100.0 | 98.3 |
| 医院挂号 | 95.8 | 100.0 | 100.0 | 100.0 | 95.0 | 97.8 |
| 会议室预约 | 90.0 | 100.0 | 100.0 | 100.0 | 95.0 | 95.5 |
| **平均** | **96.3** | **100.0** | **100.0** | **96.7** | **95.0** | **97.7** |

## 技术栈

- Python 3.10+
- LLM API（可切换GPT/Claude/DeepSeek/Qwen）
- Mermaid格式输出 + 正则语法校验
- argparse (CLI) + VSCode插件
- pytest (测试)
- logging (日志，控制台+文件双输出)
