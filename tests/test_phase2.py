"""Phase 2 测试：输入处理与需求分析"""

import json
import pytest

from agent.input_loader import InputLoader


class TestInputLoader:
    def setup_method(self):
        self.loader = InputLoader()

    def test_load_markdown(self, tmp_path):
        content = "# 图书管理系统\n\n学生可以借阅图书。"
        f = tmp_path / "test.md"
        f.write_text(content, encoding="utf-8")
        result = self.loader.load(str(f))
        assert "图书管理系统" in result
        assert "借阅图书" in result

    def test_load_txt(self, tmp_path):
        content = "用户可以注册登录系统。"
        f = tmp_path / "test.txt"
        f.write_text(content, encoding="utf-8")
        result = self.loader.load(str(f))
        assert "注册登录" in result

    def test_load_json(self, tmp_path):
        data = {"requirements": "系统需要支持用户管理功能"}
        f = tmp_path / "test.json"
        f.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        result = self.loader.load(str(f))
        assert "用户管理" in result

    def test_load_json_string(self, tmp_path):
        f = tmp_path / "test.json"
        f.write_text(json.dumps("直接的需求文本"), encoding="utf-8")
        result = self.loader.load(str(f))
        assert "需求文本" in result

    def test_load_missing_file(self):
        with pytest.raises(FileNotFoundError):
            self.loader.load("nonexistent.md")

    def test_load_empty_file(self, tmp_path):
        f = tmp_path / "empty.md"
        f.write_text("", encoding="utf-8")
        with pytest.raises(ValueError, match="为空"):
            self.loader.load(str(f))

    def test_load_unsupported_format(self, tmp_path):
        f = tmp_path / "test.pdf"
        f.write_text("content", encoding="utf-8")
        with pytest.raises(ValueError, match="不支持"):
            self.loader.load(str(f))

    def test_clean_removes_extra_blank_lines(self):
        text = "line1\n\n\n\nline2"
        result = self.loader.clean(text)
        assert "\n\n\n" not in result
        assert "line1" in result
        assert "line2" in result

    def test_clean_strips_whitespace(self):
        text = "  hello world  \n  "
        result = self.loader.clean(text)
        assert result == "hello world"

    def test_split_sections(self):
        text = "# 需求概述\n\n这是一个系统。\n\n# 功能需求\n\n用户可以登录。"
        sections = self.loader.split_sections(text)
        assert len(sections) == 2
        assert sections[0]["title"] == "需求概述"
        assert sections[1]["title"] == "功能需求"
        assert "系统" in sections[0]["content"]
        assert "登录" in sections[1]["content"]

    def test_split_sections_no_title(self):
        text = "没有标题的纯文本内容。"
        sections = self.loader.split_sections(text)
        assert len(sections) == 1
        assert sections[0]["title"] == ""
        assert "纯文本" in sections[0]["content"]

    def test_load_raises_on_directory(self, tmp_path):
        """传入目录路径时抛出ValueError"""
        with pytest.raises(ValueError, match="目录"):
            self.loader.load(str(tmp_path))

    def test_load_content_exceeds_max_chars(self, tmp_path):
        """内容超过MAX_CHARS限制时抛出ValueError"""
        # 写入一个超过100K字符的文件（但小于512KB文件大小限制）
        content = "a" * 100_001
        f = tmp_path / "long.txt"
        f.write_text(content, encoding="utf-8")
        with pytest.raises(ValueError, match="过长"):
            self.loader.load(str(f))


class TestRequirementAnalyzerValidation:
    """测试RequirementAnalyzer.validate_result"""

    def _make_analyzer(self):
        from agent.requirement_analyzer import RequirementAnalyzer
        analyzer = RequirementAnalyzer.__new__(RequirementAnalyzer)
        return analyzer

    def test_validate_empty_dict(self):
        """空dict返回"结果为空"警告"""
        analyzer = self._make_analyzer()
        warnings = analyzer.validate_result({})
        assert any("为空" in w for w in warnings)

    def test_validate_none_returns_empty_warning(self):
        """None返回"结果为空"警告"""
        analyzer = self._make_analyzer()
        warnings = analyzer.validate_result(None)
        assert any("为空" in w for w in warnings)

    def test_validate_required_field_empty_list(self):
        """必需字段存在但为空列表时警告"""
        analyzer = self._make_analyzer()
        result = {
            "actors": [],
            "functions": [],
            "entities": [],
        }
        warnings = analyzer.validate_result(result)
        assert any("actors" in w and "为空" in w for w in warnings)
        assert any("functions" in w and "为空" in w for w in warnings)
        assert any("entities" in w and "为空" in w for w in warnings)

    def test_validate_required_field_missing(self):
        """必需字段缺失时警告"""
        analyzer = self._make_analyzer()
        result = {"actors": ["user"]}  # 缺少functions和entities
        warnings = analyzer.validate_result(result)
        assert any("functions" in w and "缺少" in w for w in warnings)
        assert any("entities" in w and "缺少" in w for w in warnings)

    def test_validate_optional_fields_missing(self):
        """可选字段缺失时警告"""
        analyzer = self._make_analyzer()
        result = {
            "actors": ["user"],
            "functions": [{"name": "login"}],
            "entities": [{"name": "User"}],
        }
        warnings = analyzer.validate_result(result)
        assert any("constraints" in w for w in warnings)
        assert any("exceptions" in w for w in warnings)

    def test_validate_complete_result_no_warnings(self):
        """完整结果无警告"""
        analyzer = self._make_analyzer()
        result = {
            "actors": ["user"],
            "functions": [{"name": "login"}],
            "entities": [{"name": "User"}],
            "constraints": ["密码不能为空"],
            "exceptions": ["登录失败"],
            "non_functional_requirements": ["响应时间<3s"],
            "business_processes": ["登录流程"],
        }
        warnings = analyzer.validate_result(result)
        assert len(warnings) == 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
