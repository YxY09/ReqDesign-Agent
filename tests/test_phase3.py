"""Phase 3 测试：设计规划Agent"""

import os
import sys
import pytest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.design_planner import DesignPlanner


class TestDesignPlannerValidation:
    """测试设计验证逻辑（不需要LLM调用）"""

    def setup_method(self):
        # 不初始化LLM，只测试验证逻辑
        self.planner = DesignPlanner.__new__(DesignPlanner)
        self.planner.llm = None

    def test_validate_missing_sections(self):
        design = "这是一个设计方案，但缺少关键章节。"
        req = {"functions": [], "entities": []}
        warnings = self.planner.validate_design(design, req)
        assert any("模块划分" in w for w in warnings)
        assert any("核心类" in w for w in warnings)
        assert any("数据流" in w for w in warnings)

    def test_validate_has_sections(self):
        design = "## 模块划分\n\n| 模块名称 | 职责 |\n|----------|------|\n| 用户管理 | 管理用户 |\n\n## 核心类/接口设计\n\n| 类名 | 职责 |\n|------|------|\n| User | 用户 |\n\n## 数据流说明\n\n用户请求 -> 业务层 -> 数据层"
        req = {"functions": [], "entities": []}
        warnings = self.planner.validate_design(design, req)
        section_warnings = [w for w in warnings if "章节" in w]
        assert len(section_warnings) == 0

    def test_validate_function_coverage(self):
        design = "## 模块划分\n\n## 核心类\n\n## 数据流\n\n包含F001功能。"
        req = {
            "functions": [
                {"id": "F001", "name": "用户登录"},
                {"id": "F002", "name": "用户注册"},
            ],
            "entities": [],
        }
        warnings = self.planner.validate_design(design, req)
        assert any("F002" in w for w in warnings)

    def test_validate_entity_coverage(self):
        design = "## 模块划分\n\n## 核心类\n\n## 数据流\n\nUser类。"
        req = {
            "functions": [],
            "entities": [
                {"name": "User", "description": "用户"},
                {"name": "Order", "description": "订单"},
            ],
        }
        warnings = self.planner.validate_design(design, req)
        assert any("Order" in w for w in warnings)

    def test_validate_all_covered(self):
        design = "## 模块划分\n\n包含F001用户登录功能。\n\n## 核心类\n\nUser类。\n\n## 数据流\n\n请求处理流程。"
        req = {
            "functions": [{"id": "F001", "name": "用户登录"}],
            "entities": [{"name": "User", "description": "用户"}],
        }
        warnings = self.planner.validate_design(design, req)
        # 没有遗漏
        coverage_warnings = [w for w in warnings if "未在设计中体现" in w]
        assert len(coverage_warnings) == 0


class TestDesignPlannerGenerate:
    """测试DesignPlanner.generate_design（mock LLM）"""

    def setup_method(self):
        mock_llm = MagicMock()
        self.planner = DesignPlanner.__new__(DesignPlanner)
        self.planner.llm = mock_llm
        self.planner.prompt_template = "请设计系统：\n{requirement_json}"
        self.mock_llm = mock_llm

    def test_generate_design_success(self):
        self.mock_llm.generate_text.return_value = "## 模块划分\n\n用户管理模块\n\n## 核心类\n\nUser类\n\n## 数据流\n\n请求处理"
        req = {"functions": [{"id": "F001", "name": "用户登录"}], "entities": []}
        result = self.planner.generate_design(req)
        assert "模块划分" in result
        assert "核心类" in result
        self.mock_llm.generate_text.assert_called_once()

    def test_generate_design_llm_error(self):
        self.mock_llm.generate_text.side_effect = Exception("API timeout")
        req = {"functions": [], "entities": []}
        with pytest.raises(Exception, match="API timeout"):
            self.planner.generate_design(req)

    def test_generate_design_passes_json_to_prompt(self):
        self.mock_llm.generate_text.return_value = "设计结果"
        req = {"functions": [{"id": "F001", "name": "登录"}], "entities": [{"name": "User"}]}
        self.planner.generate_design(req)
        call_args = self.mock_llm.generate_text.call_args
        prompt = call_args[0][0]
        assert "F001" in prompt
        assert "User" in prompt


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
