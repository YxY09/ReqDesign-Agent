"""Phase 6 测试：审查Agent与重试机制"""

import pytest
from unittest.mock import MagicMock


from agent.retry_manager import RetryManager
from agent.review_agent import ReviewAgent


class TestRetryManager:
    def test_success_first_try(self):
        rm = RetryManager(max_retries=3)
        result = rm.retry(lambda: 42)
        assert result == 42
        assert len(rm.get_history()) == 0

    def test_success_after_failures(self):
        rm = RetryManager(max_retries=3)
        call_count = [0]

        def flaky_func():
            call_count[0] += 1
            if call_count[0] < 3:
                raise ValueError("not yet")
            return "ok"

        result = rm.retry(flaky_func)
        assert result == "ok"
        assert call_count[0] == 3
        assert len(rm.get_history()) == 2  # 2 failures recorded

    def test_all_retries_fail(self):
        rm = RetryManager(max_retries=2)

        def always_fail():
            raise RuntimeError("always fails")

        with pytest.raises(RuntimeError, match="always fails"):
            rm.retry(always_fail)
        assert len(rm.get_history()) == 2

    def test_clear_history(self):
        rm = RetryManager(max_retries=1)

        def fail():
            raise Exception("fail")

        with pytest.raises(Exception):
            rm.retry(fail)

        assert rm.has_failures()
        rm.clear_history()
        assert not rm.has_failures()

    def test_max_retries_zero(self):
        rm = RetryManager(max_retries=0)
        with pytest.raises(Exception):
            rm.retry(lambda: (_ for _ in ()).throw(Exception("no retries")))


class TestReviewAgentReport:
    """测试审查报告生成"""

    def setup_method(self):
        self.agent = ReviewAgent.__new__(ReviewAgent)

    def test_generate_report_basic(self):
        review_result = {
            "overall_score": 85,
            "overall_pass": True,
            "checks": [
                {"dimension": "需求覆盖", "score": 90, "pass": True, "issues": []},
                {"dimension": "图语法", "score": 80, "pass": True, "issues": []},
            ],
            "repair_actions": [],
        }
        report = self.agent.generate_report(review_result)
        assert "85" in report
        assert "通过" in report
        assert "需求覆盖" in report
        assert "图语法" in report

    def test_generate_report_with_issues(self):
        review_result = {
            "overall_score": 60,
            "overall_pass": False,
            "checks": [
                {
                    "dimension": "需求覆盖",
                    "score": 50,
                    "pass": False,
                    "issues": ["缺少用户注册功能"],
                },
            ],
            "syntax_check": [
                {"diagram": "class_diagram", "valid": False, "message": "括号不匹配"},
            ],
            "repair_actions": [
                {"target": "class_diagram", "action": "修复括号", "priority": "高"},
            ],
        }
        report = self.agent.generate_report(review_result)
        assert "60" in report
        assert "未通过" in report
        assert "缺少用户注册功能" in report
        assert "括号不匹配" in report
        assert "修复括号" in report

    def test_generate_report_empty(self):
        report = self.agent.generate_report({})
        assert "0" in report


class TestReviewAgentMermaidValidation:
    """测试Mermaid语法校验集成"""

    def setup_method(self):
        self.agent = ReviewAgent.__new__(ReviewAgent)
        from agent.mermaid_validator import MermaidValidator
        self.agent.mermaid_validator = MermaidValidator()

    def test_validate_valid_diagrams(self):
        diagrams = {
            "class_diagram": "classDiagram\n    class User {\n        +login()\n    }\n    User --> Book",
            "activity_diagram": "flowchart TD\n    A([开始]) --> B[处理]\n    B --> C([结束])",
            "state_diagram": "stateDiagram-v2\n    [*] --> A\n    A --> [*]",
        }
        results = self.agent.validate_mermaid_syntax(diagrams)
        assert all(r["valid"] for r in results)

    def test_validate_invalid_diagram(self):
        diagrams = {
            "class_diagram": "invalid content without header",
        }
        results = self.agent.validate_mermaid_syntax(diagrams)
        assert not results[0]["valid"]


