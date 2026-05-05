# ReqDesign-Agent 测试方案与测试报告

## 1. 测试环境

- Python 3.10.12
- pytest 9.0.3
- 操作系统: Linux

## 2. 单元测试

### 2.1 测试覆盖

共103个测试用例，覆盖所有核心模块：

| 模块 | 测试文件 | 测试用例数 | 通过数 |
|------|----------|------------|--------|
| 配置管理 | test_core.py | 11 | 11 |
| 日志系统 | test_core.py | 3 | 3 |
| 输入处理 | test_phase2.py | 11 | 11 |
| 设计验证 | test_phase3.py | 5 | 5 |
| Mermaid校验 | test_phase4.py | 15 | 15 |
| 代码提取 | test_phase4.py | 4 | 4 |
| 测试用例验证 | test_phase5.py | 6 | 6 |
| 重试管理 | test_phase6.py | 10 | 10 |
| 审查报告 | test_phase6.py | 3 | 3 |
| 输出管理 | test_phase7.py | 5 | 5 |
| 基准评分 | test_benchmark.py | 15 | 15 |
| **集成测试** | **test_integration.py** | **25** | **25** |
| **总计** | | **103** | **103** |

### 2.2 集成测试详情（test_integration.py）

| 测试用例 | 覆盖模块 | 测试内容 |
|----------|----------|----------|
| test_input_loader | InputLoader | 基本文件读取 |
| test_input_loader_file_size_guard | InputLoader | 文件大小限制 |
| test_input_loader_encoding_fallback | InputLoader | GBK编码自动识别 |
| test_input_loader_split_sections_code_fence | InputLoader | 代码围栏内#号不误判 |
| test_input_loader_empty_file | InputLoader | 空文件异常处理 |
| test_input_loader_unsupported_extension | InputLoader | 不支持的扩展名 |
| test_diagram_generator_extract_mermaid | DiagramGenerator | Mermaid代码提取（多代码块、graph关键字） |
| test_mermaid_validator | MermaidValidator | 类图/活动图/状态图语法校验 |
| test_mermaid_validator_inline_comment | MermaidValidator | 行内%%注释处理 |
| test_mermaid_validator_comment_ranges | MermaidValidator | 注释区间检测 |
| test_output_manager | OutputManager | 文件写入验证 |
| test_output_manager_json_roundtrip | OutputManager | JSON读写一致性 |
| test_sanitize_filename_path_traversal | OutputManager | 路径穿越防护 |
| test_review_agent_syntax_validation | ReviewAgent | 语法校验集成 |
| test_review_agent_detects_invalid_diagram | ReviewAgent | 无效图检测 |
| test_requirement_analyzer_retry | RequirementAnalyzer | JSON解析失败重试 |
| test_requirement_analyzer_validate | RequirementAnalyzer | 结果完整性验证 |
| test_requirement_analyzer_validate_missing_fields | RequirementAnalyzer | 缺失字段检测 |
| test_requirement_analyzer_normalize_result | RequirementAnalyzer | LLM返回类型规范化 |
| test_config_empty_yaml | AgentConfig | 空YAML文件处理 |
| test_llm_client_json_extraction | LLMClient | JSON文本提取 |
| test_llm_client_json_completion | LLMClient | 截断JSON补全 |
| test_scorer_entity_matching | Scorer | 实体模糊匹配 |
| test_scorer_function_matching | Scorer | 功能模糊匹配 |
| test_scorer_constraint_matching | Scorer | 约束匹配算法 |

### 2.3 测试类型分布

- **正常场景测试**: 验证各模块在正常输入下的行为
- **异常场景测试**: 验证错误处理（文件不存在、空输入、格式错误、编码异常等）
- **边界场景测试**: 验证边界条件（空列表、零重试、截断JSON、路径穿越攻击等）
- **安全测试**: 路径穿越防护、prompt注入防护、文件大小限制

## 3. 基准测试方案

### 3.1 测试案例

| 编号 | 案例名称 | 难度 | 主要考察点 |
|------|----------|------|------------|
| Case 1 | 图书管理系统 | 简单 | 借阅/归还流程、图书状态机、用户角色 |
| Case 2 | 学生选课系统 | 简单 | 课程容量、选课/退课流程、多角色 |
| Case 3 | 在线商城订单系统 | 中等 | 订单状态变化、支付流程、退款 |
| Case 4 | 医院挂号系统 | 中等 | 号源管理、预约/取消流程、排班 |
| Case 5 | 会议室预约系统 | 中等 | 预约冲突、审批流程、时间约束 |

### 3.2 评价指标

