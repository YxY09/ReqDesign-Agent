"""Phase 7 测试：工作流编排与CLI"""

import json
import pytest


from agent.output_manager import OutputManager


class TestOutputManager:
    def test_save_requirement_analysis(self, tmp_path):
        mgr = OutputManager(str(tmp_path))
        req = {
            "project_name": "测试项目",
            "actors": [{"name": "用户", "description": "系统用户"}],
            "functions": [{"id": "F001", "name": "登录", "description": "用户登录"}],
            "entities": [{"name": "User", "description": "用户实体", "attributes": ["id", "name"]}],
            "constraints": [],
            "exceptions": [],
            "non_functional_requirements": [],
            "business_processes": [],
        }
        mgr.save_requirement_analysis(req)

        # 检查JSON文件
        json_path = tmp_path / "requirement_analysis.json"
        assert json_path.exists()
        saved = json.loads(json_path.read_text(encoding="utf-8"))
        assert saved["project_name"] == "测试项目"

        # 检查MD文件
        md_path = tmp_path / "requirement_analysis.md"
        assert md_path.exists()
        md_content = md_path.read_text(encoding="utf-8")
        assert "测试项目" in md_content
        assert "用户" in md_content

    def test_save_diagrams(self, tmp_path):
        mgr = OutputManager(str(tmp_path))
        diagrams = {
            "class_diagram": "classDiagram\n    class A",
            "activity_diagram": "flowchart TD\n    A --> B",
        }
        mgr.save_diagrams(diagrams)

        assert (tmp_path / "class_diagram.mmd").exists()
        assert (tmp_path / "activity_diagram.mmd").exists()

    def test_save_test_cases(self, tmp_path):
        mgr = OutputManager(str(tmp_path))
        mgr.save_test_cases("| TC-N-001 | 正常 |")
        assert (tmp_path / "test_cases.md").exists()

    def test_save_all(self, tmp_path):
        mgr = OutputManager(str(tmp_path))
        mgr.save_all(
            requirement_json={"project_name": "test", "actors": [], "functions": [], "entities": [], "constraints": [], "exceptions": [], "non_functional_requirements": [], "business_processes": []},
            requirement_text="test requirements",
            design_text="# 设计说明\n\n模块划分",
            diagrams={"class_diagram": "classDiagram\n    class A"},
            test_cases="| TC-N-001 | 测试 |",
            review_report="# 审查报告\n\n通过",
            review_result={"overall_score": 85, "overall_pass": True},
        )

        # 检查所有文件
        expected_files = [
            "requirement_analysis.json",
            "requirement_analysis.md",
            "system_design.md",
            "class_diagram.mmd",
            "test_cases.md",
            "review_report.md",
            "review_result.json",
            "summary_report.md",
        ]
        for f in expected_files:
            assert (tmp_path / f).exists(), f"缺少文件: {f}"

    def test_generate_summary(self, tmp_path):
        mgr = OutputManager(str(tmp_path))
        req = {
            "project_name": "test",
            "actors": [{"name": "A"}],
            "functions": [{"id": "F001"}],
            "entities": [],
            "constraints": [],
            "exceptions": [],
            "non_functional_requirements": [],
            "business_processes": [],
        }
        review = {"overall_score": 90, "overall_pass": True, "checks": []}
        mgr._generate_summary(req, review)

        summary_path = tmp_path / "summary_report.md"
        assert summary_path.exists()
        content = summary_path.read_text(encoding="utf-8")
        assert "90" in content
        assert "是" in content

    def test_save_review_report_with_result(self, tmp_path):
        mgr = OutputManager(str(tmp_path))
        report_md = "# 审查报告\n\n综合得分: 85\n通过: 是"
        result_json = {"overall_score": 85, "overall_pass": True, "checks": []}
        mgr.save_review_report(report_md, result_json)

        report_path = tmp_path / "review_report.md"
        assert report_path.exists()
        assert "85" in report_path.read_text(encoding="utf-8")

        result_path = tmp_path / "review_result.json"
        assert result_path.exists()
        saved = json.loads(result_path.read_text(encoding="utf-8"))
        assert saved["overall_score"] == 85

    def test_save_review_report_without_result(self, tmp_path):
        mgr = OutputManager(str(tmp_path))
        mgr.save_review_report("# 审查报告\n\n无结构化结果")

        assert (tmp_path / "review_report.md").exists()
        assert not (tmp_path / "review_result.json").exists()

    def test_save_review_report_empty_result(self, tmp_path):
        mgr = OutputManager(str(tmp_path))
        mgr.save_review_report("# 报告", {})

        assert (tmp_path / "review_report.md").exists()
        # 空dict是falsy，不写JSON
        assert not (tmp_path / "review_result.json").exists()

    def test_path_traversal_sanitized(self, tmp_path):
        mgr = OutputManager(str(tmp_path))
        # 路径穿越被sanitize后不会逃出output_dir
        mgr._write_file("../etc/passwd", "not malicious")
        # 文件被安全写入到output_dir内
        assert not (tmp_path.parent / "etc" / "passwd").exists()

    def test_sanitize_filename(self, tmp_path):
        from agent.output_manager import _sanitize_filename
        # / 先被替换为 _，然后 .. 被替换为 _
        assert _sanitize_filename("../../etc/passwd") == "____etc_passwd"
        assert _sanitize_filename("normal_file.md") == "normal_file.md"
        assert _sanitize_filename("file with spaces.md") == "file_with_spaces.md"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