class TestReviewAgentRepair:
    """测试ReviewAgent的修复功能（mock LLM）"""

    def _make_agent(self):
        from agent.mermaid_validator import MermaidValidator
        agent = ReviewAgent.__new__(ReviewAgent)
        agent.llm = MagicMock()
        agent.mermaid_validator = MermaidValidator()
        agent.retry_manager = RetryManager(max_retries=2)
        agent.prompt_template = "审查\n{requirement_json}\n{design_text}\n{class_diagram}\n{activity_diagram}\n{state_diagram}"
        return agent

    def test_repair_diagram_success(self):
        agent = self._make_agent()
        broken = "classDiagram\n    class User {\n        +login(\n    }"
        repaired = "classDiagram\n    class User {\n        +login()\n    }"
        agent.llm.generate_text.return_value = f"```mermaid\n{repaired}\n```"

        result = agent.repair_diagram("class_diagram", broken, "括号不匹配")
        assert "classDiagram" in result
        assert "login()" in result

    def test_repair_diagram_llm_returns_original_on_failure(self):
        agent = self._make_agent()
        broken = "classDiagram\n    class User {\n        +login(\n    }"
        agent.llm.generate_text.side_effect = Exception("LLM error")

        result = agent.repair_diagram("class_diagram", broken, "括号不匹配")
        # 失败时返回原始内容
        assert result == broken

    def test_repair_diagram_retries(self):
        agent = self._make_agent()
        broken = "classDiagram\n    class A"
        agent.llm.generate_text.side_effect = [
            Exception("first fail"),
            "classDiagram\n    class A {\n        +method()\n    }",
        ]

        result = agent.repair_diagram("class_diagram", broken, "缺少class定义")
        assert "classDiagram" in result

    def test_review_and_repair_no_syntax_issues(self):
        agent = self._make_agent()
        valid_diagrams = {
            "class_diagram": "classDiagram\n    class User {\n        +login()\n    }\n    User --> Book",
            "activity_diagram": "flowchart TD\n    A([开始]) --> B([结束])",
            "state_diagram": "stateDiagram-v2\n    [*] --> A\n    A --> [*]",
        }
        # Mock LLM review to return passing result
        agent.llm.generate_json.return_value = {
            "overall_score": 85,
            "overall_pass": True,
            "checks": [],
        }

        review_result, repaired = agent.review_and_repair(
            {"functions": []}, "设计说明", valid_diagrams
        )
        assert review_result["overall_score"] == 85
        assert repaired == valid_diagrams

    def test_review_and_repair_with_syntax_issues(self):
        agent = self._make_agent()
        broken_diagrams = {
            "class_diagram": "classDiagram\n    class User {\n        +login(\n    }",
            "activity_diagram": "flowchart TD\n    A([开始]) --> B([结束])",
            "state_diagram": "stateDiagram-v2\n    [*] --> A\n    A --> [*]",
        }
        # Mock LLM review
        agent.llm.generate_json.return_value = {
            "overall_score": 60,
            "overall_pass": False,
            "checks": [],
        }
        # Mock repair to return fixed diagram
        agent.llm.generate_text.return_value = "classDiagram\n    class User {\n        +login()\n    }\n    User --> Book"

        review_result, repaired = agent.review_and_repair(
            {"functions": []}, "设计说明", broken_diagrams, max_repair_rounds=1
        )
        # class_diagram should have been repaired
        assert "login()" in repaired["class_diagram"]

    def test_review_and_repair_multi_round(self):
        agent = self._make_agent()
        broken_diagrams = {
            "class_diagram": "classDiagram\n    class User {\n        +login(\n    }",
        }
        agent.llm.generate_json.return_value = {
            "overall_score": 60,
            "overall_pass": False,
            "checks": [],
        }
        # First repair attempt still broken, second succeeds
        agent.llm.generate_text.side_effect = [
            "classDiagram\n    class User {\n        +login(\n    }",  # still broken
            "classDiagram\n    class User {\n        +login()\n    }",  # fixed
        ]

        review_result, repaired = agent.review_and_repair(
            {"functions": []}, "设计说明", broken_diagrams, max_repair_rounds=2
        )
        assert "login()" in repaired["class_diagram"]


class TestReviewAgentLLMException:
    """测试review()中LLM异常的fallback"""

    def test_review_llm_exception_returns_zero_score(self):
        """LLM审查失败时返回零分fallback"""
        mock_llm = MagicMock()
        mock_llm.generate_json.side_effect = RuntimeError("LLM服务不可用")
        agent = ReviewAgent(mock_llm, max_retries=1)

        result = agent.review(
            {"functions": []},
            "设计说明",
            {"class_diagram": "classDiagram\n    class A"},
        )

        assert result["overall_score"] == 0
        assert result["overall_pass"] is False
        assert result["checks"] == []
        assert result["repair_actions"] == []
        # 语法检查结果仍应存在
        assert "syntax_check" in result

    def test_review_llm_exception_with_invalid_diagram(self):
        """LLM失败+语法错误时分数仍为0"""
        mock_llm = MagicMock()
        mock_llm.generate_json.side_effect = TimeoutError("超时")
        agent = ReviewAgent(mock_llm, max_retries=1)

        result = agent.review(
            {"functions": []},
            "设计说明",
            {"class_diagram": "invalid mermaid content"},
        )

        assert result["overall_score"] == 0
        assert result["overall_pass"] is False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
