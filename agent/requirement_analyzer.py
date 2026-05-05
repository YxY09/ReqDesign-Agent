"""需求分析智能体：将自然语言需求转为结构化JSON"""

import json
import logging
import re

from agent.llm_client import LLMClient
from agent.prompt_loader import load_prompt

logger = logging.getLogger("reqdesign")


class RequirementAnalyzer:
    """需求分析Agent：抽取角色、功能、实体、约束、异常、非功能需求"""

    def __init__(self, llm_client: LLMClient):
        self.llm = llm_client
        self.prompt_template = load_prompt(
            "requirement_analysis.md",
            "请从以下需求文档中抽取结构化的需求要素，以JSON格式输出：\n\n{requirement_text}",
        )

    def analyze(self, requirement_text: str, max_retries: int = 3) -> dict:
        """分析需求文本，返回结构化JSON，JSON解析失败时自动重试"""
        logger.info("开始需求分析...")
        logger.debug(f"输入文本长度: {len(requirement_text)} 字符")

        # 防止输入文本中包含模板占位符或prompt注入指令
        safe_text = requirement_text.replace("{requirement_text}", "")
        prompt = self.prompt_template.replace("{requirement_text}", safe_text)
        system_msg = "你是一个资深的软件需求分析师，擅长从自然语言需求中提取结构化信息。只输出JSON格式的结果。"

        last_error = None
        for attempt in range(1, max_retries + 1):
            try:
                result = self.llm.generate_json(prompt, system=system_msg)
                result = self._normalize_result(result)
                logger.info(f"需求分析完成，提取到: {len(result.get('actors', []))} 个角色, "
                            f"{len(result.get('functions', []))} 个功能, "
                            f"{len(result.get('entities', []))} 个实体")
                return result
            except json.JSONDecodeError as e:
                last_error = e
                logger.warning(f"第 {attempt} 次JSON解析失败: {e}")
                if attempt < max_retries:
                    logger.info("重试需求分析...")
            except Exception as e:
                logger.error(f"需求分析失败: {e}")
                raise

        logger.error(f"需求分析JSON解析连续 {max_retries} 次失败")
        raise ValueError(f"需求分析结果解析失败: {last_error}")

    @staticmethod
    def _normalize_result(result: dict) -> dict:
        """确保列表字段确实是列表（LLM有时返回字符串而非数组）"""
        list_fields = ["actors", "functions", "entities", "constraints",
                       "exceptions", "non_functional_requirements", "business_processes"]
        for field in list_fields:
            val = result.get(field)
            if val is not None and not isinstance(val, list):
                if isinstance(val, str):
                    result[field] = [] if val.lower() in ("", "none", "null", "无") else [val]
                else:
                    result[field] = [val]
        return result

    def validate_result(self, result: dict) -> list[str]:
        """验证分析结果的完整性，返回缺失字段列表"""
        if not result:
            return ["需求分析结果为空"]

        required_fields = ["actors", "functions", "entities"]
        optional_fields = ["constraints", "exceptions", "non_functional_requirements", "business_processes"]

        warnings = []
        for field in required_fields:
            if field not in result:
                warnings.append(f"缺少必需字段: {field}")
            elif not result[field]:
                warnings.append(f"必需字段为空: {field}")

        for field in optional_fields:
            if field not in result:
                warnings.append(f"缺少可选字段: {field}")

        if warnings:
            logger.warning(f"需求分析结果验证: {warnings}")
        else:
            logger.info("需求分析结果验证通过")

        return warnings
