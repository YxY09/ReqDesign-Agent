"""测试用例生成智能体：根据需求和设计生成测试用例草案"""

import logging
import os

from agent.llm_client import LLMClient

logger = logging.getLogger("reqdesign")

PROMPT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "prompts")


class TestCaseGenerator:
    """测试用例生成Agent：按正常/异常/边界生成测试用例"""

    def __init__(self, llm_client: LLMClient):
        self.llm = llm_client
        self.prompt_template = self._load_prompt()

    def _load_prompt(self) -> str:
        """加载Prompt模板"""
        prompt_path = os.path.join(PROMPT_DIR, "test_case.md")
        if not os.path.exists(prompt_path):
            logger.warning(f"Prompt模板不存在: {prompt_path}，使用默认模板")
            return "请根据以下需求和设计生成测试用例：\n\n{requirement_json}\n\n{design_text}"
        with open(prompt_path, "r", encoding="utf-8") as f:
            return f.read()

    def generate(self, requirement_json: dict, design_text: str) -> str:
        """生成测试用例（Markdown格式）"""
        logger.info("开始生成测试用例...")

        import json
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

        # 检查测试用例类型覆盖
        has_normal = "TC-N-" in test_cases_md or "正常" in test_cases_md
        has_exception = "TC-E-" in test_cases_md or "异常" in test_cases_md
        has_boundary = "TC-B-" in test_cases_md or "边界" in test_cases_md

        if not has_normal:
            warnings.append("缺少正常场景测试用例")
        if not has_exception:
            warnings.append("缺少异常场景测试用例")
        if not has_boundary:
            warnings.append("缺少边界场景测试用例")

        # 检查功能覆盖
        functions = requirement_json.get("functions", [])
        for func in functions:
            func_name = func.get("name", "")
            if func_name and func_name not in test_cases_md:
                warnings.append(f"功能 '{func_name}' 未被测试用例覆盖")

        if warnings:
            logger.warning(f"测试用例验证发现 {len(warnings)} 个问题")
        else:
            logger.info("测试用例验证通过")

        return warnings

    def count_test_cases(self, test_cases_md: str) -> dict:
        """统计测试用例数量"""
        import re
        # 匹配表格行中的编号
        normal = len(re.findall(r"TC-N-\d+", test_cases_md))
        exception = len(re.findall(r"TC-E-\d+", test_cases_md))
        boundary = len(re.findall(r"TC-B-\d+", test_cases_md))

        counts = {
            "正常场景": normal,
            "异常场景": exception,
            "边界场景": boundary,
            "总计": normal + exception + boundary,
        }
        logger.info(f"测试用例统计: {counts}")
        return counts
