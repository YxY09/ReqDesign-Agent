"""集成测试：验证完整工作流（mock LLM调用）"""

import json
import os
import sys
import pytest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.config import AgentConfig
from agent.input_loader import InputLoader
from agent.requirement_analyzer import RequirementAnalyzer
from agent.design_planner import DesignPlanner
from agent.diagram_generator import DiagramGenerator
from agent.mermaid_validator import MermaidValidator
from agent.test_case_generator import TestCaseGenerator
from agent.review_agent import ReviewAgent
from agent.output_manager import OutputManager
from agent.output_manager import _sanitize_filename
from agent.config import AgentConfig

SAMPLE_REQUIREMENT = """# 简单计算器系统
## 用户角色
- 普通用户：使用计算器进行基本运算
## 功能需求
1. 加法运算：用户输入两个数字，系统返回它们的和
2. 减法运算：用户输入两个数字，系统返回它们的差
"""

MOCK_REQUIREMENT_JSON = {
    "project_name": "简单计算器",
    "project_overview": "一个简单的计算器系统",
    "actors": [{"name": "普通用户", "description": "使用计算器"}],
    "functions": [
        {"id": "F001", "name": "加法运算", "description": "求和", "related_actors": ["普通用户"], "priority": "高"},
        {"id": "F002", "name": "减法运算", "description": "求差", "related_actors": ["普通用户"], "priority": "高"},
    ],
    "entities": [{"name": "计算器", "description": "计算工具", "attributes": ["操作数", "运算符"]}],
    "constraints": [],
    "exceptions": [],
    "non_functional_requirements": [],
    "business_processes": [],
}

MOCK_DESIGN_TEXT = """# 系统设计
## 模块划分
- 计算模块：处理加减乘除运算
## 核心类
- Calculator：执行计算操作
"""

MOCK_CLASS_DIAGRAM = """classDiagram
    class 计算器 {
        -double 操作数1
        -double 操作数2
        +加法() double
        +减法() double
    }
"""

MOCK_ACTIVITY_DIAGRAM = """flowchart TD
    A([开始]) --> B[输入两个数字]
    B --> C[选择运算类型]
    C --> D[执行计算]
    D --> E[显示结果]
    E --> F([结束])
"""

MOCK_STATE_DIAGRAM = """stateDiagram-v2
    [*] --> 空闲
    空闲 --> 计算中 : 输入数据
    计算中 --> 显示结果 : 计算完成
    显示结果 --> 空闲 : 重置
    空闲 --> [*]
"""

MOCK_TEST_CASES = """# 测试用例

| 编号 | 描述 | 输入 | 预期结果 | 类型 |
|------|------|------|----------|------|
| TC001 | 加法正常 | 2, 3 | 5 | 正常 |
| TC002 | 减法正常 | 5, 3 | 2 | 正常 |
"""


