"""Phase 6 测试：审查Agent与重试机制"""

import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

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

        try:
            rm.retry(fail)
        except Exception:
            pass

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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
