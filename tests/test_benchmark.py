"""Phase 8 测试：基准测试评分"""

import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from benchmark.scorer import (
    score_requirement_coverage,
    score_diagram_syntax,
    score_entity_accuracy,
    score_process_completeness,
    score_consistency,
    compute_overall_score,
)


class TestRequirementCoverage:
    def test_full_coverage(self):
        result = {
            "actors": [{"name": "学生"}, {"name": "管理员"}],
            "functions": [{"name": "用户登录"}, {"name": "图书搜索"}, {"name": "图书借阅"}],
            "entities": [{"name": "用户"}, {"name": "图书"}],
            "constraints": [{"description": "同一时间一本图书只能被一个用户借阅"}],
            "exceptions": [{"description": "图书已被借出"}],
        }
        gold = {
            "expected_actors": ["学生", "管理员"],
            "expected_functions": ["用户登录", "图书搜索", "图书借阅"],
            "expected_entities": ["用户", "图书"],
            "expected_constraints": ["同一时间一本图书只能被一个用户借阅"],
            "expected_exceptions": ["图书已被借出"],
        }
        score = score_requirement_coverage(result, gold)
        assert score == 100.0

    def test_partial_coverage(self):
        result = {
            "actors": [{"name": "学生"}],
            "functions": [{"name": "用户登录"}],
            "entities": [{"name": "用户"}],
            "constraints": [],
            "exceptions": [],
        }
        gold = {
            "expected_actors": ["学生", "管理员"],
            "expected_functions": ["用户登录", "图书搜索"],
            "expected_entities": ["用户", "图书"],
            "expected_constraints": ["约束1"],
            "expected_exceptions": ["异常1"],
        }
        score = score_requirement_coverage(result, gold)
        assert 0 < score < 100

    def test_empty_gold(self):
        result = {"actors": [], "functions": [], "entities": [], "constraints": [], "exceptions": []}
        gold = {"expected_actors": [], "expected_functions": [], "expected_entities": [], "expected_constraints": [], "expected_exceptions": []}
        score = score_requirement_coverage(result, gold)
        assert score == 100.0


class TestDiagramSyntax:
    def test_all_valid(self):
        diagrams = {
            "class_diagram": "classDiagram\n    class A {\n        +method()\n    }\n    A --> B",
            "activity_diagram": "flowchart TD\n    A([开始]) --> B[处理]\n    B --> C([结束])",
        }
        score = score_diagram_syntax(diagrams)
        assert score == 100.0

    def test_some_invalid(self):
        diagrams = {
            "class_diagram": "classDiagram\n    class A {\n        +method()\n    }\n    A --> B",
            "activity_diagram": "invalid content",
        }
        score = score_diagram_syntax(diagrams)
        assert score == 50.0

    def test_empty(self):
        score = score_diagram_syntax({})
        assert score == 0.0


class TestEntityAccuracy:
    def test_full_accuracy(self):
        result = {"entities": [{"name": "用户"}, {"name": "图书"}, {"name": "借阅记录"}]}
        gold = {"expected_entities": ["用户", "图书", "借阅记录"]}
        score = score_entity_accuracy(result, gold)
        assert score == 100.0

    def test_partial_accuracy(self):
        result = {"entities": [{"name": "用户"}]}
        gold = {"expected_entities": ["用户", "图书", "借阅记录"]}
        score = score_entity_accuracy(result, gold)
        assert 0 < score < 100


class TestProcessCompleteness:
    def test_complete_activity(self):
        diagrams = {
            "activity_diagram": "flowchart TD\n    A([开始]) --> B[用户发起请求]\n    B --> C{是否有效?}\n    C -->|是| D[处理]\n    C -->|否| E[返回错误]\n    D --> F([结束])"
        }
        gold = {"expected_processes": ["请求流程"]}
        score = score_process_completeness(diagrams, gold)
        assert score >= 75

    def test_no_activity(self):
        diagrams = {}
        gold = {"expected_processes": []}
        score = score_process_completeness(diagrams, gold)
        assert score == 0.0


class TestConsistency:
    def test_consistent(self):
        result = {"entities": [{"name": "User"}, {"name": "Book"}]}
        diagrams = {
            "class_diagram": "classDiagram\n    class User {\n        +login()\n    }\n    class Book {\n        +getInfo()\n    }\n    User --> Book",
            "activity_diagram": "flowchart TD\n    User --> Book",
        }
        score = score_consistency(result, diagrams)
        assert score >= 80

    def test_inconsistent(self):
        result = {"entities": [{"name": "User"}, {"name": "Order"}]}
        diagrams = {
            "class_diagram": "classDiagram\n    class Product",
            "activity_diagram": "flowchart TD\n    A --> B",
        }
        score = score_consistency(result, diagrams)
        assert score < 100


class TestOverallScore:
    def test_compute(self):
        score = compute_overall_score(90, 100, 80, 70, 85, 90)
        expected = 90*0.35 + 100*0.2 + 80*0.2 + 70*0.1 + 90*0.05 + 85*0.1
        assert abs(score - expected) < 0.1

    def test_perfect_score(self):
        score = compute_overall_score(100, 100, 100, 100, 100, 100)
        assert score == 100.0

    def test_zero_score(self):
        score = compute_overall_score(0, 0, 0, 0, 0, 0)
        assert score == 0.0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