class TestIntegrationWorkflow:
    """集成测试：验证各模块协作"""

    def test_input_loader(self, tmp_path):
        """测试输入加载"""
        req_file = tmp_path / "test_req.md"
        req_file.write_text(SAMPLE_REQUIREMENT)
        loader = InputLoader()
        text = loader.load(str(req_file))
        assert "计算器" in text
        assert len(text) > 0

    def test_input_loader_file_size_guard(self, tmp_path):
        """测试文件大小限制"""
        big_file = tmp_path / "big.md"
        big_file.write_text("x" * (512 * 1024 + 1))
        loader = InputLoader()
        with pytest.raises(ValueError, match="文件过大"):
            loader.load(str(big_file))

    def test_input_loader_encoding_fallback(self, tmp_path):
        """测试编码容错"""
        gbk_file = tmp_path / "gbk.md"
        gbk_file.write_bytes("# 需求\n中文内容".encode("gbk"))
        loader = InputLoader()
        text = loader.load(str(gbk_file))
        assert "中文内容" in text

    def test_input_loader_split_sections_code_fence(self):
        """测试代码围栏内的#号不被当作标题"""
        loader = InputLoader()
        text = """# 标题一
内容1

```python
# 这是注释，不是标题
def foo():
    pass
```

# 标题二
内容2
"""
        sections = loader.split_sections(text)
        assert len(sections) == 2
        assert sections[0]["title"] == "标题一"
        assert sections[1]["title"] == "标题二"
        # 代码围栏内容应保留在段落中
        assert "```python" in sections[0]["content"]

    def test_diagram_generator_extract_mermaid(self):
        """测试Mermaid代码提取"""
        gen = DiagramGenerator.__new__(DiagramGenerator)

        # 从代码块中提取
        raw = '这是类图：\n```mermaid\nclassDiagram\n    class Foo\n```\n结束'
        assert gen._extract_mermaid(raw, "classDiagram").startswith("classDiagram")

        # 多个代码块时优先选含Mermaid关键字的
        raw = '说明：\n```python\nprint("hi")\n```\n类图：\n```mermaid\nclassDiagram\n    class Bar\n```'
        result = gen._extract_mermaid(raw, "classDiagram")
        assert "classDiagram" in result
        assert "print" not in result

        # 直接Mermaid代码（无代码块）
        raw = "flowchart TD\n    A --> B"
        assert gen._extract_mermaid(raw, "flowchart") == raw

        # graph关键字
        raw = "graph TD\n    A --> B"
        assert gen._extract_mermaid(raw, "flowchart") == raw

    def test_mermaid_validator(self):
        """测试Mermaid语法校验"""
        validator = MermaidValidator()
        valid, msg = validator.validate(MOCK_CLASS_DIAGRAM, "class_diagram")
        assert valid, f"类图校验失败: {msg}"

        valid, msg = validator.validate(MOCK_ACTIVITY_DIAGRAM, "activity_diagram")
        assert valid, f"活动图校验失败: {msg}"

        valid, msg = validator.validate(MOCK_STATE_DIAGRAM, "state_diagram")
        assert valid, f"状态图校验失败: {msg}"

    def test_mermaid_validator_inline_comment(self):
        """测试Mermaid行内注释处理"""
        validator = MermaidValidator()
        diagram_with_comment = """flowchart TD
    A([开始]) --> B[输入] %% 这是注释
    B --> C[处理]
    C --> D([结束])
"""
        valid, msg = validator.validate(diagram_with_comment, "activity_diagram")
        assert valid, f"带注释的流程图校验失败: {msg}"

    def test_mermaid_validator_comment_positions(self):
        """测试注释位置检测"""
        content = "line1\n%% comment\nline3 %% inline\nline4"
        positions = MermaidValidator._find_comment_positions(content)
        # 行首注释 %% comment 的位置
        assert 6 in positions   # '%%' 的第一个 %
        assert 9 in positions   # 'c' of 'comment'
        # 行内注释 %% inline 的位置
        assert 23 in positions  # '%%' 的第一个 %
        assert 26 in positions  # 'i' of 'inline'
        # 非注释位置
        assert 0 not in positions  # 'l' of 'line1'
        assert 16 not in positions  # 换行符

    def test_output_manager(self, tmp_path):
        """测试输出管理"""
        manager = OutputManager(str(tmp_path))
        manager.save_requirement_analysis(MOCK_REQUIREMENT_JSON)
        manager.save_system_design(MOCK_DESIGN_TEXT)
        manager.save_diagrams({
            "class_diagram": MOCK_CLASS_DIAGRAM,
            "activity_diagram": MOCK_ACTIVITY_DIAGRAM,
            "state_diagram": MOCK_STATE_DIAGRAM,
        })
        manager.save_test_cases(MOCK_TEST_CASES)

        # 验证文件生成
        assert (tmp_path / "requirement_analysis.json").exists()
        assert (tmp_path / "requirement_analysis.md").exists()
        assert (tmp_path / "system_design.md").exists()
        assert (tmp_path / "class_diagram.mmd").exists()
        assert (tmp_path / "activity_diagram.mmd").exists()
        assert (tmp_path / "state_diagram.mmd").exists()
        assert (tmp_path / "test_cases.md").exists()

    def test_output_manager_json_roundtrip(self, tmp_path):
        """测试JSON输出可正确读回"""
        manager = OutputManager(str(tmp_path))
        manager.save_requirement_analysis(MOCK_REQUIREMENT_JSON)

        with open(tmp_path / "requirement_analysis.json", "r", encoding="utf-8") as f:
            loaded = json.load(f)
        assert loaded["project_name"] == "简单计算器"
        assert len(loaded["functions"]) == 2
        assert loaded["functions"][0]["id"] == "F001"

    def test_review_agent_syntax_validation(self):
        """测试审查Agent语法校验"""
        mock_llm = MagicMock()
        agent = ReviewAgent(mock_llm)
        results = agent.validate_mermaid_syntax({
            "class_diagram": MOCK_CLASS_DIAGRAM,
            "activity_diagram": MOCK_ACTIVITY_DIAGRAM,
            "state_diagram": MOCK_STATE_DIAGRAM,
        })
        assert all(r["valid"] for r in results)
        assert len(results) == 3

    def test_review_agent_detects_invalid_diagram(self):
        """测试审查Agent检测无效图"""
        mock_llm = MagicMock()
        agent = ReviewAgent(mock_llm)
        invalid_diagram = "this is not valid mermaid"
        results = agent.validate_mermaid_syntax({
            "class_diagram": invalid_diagram,
        })
        assert not results[0]["valid"]

    def test_requirement_analyzer_retry(self):
        """测试需求分析重试机制"""
        mock_llm = MagicMock()
        mock_llm.generate_json.side_effect = [
            json.JSONDecodeError("test", "", 0),
            MOCK_REQUIREMENT_JSON,
        ]
        analyzer = RequirementAnalyzer(mock_llm)
        result = analyzer.analyze("test requirement")
        assert result["project_name"] == "简单计算器"
        assert mock_llm.generate_json.call_count == 2

    def test_requirement_analyzer_validate(self):
        """测试需求分析结果验证"""
        mock_llm = MagicMock()
        analyzer = RequirementAnalyzer(mock_llm)
        warnings = analyzer.validate_result(MOCK_REQUIREMENT_JSON)
        assert len(warnings) == 0

    def test_requirement_analyzer_validate_missing_fields(self):
        """测试需求分析缺失字段检测"""
        mock_llm = MagicMock()
        analyzer = RequirementAnalyzer(mock_llm)
        incomplete = {"actors": [], "functions": []}  # 缺少 entities
        warnings = analyzer.validate_result(incomplete)
        assert any("entities" in w for w in warnings)

    def test_llm_client_json_extraction(self):
        """测试LLM客户端JSON提取"""
        from agent.llm_client import LLMClient
        mock_config = AgentConfig()
        mock_config.llm.provider = "openai"
        mock_config.llm.api_key = "test"
        client = LLMClient.__new__(LLMClient)

        # 测试从代码块提取
        raw = '```json\n{"key": "value"}\n```'
        result = client._extract_json_text(raw)
        assert result == '{"key": "value"}'

        # 测试从混合文本提取
        raw = 'Here is the result:\n{"key": "value"}\nDone.'
        result = client._extract_json_text(raw)
        assert result == '{"key": "value"}'

    def test_llm_client_json_completion(self):
        """测试LLM客户端截断JSON补全"""
        from agent.llm_client import LLMClient
        client = LLMClient.__new__(LLMClient)

        # 测试截断的JSON补全
        truncated = '{"name": "test", "items": [1, 2'
        completed = client._try_complete_json(truncated)
        parsed = json.loads(completed)
        assert parsed["name"] == "test"
        assert parsed["items"] == [1, 2]

    def test_scorer_entity_matching(self):
        """测试评分器实体模糊匹配"""
        from benchmark.scorer import _fuzzy_match_entity

        # 直接匹配
        assert _fuzzy_match_entity("图书", "图书信息")
        # 中英文匹配
        assert _fuzzy_match_entity("图书", "Book")
        assert _fuzzy_match_entity("员工", "用户")
        # 不匹配
        assert not _fuzzy_match_entity("图书", "课程")

    def test_scorer_function_matching(self):
        """测试评分器功能模糊匹配"""
        from benchmark.scorer import _fuzzy_match_function

        result_funcs = ["用户注册与登录", "图书搜索", "图书借阅"]
        result_text = " ".join(result_funcs)

        # 直接匹配
        assert _fuzzy_match_function("图书搜索", result_funcs, result_text)
        # 关键词匹配："用户登录" 在 "用户注册与登录" 中
        assert _fuzzy_match_function("用户登录", result_funcs, result_text)
        # 同义词匹配
        assert _fuzzy_match_function("登录", result_funcs, result_text)
        assert _fuzzy_match_function("注册", result_funcs, result_text)
        # 不匹配
        assert not _fuzzy_match_function("成绩录入", result_funcs, result_text)

    def test_input_loader_empty_file(self, tmp_path):
        """测试空文件处理"""
        empty_file = tmp_path / "empty.md"
        empty_file.write_text("")
        loader = InputLoader()
        with pytest.raises(ValueError, match="为空"):
            loader.load(str(empty_file))

    def test_input_loader_unsupported_extension(self, tmp_path):
        """测试不支持的文件扩展名"""
        bad_file = tmp_path / "test.xyz"
        bad_file.write_text("content")
        loader = InputLoader()
        with pytest.raises(ValueError, match="不支持"):
            loader.load(str(bad_file))

    def test_sanitize_filename_path_traversal(self):
        """测试文件名路径穿越防护"""
        assert _sanitize_filename("../../etc/passwd") == "____etc_passwd"
        assert _sanitize_filename("../../../root") == "______root"
        assert _sanitize_filename("test/../../../etc/passwd") == "test_______etc_passwd"
        assert _sanitize_filename("normal_file.md") == "normal_file.md"

    def test_config_empty_yaml(self, tmp_path):
        """测试空YAML配置文件"""
        empty_yaml = tmp_path / "empty.yaml"
        empty_yaml.write_text("")
        config = AgentConfig.load_from_yaml(str(empty_yaml))
        assert config.llm.provider == "openai"  # 默认值

    def test_requirement_analyzer_normalize_result(self):
        """测试需求分析结果类型规范化"""
        mock_llm = MagicMock()
        analyzer = RequirementAnalyzer(mock_llm)
        # LLM返回字符串而非数组
        result = {"actors": "none", "functions": "用户登录", "entities": []}
        normalized = analyzer._normalize_result(result)
        assert normalized["actors"] == []
        assert normalized["functions"] == ["用户登录"]
        assert normalized["entities"] == []

    def test_scorer_constraint_matching(self):
        """测试约束匹配"""
        from benchmark.scorer import _match_constraint_or_exception

        # 直接匹配
        assert _match_constraint_or_exception("库存不足不能下单", "库存不足时不允许下单")
        # 数字量词匹配
        assert _match_constraint_or_exception("30分钟未支付取消", "订单超时未支付（30分钟）自动取消")
        # 关键词多数匹配
        assert _match_constraint_or_exception("课程人数限制", "每门课程有最大选课人数限制")
        # 不匹配
        assert not _match_constraint_or_exception("完全无关的约束", "库存不足不能下单")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
