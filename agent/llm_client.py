"""LLM客户端统一封装模块"""

import json
import logging
from typing import Optional

from agent.config import AgentConfig

logger = logging.getLogger("reqdesign")


class LLMClient:
    """统一封装不同大模型API调用"""

    def __init__(self, config: AgentConfig):
        self.config = config
        self.provider = config.llm.provider
        self.model = config.llm.model
        self.temperature = config.llm.temperature
        self.max_tokens = config.llm.max_tokens
        self._client = None
        self._init_client()

    def _init_client(self):
        """根据provider初始化对应客户端"""
        api_key = self.config.get_api_key()
        if not api_key:
            logger.warning("未设置API密钥，LLM调用将失败")

        if self.provider in ("openai", "deepseek", "qwen"):
            from openai import OpenAI
            kwargs = {"api_key": api_key}
            base_url = self.config.get_base_url()
            if base_url:
                kwargs["base_url"] = base_url
            elif self.provider == "deepseek":
                kwargs["base_url"] = "https://api.deepseek.com"
            elif self.provider == "qwen":
                kwargs["base_url"] = "https://dashscope.aliyuncs.com/compatible-mode/v1"
            self._client = OpenAI(**kwargs)
        elif self.provider == "anthropic":
            from anthropic import Anthropic
            kwargs = {"api_key": api_key}
            base_url = self.config.get_base_url()
            if base_url:
                kwargs["base_url"] = base_url
            self._client = Anthropic(**kwargs)
        else:
            raise ValueError(f"不支持的LLM provider: {self.provider}")

        logger.info(f"LLM客户端初始化完成: {self.provider}/{self.model}")

    def chat(self, messages: list[dict], temperature: Optional[float] = None) -> str:
        """发送对话请求，返回文本响应"""
        temp = temperature if temperature is not None else self.temperature
        logger.debug(f"LLM请求: {len(messages)} 条消息, temperature={temp}")

        try:
            if self.provider in ("openai", "deepseek", "qwen"):
                resp = self._client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    temperature=temp,
                    max_tokens=self.max_tokens,
                )
                result = resp.choices[0].message.content
            elif self.provider == "anthropic":
                # Anthropic需要将system消息分离
                system_msg = ""
                chat_messages = []
                for msg in messages:
                    if msg["role"] == "system":
                        system_msg = msg["content"]
                    else:
                        chat_messages.append(msg)
                kwargs = {
                    "model": self.model,
                    "messages": chat_messages,
                    "temperature": temp,
                    "max_tokens": self.max_tokens,
                }
                if system_msg:
                    kwargs["system"] = system_msg
                resp = self._client.messages.create(**kwargs)
                result = resp.content[0].text
            else:
                raise ValueError(f"不支持的provider: {self.provider}")

            logger.debug(f"LLM响应长度: {len(result)} 字符")
            return result
        except Exception as e:
            logger.error(f"LLM调用失败: {e}")
            raise

    def generate_json(self, prompt: str, system: str = "") -> dict:
        """发送请求并解析JSON响应"""
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        raw = self.chat(messages)
        text = self._extract_json_text(raw)
        return self._parse_json_robust(text)

    def _extract_json_text(self, raw: str) -> str:
        """从LLM响应中提取JSON文本"""
        text = raw.strip()

        # 尝试从markdown代码块中提取
        import re
        code_block = re.search(r"```(?:json)?\s*\n(.*?)```", text, re.DOTALL)
        if code_block:
            return code_block.group(1).strip()

        # 尝试找到JSON对象的开始和结束
        start = text.find("{")
        if start >= 0:
            # 从后往前找匹配的}
            depth = 0
            for i in range(start, len(text)):
                if text[i] == "{":
                    depth += 1
                elif text[i] == "}":
                    depth -= 1
                    if depth == 0:
                        return text[start:i+1]

        return text

    def _parse_json_robust(self, text: str) -> dict:
        """健壮的JSON解析，处理常见格式问题"""
        # 尝试直接解析
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        # 尝试修复常见问题
        import re
        fixed = text

        # 移除行尾注释
        fixed = re.sub(r"//.*$", "", fixed, flags=re.MULTILINE)

        # 移除尾部逗号 (,] 或 ,})
        fixed = re.sub(r",\s*([\]}])", r"\1", fixed)

        # 尝试解析修复后的文本
        try:
            return json.loads(fixed)
        except json.JSONDecodeError:
            pass

        # 最后尝试：截取到最后一个有效的}之前
        last_brace = fixed.rfind("}")
        if last_brace > 0:
            try:
                return json.loads(fixed[:last_brace+1])
            except json.JSONDecodeError:
                pass

        raise json.JSONDecodeError(f"无法解析JSON，文本前200字符: {text[:200]}", text, 0)

    def generate_text(self, prompt: str, system: str = "") -> str:
        """发送请求并返回纯文本响应"""
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        return self.chat(messages)
