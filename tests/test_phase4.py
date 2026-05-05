"""Phase 4 测试：图模型生成与Mermaid校验"""

import os
import sys
import pytest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.mermaid_validator import MermaidValidator
from agent.diagram_generator import DiagramGenerator


class TestMermaidValidator:
    def setup_method(self):
        self.validator = MermaidValidator(use_cli=False)

    def test_empty_content(self):
        is_valid, msg = self.validator.validate("")
        assert not is_valid
        assert "为空" in msg

    def test_no_header(self):
        is_valid, msg = self.validator.validate("A --> B")
        assert not is_valid
        assert "图类型声明" in msg

    def test_valid_class_diagram(self):
        content = """classDiagram
    class User {
        -int id
        -String name
        +login()
    }
    class Book {
        -int id
        -String title
    }
    User --> Book : borrows"""
        is_valid, msg = self.validator.validate(content, "classDiagram")
        assert is_valid
        assert "通过" in msg

    def test_class_diagram_no_class(self):
        content = "classDiagram\n    A --> B"
        is_valid, msg = self.validator.validate(content, "classDiagram")
        assert not is_valid
        assert "class 定义" in msg

    def test_valid_flowchart(self):
        content = """flowchart TD
    A([开始]) --> B[处理请求]
    B --> C{判断}
    C -->|是| D[执行]
    C -->|否| E[结束]
    D --> E"""
        is_valid, msg = self.validator.validate(content, "flowchart")
        assert is_valid

    def test_flowchart_no_connection(self):
        content = "flowchart TD\n    A[节点A]\n    B[节点B]"
        is_valid, msg = self.validator.validate(content, "flowchart")
        assert not is_valid
        assert "连接关系" in msg

    def test_valid_state_diagram(self):
        content = """stateDiagram-v2
    [*] --> 待处理
    待处理 --> 处理中 : 开始处理
    处理中 --> 已完成 : 处理完成
    已完成 --> [*]"""
        is_valid, msg = self.validator.validate(content, "stateDiagram-v2")
        assert is_valid

    def test_unmatched_brackets(self):
        content = """classDiagram
    class User {
        -int id
        +login(
    }"""
        is_valid, msg = self.validator.validate(content)
        assert not is_valid
        assert "不匹配" in msg or "未闭合" in msg

    def test_only_header(self):
        content = "classDiagram"
        is_valid, msg = self.validator.validate(content)
        assert not is_valid
        assert "过少" in msg

    def test_validate_and_report_success(self):
        content = """classDiagram
    class User {
        +login()
    }
    User --> Book"""
        report = self.validator.validate_and_report(content, "类图")
        assert "通过" in report
        assert "类图" in report

    def test_validate_and_report_failure(self):
        content = "invalid content"
        report = self.validator.validate_and_report(content, "类图")
        assert "失败" in report


class TestDiagramGeneratorExtraction:
    """测试DiagramGenerator的Mermaid提取逻辑"""

    def setup_method(self):
        self.gen = DiagramGenerator.__new__(DiagramGenerator)

    def test_extract_from_code_block(self):
        raw = "这是类图：\n```mermaid\nclassDiagram\n    class A\n```\n结束"
        result = self.gen._extract_mermaid(raw, "classDiagram")
        assert result.startswith("classDiagram")
        assert "class A" in result

    def test_extract_from_plain(self):
        raw = "classDiagram\n    class A {\n        +method()\n    }"
        result = self.gen._extract_mermaid(raw, "classDiagram")
        assert result.startswith("classDiagram")

    def test_extract_flowchart(self):
        raw = "```mermaid\nflowchart TD\n    A --> B\n```"
        result = self.gen._extract_mermaid(raw, "flowchart")
        assert result.startswith("flowchart")

    def test_extract_state_diagram(self):
        raw = "以下是状态图：\n```mermaid\nstateDiagram-v2\n    [*] --> A\n```"
        result = self.gen._extract_mermaid(raw, "stateDiagram-v2")
        assert result.startswith("stateDiagram-v2")


class TestDiagramGeneratorMethods:
    """测试DiagramGenerator的生成方法（mock LLM）"""

    def _make_gen(self):
        mock_llm = MagicMock()
        gen = DiagramGenerator.__new__(DiagramGenerator)
        gen.llm = mock_llm
        gen.prompts = {
            "class_diagram": "生成类图\n{requirement_json}\n{design_text}",
            "activity_diagram": "生成活动图\n{requirement_json}\n{design_text}",
            "state_diagram": "生成状态图\n{requirement_json}\n{design_text}",
        }
        return gen, mock_llm

    def test_generate_class_diagram(self):
        gen, mock_llm = self._make_gen()
        mock_llm.generate_text.return_value = "```mermaid\nclassDiagram\n    class User\n```"
        result = gen.generate_class_diagram({"functions": []}, "设计说明")
        assert "classDiagram" in result
        assert "User" in result
        mock_llm.generate_text.assert_called_once()

    def test_generate_activity_diagram(self):
        gen, mock_llm = self._make_gen()
        mock_llm.generate_text.return_value = "```mermaid\nflowchart TD\n    A --> B\n```"
        result = gen.generate_activity_diagram({"functions": []}, "设计说明")
        assert "flowchart" in result
        mock_llm.generate_text.assert_called_once()

    def test_generate_state_diagram(self):
        gen, mock_llm = self._make_gen()
        mock_llm.generate_text.return_value = "```mermaid\nstateDiagram-v2\n    [*] --> A\n```"
        result = gen.generate_state_diagram({"functions": []}, "设计说明")
        assert "stateDiagram-v2" in result
        mock_llm.generate_text.assert_called_once()

    def test_generate_all_success(self):
        gen, mock_llm = self._make_gen()
        mock_llm.generate_text.side_effect = [
            "classDiagram\n    class A",
            "flowchart TD\n    A --> B",
            "stateDiagram-v2\n    [*] --> A",
        ]
        result = gen.generate_all({"functions": []}, "设计说明")
        assert "class_diagram" in result
        assert "activity_diagram" in result
        assert "state_diagram" in result
        assert "classDiagram" in result["class_diagram"]
        assert "flowchart" in result["activity_diagram"]
        assert "stateDiagram-v2" in result["state_diagram"]

    def test_generate_all_partial_failure(self):
        gen, mock_llm = self._make_gen()
        mock_llm.generate_text.side_effect = [
            "classDiagram\n    class A",
            Exception("LLM timeout"),
            "stateDiagram-v2\n    [*] --> A",
        ]
        result = gen.generate_all({"functions": []}, "设计说明")
        assert "classDiagram" in result["class_diagram"]
        assert result["activity_diagram"] == ""
        assert "stateDiagram-v2" in result["state_diagram"]

    def test_generate_all_total_failure(self):
        gen, mock_llm = self._make_gen()
        mock_llm.generate_text.side_effect = Exception("API error")
        result = gen.generate_all({"functions": []}, "设计说明")
        assert result["class_diagram"] == ""
        assert result["activity_diagram"] == ""
        assert result["state_diagram"] == ""


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
