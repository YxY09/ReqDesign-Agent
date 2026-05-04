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

    def test_mermaid_validator(self):
        """测试Mermaid语法校验"""
        validator = MermaidValidator()
        valid, msg = validator.validate(MOCK_CLASS_DIAGRAM, "class_diagram")
        assert valid, f"类图校验失败: {msg}"

        valid, msg = validator.validate(MOCK_ACTIVITY_DIAGRAM, "activity_diagram")
        assert valid, f"活动图校验失败: {msg}"

        valid, msg = validator.validate(MOCK_STATE_DIAGRAM, "state_diagram")
        assert valid, f"状态图校验失败: {msg}"

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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
