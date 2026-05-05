"""图模型生成智能体：生成Mermaid格式的类图、活动图、状态机图"""

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed

from agent.llm_client import LLMClient
from agent.prompt_loader import load_prompt

logger = logging.getLogger("reqdesign")


class DiagramGenerator:
    """图模型生成Agent：分别生成类图、活动图、状态机图"""

    def __init__(self, llm_client: LLMClient):
        self.llm = llm_client
        self.prompts = self._load_prompts()

    def _load_prompts(self) -> dict:
        """加载所有图生成Prompt模板"""
        templates = {}
        for name in ("class_diagram", "activity_diagram", "state_diagram"):
            fallback = f"请生成Mermaid格式的{name}，基于以下需求：\n\n{{requirement_json}}\n\n{{design_text}}"
            templates[name] = load_prompt(f"{name}.md", fallback)
        return templates

    def _build_prompt(self, template: str, requirement_json: dict, design_text: str) -> str:
        """构建完整Prompt"""
        req_str = json.dumps(requirement_json, ensure_ascii=False, indent=2)
        prompt = template.replace("{requirement_json}", req_str)
        prompt = prompt.replace("{design_text}", design_text)
        return prompt

    @staticmethod
    def _extract_mermaid(raw_response: str, diagram_type: str = "") -> str:
        """从LLM响应中提取Mermaid代码"""
        text = raw_response.strip()
        mermaid_keywords = ("classDiagram", "flowchart", "graph", "stateDiagram-v2", "stateDiagram")

        # 尝试从markdown代码块中提取
        # 只匹配 ```mermaid 或 ``` 后直接换行（不匹配 ```python 等）
        pattern = r"```mermaid\n(.*?)(?:\n```|\Z)"
        matches = re.findall(pattern, text, re.DOTALL)
        if not matches:
            pattern = r"```\n(.*?)(?:\n```|\Z)"
            matches = re.findall(pattern, text, re.DOTALL)
        if matches:
            for block in matches:
                stripped = block.strip()
                if any(stripped.startswith(kw) for kw in mermaid_keywords):
                    return stripped
            return matches[0].strip()

        # 如果没有代码块，检查是否直接是Mermaid代码
        if any(text.startswith(kw) for kw in mermaid_keywords):
            return text

        # 尝试找到Mermaid关键字开头的内容
        for keyword in mermaid_keywords:
            idx = text.find(keyword)
            if idx >= 0:
                return text[idx:].strip()

        logger.warning("无法从响应中提取Mermaid代码，返回原始响应")
        return text

    def generate_class_diagram(self, requirement_json: dict, design_text: str) -> str:
        """生成类图"""
        logger.info("生成类图...")
        prompt = self._build_prompt(self.prompts["class_diagram"], requirement_json, design_text)
        system_msg = "你是一个资深的软件设计师。只输出Mermaid classDiagram代码，不要输出任何解释文字。"
        raw = self.llm.generate_text(prompt, system=system_msg)
        result = self._extract_mermaid(raw, "classDiagram")
        logger.info(f"类图生成完成，长度: {len(result)} 字符")
        return result

    def generate_activity_diagram(self, requirement_json: dict, design_text: str) -> str:
        """生成活动图"""
        logger.info("生成活动图...")
        prompt = self._build_prompt(self.prompts["activity_diagram"], requirement_json, design_text)
        system_msg = "你是一个资深的软件设计师。只输出Mermaid flowchart代码，不要输出任何解释文字。"
        raw = self.llm.generate_text(prompt, system=system_msg)
        result = self._extract_mermaid(raw, "flowchart")
        logger.info(f"活动图生成完成，长度: {len(result)} 字符")
        return result

    def generate_state_diagram(self, requirement_json: dict, design_text: str) -> str:
        """生成状态机图"""
        logger.info("生成状态机图...")
        prompt = self._build_prompt(self.prompts["state_diagram"], requirement_json, design_text)
        system_msg = "你是一个资深的软件设计师。只输出Mermaid stateDiagram-v2代码，不要输出任何解释文字。"
        raw = self.llm.generate_text(prompt, system=system_msg)
        result = self._extract_mermaid(raw, "stateDiagram-v2")
        logger.info(f"状态机图生成完成，长度: {len(result)} 字符")
        return result

    def generate_all(self, requirement_json: dict, design_text: str) -> dict:
        """生成所有图（并行执行）"""
        logger.info("开始生成所有图模型（并行）...")
        generators = {
            "class_diagram": self.generate_class_diagram,
            "activity_diagram": self.generate_activity_diagram,
            "state_diagram": self.generate_state_diagram,
        }
        results = {}
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                executor.submit(fn, requirement_json, design_text): name
                for name, fn in generators.items()
            }
            for future in as_completed(futures):
                name = futures[future]
                try:
                    results[name] = future.result()
                    logger.info(f"  {name} 生成完成")
                except Exception as e:
                    logger.error(f"  {name} 生成失败: {e}", exc_info=True)
                    results[name] = ""
        return results
