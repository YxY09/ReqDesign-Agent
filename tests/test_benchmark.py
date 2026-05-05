"""Phase 8 测试：基准测试评分"""

import pytest


from benchmark.scorer import (
    score_requirement_coverage,
    score_diagram_syntax,
    score_entity_accuracy,
    score_process_completeness,
    score_state_diagram,
    score_consistency,
    compute_overall_score,
    compute_run_summary,
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

    def test_none_values_in_result(self):
        """result dict中字段值为None时不崩溃"""
        result = {"actors": None, "functions": None, "entities": None, "constraints": None, "exceptions": None}
        gold = {
            "expected_actors": ["管理员"],
            "expected_functions": ["用户登录"],
            "expected_entities": ["用户"],
            "expected_constraints": ["约束1"],
            "expected_exceptions": ["异常1"],
        }
        score = score_requirement_coverage(result, gold)
        assert score == 0.0


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

    def test_none_entities(self):
        """entities为None时不崩溃"""
        result = {"entities": None}
        gold = {"expected_entities": ["用户"]}
        score = score_entity_accuracy(result, gold)
        assert score == 0.0


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

    def test_none_entities(self):
        """entities为None时不崩溃"""
        result = {"entities": None}
        diagrams = {"class_diagram": "classDiagram\n    class A", "activity_diagram": ""}
        score = score_consistency(result, diagrams)
        assert score == 100.0


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


class TestStateDiagram:
    def test_complete_state_diagram(self):
        diagrams = {
            "state_diagram": """stateDiagram-v2
    [*] --> 待借阅
    待借阅 --> 借阅中 : 借阅
    借阅中 --> 已归还 : 归还
    已归还 --> [*]"""
        }
        gold = {"expected_processes": ["借阅流程"]}
        score = score_state_diagram(diagrams, gold)
        assert score >= 70

    def test_no_state_diagram(self):
        diagrams = {}
        gold = {"expected_processes": []}
        score = score_state_diagram(diagrams, gold)
        assert score == 0.0

    def test_minimal_state_diagram(self):
        diagrams = {
            "state_diagram": "stateDiagram-v2\n    [*] --> A\n    A --> [*]"
        }
        gold = {"expected_processes": []}
        score = score_state_diagram(diagrams, gold)
        assert score >= 50  # has [*] and -->


class TestRunSummary:
    def test_all_success(self):
        results = [
            {"case_name": "A", "status": "success", "passed": True, "scores": {"overall": 90, "requirement_coverage": 95}},
            {"case_name": "B", "status": "success", "passed": True, "scores": {"overall": 85, "requirement_coverage": 90}},
        ]
        summary = compute_run_summary(results)
        assert summary["passed"] == 2
        assert summary["failed"] == 0
        assert summary["error"] == 0
        assert summary["avg_scores"]["overall"] == 87.5

    def test_mixed_results(self):
        results = [
            {"case_name": "A", "status": "success", "passed": True, "scores": {"overall": 90}},
            {"case_name": "B", "status": "success", "passed": False, "scores": {"overall": 60}},
            {"case_name": "C", "status": "error", "error": "timeout"},
        ]
        summary = compute_run_summary(results)
        assert summary["passed"] == 1
        assert summary["failed"] == 1
        assert summary["error"] == 1

    def test_all_error(self):
        results = [
            {"case_name": "A", "status": "error", "error": "fail"},
        ]
        summary = compute_run_summary(results)
        assert summary["passed"] == 0
        assert summary["avg_scores"] == {}

    def test_empty_results(self):
        summary = compute_run_summary([])
        assert summary["passed"] == 0
        assert summary["error"] == 0


class TestEvaluationManager:
    """测试EvaluationManager"""

    def _make_manager(self):
        from governance.evaluation_manager import EvaluationManager
        from agent.config import AgentConfig
        return EvaluationManager(AgentConfig())

    def test_merge_runs_averages_scores(self):
        """多次运行结果取平均"""
        import tempfile
        mgr = self._make_manager()
        reports = [
            {"results": [
                {"case_name": "case1", "status": "success", "scores": {"overall": 80, "requirement_coverage": 90, "diagram_syntax": 100, "entity_accuracy": 80, "process_completeness": 70, "state_diagram": 85, "consistency": 95}},
            ]},
            {"results": [
                {"case_name": "case1", "status": "success", "scores": {"overall": 90, "requirement_coverage": 95, "diagram_syntax": 100, "entity_accuracy": 90, "process_completeness": 80, "state_diagram": 85, "consistency": 95}},
            ]},
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            merged = mgr._merge_runs(reports, tmpdir)
        assert merged["total_runs"] == 2
        assert len(merged["results"]) == 1
        case1 = merged["results"][0]
        assert case1["case_name"] == "case1"
        assert case1["status"] == "success"
        assert case1["scores"]["overall"] == 85.0
        assert case1["runs"] == 2

    def test_merge_runs_all_failed(self):
        """所有运行都失败时scores填充0.0"""
        import tempfile
        mgr = self._make_manager()
        reports = [
            {"results": [
                {"case_name": "case1", "status": "error", "scores": {}},
            ]},
            {"results": [
                {"case_name": "case1", "status": "error", "scores": {}},
            ]},
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            merged = mgr._merge_runs(reports, tmpdir)
        case1 = merged["results"][0]
        assert case1["status"] == "error"
        assert case1["scores"]["overall"] == 0.0
        assert case1["runs"] == 0

    def test_merge_runs_empty_reports(self):
        """空报告列表返回空字典"""
        mgr = self._make_manager()
        result = mgr._merge_runs([], "/tmp")
        assert result == {}

    def test_run_benchmark_runs_lt_1_raises(self):
        """runs<1时抛出ValueError"""
        mgr = self._make_manager()
        import pytest
        with pytest.raises(ValueError, match="runs must be >= 1"):
            mgr.run_benchmark(runs=0)

    def test_run_benchmark_records_history(self):
        """运行后history应有记录"""
        import tempfile
        from unittest.mock import patch, MagicMock
        mgr = self._make_manager()
        mock_report = {"results": [], "summary": {"passed": 0, "failed": 0, "error": 0, "avg_scores": {}}}
        with patch("governance.evaluation_manager.BenchmarkRunner") as MockRunner:
            MockRunner.return_value.run_all.return_value = mock_report
            with tempfile.TemporaryDirectory() as tmpdir:
                mgr.run_benchmark(output_dir=tmpdir)
        assert len(mgr.history) == 1
        assert "timestamp" in mgr.history[0]


class TestBenchmarkRunner:
    """测试BenchmarkRunner"""

    def test_find_cases_missing_dir(self):
        """案例目录不存在时抛出FileNotFoundError"""
        from benchmark.run_benchmark import BenchmarkRunner
        from agent.config import AgentConfig
        runner = BenchmarkRunner(AgentConfig(), "/nonexistent", "/nonexistent", "/tmp")
        import pytest
        with pytest.raises(FileNotFoundError):
            runner.find_cases()

    def test_find_cases_with_files(self, tmp_path):
        """正常查找案例和gold label"""
        from benchmark.run_benchmark import BenchmarkRunner
        from agent.config import AgentConfig
        cases_dir = tmp_path / "cases"
        gold_dir = tmp_path / "gold"
        cases_dir.mkdir()
        gold_dir.mkdir()
        (cases_dir / "case1.md").write_text("# Case 1")
        (cases_dir / "case2.md").write_text("# Case 2")
        (gold_dir / "case1.json").write_text("{}")
        # case2 has no gold label
        runner = BenchmarkRunner(AgentConfig(), str(cases_dir), str(gold_dir), str(tmp_path / "out"))
        cases = runner.find_cases()
        assert len(cases) == 1
        assert cases[0]["name"] == "case1"

    def test_generate_md_report_structure(self):
        """Markdown报告结构正确"""
        from benchmark.run_benchmark import BenchmarkRunner
        from agent.config import AgentConfig
        runner = BenchmarkRunner(AgentConfig(), "", "", "")
        report = {
            "run_time": "2025-01-01 00:00:00",
            "total_cases": 1,
            "results": [
                {"case_name": "test", "status": "success", "passed": True,
                 "scores": {"requirement_coverage": 100, "diagram_syntax": 100,
                            "entity_accuracy": 100, "process_completeness": 100,
                            "state_diagram": 100, "consistency": 100, "overall": 100}},
            ],
            "summary": {"passed": 1, "failed": 0, "error": 0, "avg_scores": {"overall": 100}},
        }
        md = runner._generate_md_report(report)
        assert "# 基准测试报告" in md
        assert "| 案例 |" in md
        assert "test" in md
        assert "100" in md

    def test_generate_md_report_error_case(self):
        """错误案例在报告中显示-"""
        from benchmark.run_benchmark import BenchmarkRunner
        from agent.config import AgentConfig
        runner = BenchmarkRunner(AgentConfig(), "", "", "")
        report = {
            "run_time": "2025-01-01 00:00:00",
            "total_cases": 1,
            "results": [
                {"case_name": "fail", "status": "error", "error": "timeout"},
            ],
            "summary": {"passed": 0, "failed": 0, "error": 1, "avg_scores": {}},
        }
        md = runner._generate_md_report(report)
        assert "fail" in md
        assert "error" in md
        assert "| - |" in md


class TestWeightValidation:
    def test_weights_sum_to_one(self):
        """验证评分权重总和为1.0"""
        weights = [0.35, 0.20, 0.20, 0.10, 0.05, 0.10]
        assert abs(sum(weights) - 1.0) < 1e-9

    def test_compute_uses_keyword_args(self):
        """使用关键字参数避免位置错误"""
        score = compute_overall_score(
            requirement_coverage=90, diagram_syntax=100,
            entity_accuracy=80, process_completeness=70,
            consistency=85, state_diagram=90
        )
        expected = 90*0.35 + 100*0.2 + 80*0.2 + 70*0.1 + 90*0.05 + 85*0.1
        assert abs(score - expected) < 0.1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
