"""设计规划智能体：基于需求JSON生成系统设计说明"""

import logging
import os

from agent.llm_client import LLMClient

logger = logging.getLogger("reqdesign")

PROMPT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "prompts")


class DesignPlanner:
    """设计规划Agent：生成模块划分、核心类、接口与数据流"""

    def __init__(self, llm_client: LLMClient):
        self.llm = llm_client
        self.prompt_template = self._load_prompt()

    def _load_prompt(self) -> str:
        """加载Prompt模板"""
        prompt_path = os.path.join(PROMPT_DIR, "design_planner.md")
        if not os.path.exists(prompt_path):
            logger.warning(f"Prompt模板不存在: {prompt_path}，使用默认模板")
            return "请根据以下需求分析结果生成系统设计方案：\n\n{requirement_json}"
        with open(prompt_path, "r", encoding="utf-8") as f:
            return f.read()

    def generate_design(self, requirement_json: dict) -> str:
        """根据需求JSON生成系统设计说明（Markdown格式）"""
        logger.info("开始生成系统设计...")

        import json
        req_str = json.dumps(requirement_json, ensure_ascii=False, indent=2)
        prompt = self.prompt_template.replace("{requirement_json}", req_str)

        system_msg = "你是一个资深的系统架构师，擅长根据需求分析结果设计软件系统架构。输出格式为Markdown。"

        try:
            result = self.llm.generate_text(prompt, system=system_msg)
            logger.info(f"系统设计生成完成，长度: {len(result)} 字符")
            return result
        except Exception as e:
            logger.error(f"系统设计生成失败: {e}")
            raise

    def validate_design(self, design_text: str, requirement_json: dict) -> list[str]:
        """验证设计是否覆盖了所有需求"""
        warnings = []

        # 检查核心章节是否存在
        required_sections = ["模块划分", "核心类", "数据流"]
        for section in required_sections:
            if section not in design_text:
                warnings.append(f"设计文档缺少章节: {section}")

        # 检查功能覆盖
        functions = requirement_json.get("functions", [])
        for func in functions:
            func_id = func.get("id", "")
            func_name = func.get("name", "")
            if func_id and func_id not in design_text and func_name not in design_text:
                warnings.append(f"功能 {func_id}({func_name}) 未在设计中体现")

        # 检查实体覆盖
        entities = requirement_json.get("entities", [])
        for entity in entities:
            entity_name = entity.get("name", "")
            if entity_name and entity_name not in design_text:
                warnings.append(f"实体 '{entity_name}' 未在设计中体现")

        if warnings:
            logger.warning(f"设计验证发现 {len(warnings)} 个问题")
        else:
            logger.info("设计验证通过")

        return warnings
