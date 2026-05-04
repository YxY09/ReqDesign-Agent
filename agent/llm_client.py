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
            base_url = self.config.llm.base_url
            if base_url:
                kwargs["base_url"] = base_url
            elif self.provider == "deepseek":
                kwargs["base_url"] = "https://api.deepseek.com"
            elif self.provider == "qwen":
                kwargs["base_url"] = "https://dashscope.aliyuncs.com/compatible-mode/v1"
            self._client = OpenAI(**kwargs)
        elif self.provider == "anthropic":
            from anthropic import Anthropic
            self._client = Anthropic(api_key=api_key)
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
        # 尝试从响应中提取JSON
        text = raw.strip()
        # 去掉markdown代码块标记
        if text.startswith("```"):
            lines = text.split("\n")
            # 找到第一个和最后一个```之间的内容
            start = 1
            end = len(lines)
            for i in range(len(lines) - 1, 0, -1):
                if lines[i].strip().startswith("```"):
                    end = i
                    break
            text = "\n".join(lines[start:end])

        return json.loads(text)

    def generate_text(self, prompt: str, system: str = "") -> str:
        """发送请求并返回纯文本响应"""
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        return self.chat(messages)