| 指标 | 权重 | 计算方式 |
|------|------|----------|
| 需求覆盖率 | 40% | 覆盖功能点/约束/异常数 / 标注总数（模糊匹配） |
| 图语法通过率 | 20% | 通过图数量 / 生成图总数 |
| 实体识别准确率 | 20% | 正确实体数 / 标注实体数（中英文映射） |
| 流程完整性 | 10% | 活动图是否包含开始/结束/判断/流程覆盖 |
| 一致性 | 10% | 类图、活动图、状态图之间实体名称一致率 |

### 3.3 通过标准

综合得分 ≥ 80分为通过。

综合得分 = 需求覆盖率 × 40% + 图语法通过率 × 20% + 实体识别准确率 × 20% + 流程完整性 × 10% + 一致性 × 10%

### 3.4 最新基准测试结果

| 案例 | 需求覆盖 | 图语法 | 实体准确 | 流程完整 | 一致性 | 综合 | 通过 |
|------|----------|--------|----------|----------|--------|------|------|
| 图书管理系统 | 100.0 | 100.0 | 100.0 | 100.0 | 95.0 | 99.5 | 是 |
| 学生选课系统 | 100.0 | 100.0 | 100.0 | 83.3 | 90.0 | 97.3 | 是 |
| 在线商城 | 95.8 | 100.0 | 100.0 | 100.0 | 100.0 | 98.3 | 是 |
| 医院挂号 | 95.8 | 100.0 | 100.0 | 100.0 | 95.0 | 97.8 | 是 |
| 会议室预约 | 90.0 | 100.0 | 100.0 | 100.0 | 95.0 | 95.5 | 是 |
| **平均** | **96.3** | **100.0** | **100.0** | **96.7** | **95.0** | **97.7** | **5/5** |

## 4. 测试用例设计

### 4.1 正常场景

| 编号 | 测试对象 | 测试步骤 | 预期结果 |
|------|----------|----------|----------|
| TC-N-001 | 配置加载 | 加载有效的YAML配置文件 | 配置正确加载，validate()自动执行 |
| TC-N-002 | 需求分析 | 输入图书管理系统需求 | 输出完整JSON，字段类型正确 |
| TC-N-003 | 设计生成 | 输入需求JSON | 输出Markdown设计文档 |
| TC-N-004 | 图生成 | 输入需求和设计 | 生成3个Mermaid图，语法校验通过 |
| TC-N-005 | 测试用例生成 | 输入需求和设计 | 生成测试用例表格 |
| TC-N-006 | 完整流程 | 输入需求文档 | 生成所有输出文件，审查通过 |

### 4.2 异常场景

| 编号 | 测试对象 | 测试步骤 | 预期结果 |
|------|----------|----------|----------|
| TC-E-001 | 输入文件不存在 | 指定不存在的文件路径 | 抛出FileNotFoundError |
| TC-E-002 | 空文件输入 | 输入空文件 | 抛出ValueError |
| TC-E-003 | 不支持的格式 | 输入.pdf文件 | 抛出ValueError |
| TC-E-004 | LLM调用失败 | 模拟API错误 | 触发重试机制（指数退避） |
| TC-E-005 | JSON解析失败 | LLM返回非法JSON | 尝试截断补全，失败则重试 |
| TC-E-006 | 编码异常 | 输入GBK编码文件 | 自动识别编码并读取 |
| TC-E-007 | 文件过大 | 输入超过512KB文件 | 抛出ValueError |

### 4.3 边界场景

| 编号 | 测试对象 | 测试步骤 | 预期结果 |
|------|----------|----------|----------|
| TC-B-001 | 空需求文档 | 输入只有标题的文档 | 正常处理，结果可能不完整 |
| TC-B-002 | 截断JSON | LLM返回截断的JSON | 自动补全括号和引号 |
| TC-B-003 | 特殊字符 | 输入含特殊字符的需求 | 正常处理，不报错 |
| TC-B-004 | 最大重试次数=0 | 配置max_retries=0 | 失败直接抛出异常 |
| TC-B-005 | 路径穿越攻击 | 文件名含../../ | 被sanitize_filename拦截 |
| TC-B-006 | 空YAML配置 | 加载空配置文件 | 返回默认配置 |
| TC-B-007 | LLM返回非数组字段 | actors字段为字符串 | 自动规范化为数组 |

## 5. 局限性说明

1. **LLM输出不稳定性**：同一输入多次生成结果可能不同，评分可能有波动
2. **Mermaid校验局限**：正则校验只能检查基本语法（括号匹配、关键字、注释），无法检查语义正确性
3. **审查Agent依赖LLM**：一致性检查的准确性受LLM推理能力影响
4. **中文处理**：部分Mermaid渲染器对中文支持不完善
5. **大型需求**：超长需求文档可能导致LLM上下文溢出（已设置100K字符限制）
6. **Prompt注入**：已做基本防护（移除模板变量），但无法完全防御复杂的prompt注入攻击
7. **编码支持**：自动尝试UTF-8/GBK/Latin-1，其他编码可能失败
