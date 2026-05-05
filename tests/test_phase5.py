"""Phase 5 测试：测试用例生成Agent"""

import pytest


from agent.test_case_generator import TestCaseGenerator


class TestTestCaseGeneratorValidation:
    """测试用例验证逻辑（不需要LLM调用）"""

    def setup_method(self):
        self.gen = TestCaseGenerator.__new__(TestCaseGenerator)

    def test_validate_missing_table(self):
        test_cases = "这是一段普通文本，没有表格。"
        req = {"functions": []}
        warnings = self.gen.validate_test_cases(test_cases, req)
        assert any("表格" in w for w in warnings)

    def test_validate_missing_types(self):
        test_cases = "| 编号 | 类型 |\n|------|------|\n| TC-N-001 | 正常 |"
        req = {"functions": []}
        warnings = self.gen.validate_test_cases(test_cases, req)
        assert any("异常" in w for w in warnings)
        assert any("边界" in w for w in warnings)

    def test_validate_all_types_present(self):
        test_cases = """| 编号 | 类型 |
|------|------|
| TC-N-001 | 正常 |
| TC-N-002 | 正常 |
| TC-N-003 | 正常 |
| TC-E-001 | 异常 |
| TC-E-002 | 异常 |
| TC-B-001 | 边界 |
| TC-B-002 | 边界 |"""
        req = {"functions": []}
        warnings = self.gen.validate_test_cases(test_cases, req)
        type_warnings = [w for w in warnings if "场景" in w]
        assert len(type_warnings) == 0

    def test_validate_function_coverage(self):
        test_cases = "| 编号 | 测试对象 |\n|------|----------|\n| TC-N-001 | 用户登录 |"
        req = {"functions": [{"name": "用户登录"}, {"name": "用户注册"}]}
        warnings = self.gen.validate_test_cases(test_cases, req)
        assert any("用户注册" in w for w in warnings)

    def test_count_test_cases(self):
        test_cases = """
| TC-N-001 | 正常 |
| TC-N-002 | 正常 |
| TC-E-001 | 异常 |
| TC-B-001 | 边界 |
| TC-B-002 | 边界 |
| TC-B-003 | 边界 |
"""
        counts = self.gen.count_test_cases(test_cases)
        assert counts["正常场景"] == 2
        assert counts["异常场景"] == 1
        assert counts["边界场景"] == 3
        assert counts["总计"] == 6

    def test_count_empty(self):
        counts = self.gen.count_test_cases("没有测试用例")
        assert counts["总计"] == 0

    def test_count_excludes_separator_rows(self):
        """表格分隔行不应被计为测试用例"""
        test_cases = """
| 编号 | 测试对象 | 测试步骤 |
|------|----------|----------|
| TC-N-001 | 登录 | 输入用户名密码 |
| TC-N-002 | 注册 | 填写注册信息 |
"""
        counts = self.gen.count_test_cases(test_cases)
        assert counts["总计"] == 2


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
