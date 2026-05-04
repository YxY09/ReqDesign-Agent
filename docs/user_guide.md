# ReqDesign-Agent 使用说明

## 1. 安装配置

### 1.1 环境要求

- Python 3.10+
- pip
- Git
- Node.js (可选，用于Mermaid CLI)

### 1.2 安装步骤

```bash
# 1. 克隆仓库
git clone <repo-url>
cd ReqDesign-Agent

# 2. 安装Python依赖
pip install -r requirements.txt

# 3. (可选) 安装Mermaid CLI
npm install -g @mermaid-js/mermaid-cli
```

### 1.3 配置LLM

编辑 `config.yaml`：

```yaml
llm:
  provider: openai      # 可选: openai, anthropic, deepseek, qwen
  model: gpt-4o         # 模型名称
  api_key: "your-key"   # API密钥
  temperature: 0.3      # 温度参数
  max_tokens: 4096      # 最大token数
```

或通过环境变量设置API密钥：

```bash
export OPENAI_API_KEY="your-key"
export ANTHROPIC_API_KEY="your-key"
export DEEPSEEK_API_KEY="your-key"
export QWEN_API_KEY="your-key"
```

## 2. CLI命令详解

### 2.1 基本用法

```bash
python -m agent.main --task <任务类型> --input <输入文件> --output <输出目录>
```

### 2.2 参数说明

| 参数 | 缩写 | 说明 | 默认值 |
|------|------|------|--------|
| --task | | 任务类型: analyze 或 design | design |
| --input | -i | 输入需求文档路径 | (必填) |
| --output | -o | 输出目录 | outputs/ |
| --config | -c | 配置文件路径 | config.yaml |
| --model | -m | 覆盖配置中的模型 | (配置值) |
| --provider | -p | 覆盖配置中的provider | (配置值) |
| --max-retry | | 最大重试次数 | (配置值) |
| --log-level | | 日志级别 | INFO |

### 2.3 示例

```bash
# 完整设计任务
python -m agent.main --task design --input examples/requirements.md --output outputs/demo

# 仅需求分析
python -m agent.main --task analyze --input requirements.md --output outputs/analyze

# 使用DeepSeek模型
python -m agent.main --task design --input requirements.md --output outputs/demo --provider deepseek --model deepseek-chat

# 调试模式
python -m agent.main --task design --input requirements.md --output outputs/demo --log-level DEBUG
```

## 3. VSCode集成

### 3.1 安装插件

1. 在VSCode中打开 `vscode-extension` 目录
2. 按 `F5` 启动调试，或打包为VSIX安装

### 3.2 使用命令

| 命令 | 快捷键 | 说明 |
|------|--------|------|
| ReqDesign: Generate Design | Ctrl+Shift+P 输入命令 | 基于当前文件生成设计 |
| ReqDesign: Open Output Folder | Ctrl+Shift+P 输入命令 | 打开输出目录 |
| ReqDesign: Render Mermaid Preview | Ctrl+Shift+P 输入命令 | 渲染Mermaid图为SVG |

### 3.3 使用流程

1. 在VSCode中打开ReqDesign-Agent项目文件夹
2. 打开一个需求文档（.md或.txt格式）
3. 按 `Ctrl+Shift+P` 打开命令面板
4. 输入 `ReqDesign` 选择 "Generate Design"
5. 选择输出目录
6. 等待生成完成

## 4. 应用案例

### 4.1 案例一：图书管理系统

**输入** (`examples/library/requirements.md`):

```markdown
# 图书管理系统需求

学生可以注册、登录、搜索图书、借阅图书、归还图书。
管理员可以添加、删除、修改图书信息。
系统需要记录每本书的借阅状态，且同一本书同一时间只能被一个用户借阅。
当用户逾期未还时，系统应记录逾期状态并提示用户处理。
```

**执行**:

```bash
python -m agent.main --task design \
  --input examples/library/requirements.md \
  --output outputs/library
```

**输出**:

```
outputs/library/
├── requirement_analysis.json   # 结构化需求
├── requirement_analysis.md     # 需求说明文档
├── system_design.md            # 系统设计文档
├── class_diagram.mmd           # 类图
├── activity_diagram.mmd        # 活动图
├── state_diagram.mmd           # 状态机图
├── test_cases.md               # 测试用例
├── review_report.md            # 审查报告
└── summary_report.md           # 汇总报告
```

### 4.2 案例二：在线商城订单系统

**输入** (`examples/mall/requirements.md`):

```markdown
# 在线商城订单系统需求

用户可以注册登录、浏览商品、加入购物车、下单支付。
订单支持取消和退款。
商家可以管理商品、处理订单、确认发货。
```

**执行**:

```bash
python -m agent.main --task design \
  --input examples/mall/requirements.md \
  --output outputs/mall
```

**输出**: 同案例一，包含完整的分析和设计文档。

## 5. 基准测试

### 5.1 运行基准测试

```bash
python benchmark/run_benchmark.py \
  --cases benchmark/cases \
  --gold benchmark/gold_labels \
  --output benchmark/results
```

### 5.2 查看结果

```bash
# 查看JSON报告
cat benchmark/results/benchmark_report.json

# 查看Markdown报告
cat benchmark/results/benchmark_report.md
```

### 5.3 自定义测试案例

1. 在 `benchmark/cases/` 下创建 `.md` 需求文档
2. 在 `benchmark/gold_labels/` 下创建同名 `.json` 标注文件
3. 运行基准测试

## 6. 常见问题

### Q: API密钥如何配置？

在 `config.yaml` 中设置 `api_key`，或设置对应的环境变量。

### Q: 如何切换模型？

修改 `config.yaml` 中的 `provider` 和 `model` 字段，或使用命令行参数 `--provider` 和 `--model`。

### Q: Mermaid图语法错误怎么办？

系统内置了自动修复机制。如果修复失败，可以：
1. 检查 `review_report.md` 中的错误信息
2. 手动修改 `.mmd` 文件
3. 使用 `mmdc` CLI 验证语法

### Q: 如何查看详细日志？

使用 `--log-level DEBUG` 参数运行，日志会保存在 `logs/` 目录下。
