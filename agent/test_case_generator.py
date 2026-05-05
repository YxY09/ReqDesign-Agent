"""测试用例生成智能体：根据需求和设计生成测试用例草案"""

import json
import logging
import re

from agent.llm_client import LLMClient
from agent.prompt_loader import load_prompt

logger = logging.getLogger("reqdesign")


class TestCaseGenerator:
    """测试用例生成Agent：按正常/异常/边界生成测试用例"""

    def __init__(self, llm_client: LLMClient):
        self.llm = llm_client
        self.prompt_template = load_prompt(
            "test_case.md",
            "请根据以下需求和设计生成测试用例：\n\n{requirement_json}\n\n{design_text}",
        )

    def generate(self, requirement_json: dict, design_text: str) -> str:
        """生成测试用例（Markdown格式）"""
        logger.info("开始生成测试用例...")

        req_str = json.dumps(requirement_json, ensure_ascii=False, indent=2)
        prompt = self.prompt_template.replace("{requirement_json}", req_str)
        prompt = prompt.replace("{design_text}", design_text)

        system_msg = "你是一个资深的测试工程师，擅长根据需求设计全面的测试用例。输出Markdown格式的测试用例表格。"

        try:
            result = self.llm.generate_text(prompt, system=system_msg)
            logger.info(f"测试用例生成完成，长度: {len(result)} 字符")
            return result
        except Exception as e:
            logger.error(f"测试用例生成失败: {e}")
            raise

    def validate_test_cases(self, test_cases_md: str, requirement_json: dict) -> list[str]:
        """验证测试用例的完整性"""
        warnings = []

        # 检查是否包含表格格式
        if "|" not in test_cases_md:
            warnings.append("测试用例缺少Markdown表格格式")

        # 检查测试用例类型覆盖（多种命名模式）
        tc_lower = test_cases_md.lower()
        has_normal = any(kw in tc_lower for kw in ["tc-n-", "正常", "normal", "happy path"])
        has_exception = any(kw in tc_lower for kw in ["tc-e-", "异常", "exception", "error", "失败"])
        has_boundary = any(kw in tc_lower for kw in ["tc-b-", "边界", "boundary", "极限", "临界"])

        if not has_normal:
            warnings.append("缺少正常场景测试用例")
        if not has_exception:
            warnings.append("缺少异常场景测试用例")
        if not has_boundary:
            warnings.append("缺少边界场景测试用例")

        # 检查测试用例数量
        counts = self.count_test_cases(test_cases_md)
        if counts["正常场景"] < 3:
            warnings.append(f"正常场景测试用例不足（{counts['正常场景']}/3）")
        if counts["异常场景"] < 2:
            warnings.append(f"异常场景测试用例不足（{counts['异常场景']}/2）")
        if counts["边界场景"] < 2:
            warnings.append(f"边界场景测试用例不足（{counts['边界场景']}/2）")

        # 检查功能覆盖（大小写不敏感）
        functions = requirement_json.get("functions", [])
        for func in functions:
            func_name = func.get("name", "")
            if func_name and func_name.lower() not in tc_lower:
                warnings.append(f"功能 '{func_name}' 未被测试用例覆盖")

        if warnings:
            logger.warning(f"测试用例验证发现 {len(warnings)} 个问题")
        else:
            logger.info("测试用例验证通过")

        return warnings

    def count_test_cases(self, test_cases_md: str) -> dict:
        """统计测试用例数量"""
        normal = len(re.findall(r"TC-N-\d+", test_cases_md, re.IGNORECASE))
        exception = len(re.findall(r"TC-E-\d+", test_cases_md, re.IGNORECASE))
        boundary = len(re.findall(r"TC-B-\d+", test_cases_md, re.IGNORECASE))

        # 如果标准格式未匹配，尝试统计表格行数
        total_rows = len(re.findall(r"\|.*\|", test_cases_md)) - 1  # 减去表头
        total = max(normal + exception + boundary, total_rows)

        counts = {
            "正常场景": normal,
            "异常场景": exception,
            "边界场景": boundary,
            "总计": total,
        }
        logger.info(f"测试用例统计: {counts}")
        return counts
