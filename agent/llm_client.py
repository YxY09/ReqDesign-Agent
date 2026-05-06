"""LLM客户端统一封装模块"""

import json
import logging
import re
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
        self.timeout = config.llm.timeout
        self._client = None
        self._init_client()

    def _init_client(self):
        """根据provider初始化对应客户端"""
        api_key = self.config.get_api_key()
        if not api_key:
            raise ValueError(
                f"未设置API密钥（provider={self.provider}）。"
                f"请在config.yaml中设置 llm.api_key 或设置环境变量 {self.provider.upper()}_API_KEY"
            )

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
        if not messages:
            raise ValueError("messages 不能为空列表")
        for i, msg in enumerate(messages):
            if not isinstance(msg, dict):
                raise ValueError(f"messages[{i}] 必须是dict，实际: {type(msg).__name__}")
            if "role" not in msg or "content" not in msg:
                raise ValueError(f"messages[{i}] 缺少 'role' 或 'content' 字段")

        temp = temperature if temperature is not None else self.temperature
        logger.debug(f"LLM请求: {len(messages)} 条消息, temperature={temp}")

        try:
            if self.provider in ("openai", "deepseek", "qwen"):
                resp = self._client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    temperature=temp,
                    max_tokens=self.max_tokens,
                    timeout=self.timeout,
                )
                if not resp.choices:
                    raise ValueError("LLM返回空响应（可能被内容过滤器拦截）")
                result = resp.choices[0].message.content
            elif self.provider == "anthropic":
                # Anthropic需要将system消息分离（多个system消息合并）
                system_parts = []
                chat_messages = []
                for msg in messages:
                    if msg["role"] == "system":
                        system_parts.append(msg["content"])
                    else:
                        chat_messages.append(msg)
                system_msg = "\n\n".join(system_parts) if system_parts else ""
                if not chat_messages:
                    raise ValueError("Anthropic API需要至少一条非system消息")
                kwargs = {
                    "model": self.model,
                    "messages": chat_messages,
                    "temperature": temp,
                    "max_tokens": self.max_tokens,
                    "timeout": self.timeout,
                }
                if system_msg:
                    kwargs["system"] = system_msg
                resp = self._client.messages.create(**kwargs)
                if not resp.content:
                    raise ValueError("LLM返回空响应（可能被内容过滤器拦截）")
                result = resp.content[0].text
            else:
                raise ValueError(f"不支持的provider: {self.provider}")

            logger.debug(f"LLM响应长度: {len(result)} 字符")
            return result
        except Exception as e:
            logger.error(f"LLM调用失败: {e}", exc_info=True)
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
        code_block = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
        if code_block:
            return code_block.group(1).strip()

        # 尝试找到JSON对象的开始和结束
        start = text.find("{")
        if start >= 0:
            # 跟踪字符串上下文，避免字符串内的}干扰括号匹配
            depth = 0
            in_string = False
            escape_next = False
            for i in range(start, len(text)):
                ch = text[i]
                if ch == "\\" and in_string and not escape_next:
                    escape_next = True
                    continue
                if escape_next:
                    escape_next = False
                    continue
                if ch == '"' and not escape_next:
                    in_string = not in_string
                    continue
                if in_string:
                    continue
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        return text[start:i+1]

            # JSON被截断，尝试补全
            logger.warning("JSON可能被截断，尝试补全")
            return self._try_complete_json(text[start:])

        # 没有找到JSON，返回原文本让解析器报更清晰的错误
        logger.warning(f"LLM响应中未找到JSON对象，响应前200字符: {text[:200]}")
        return text

    def _try_complete_json(self, text: str) -> str:
        """尝试补全被截断的JSON"""
        # 跟踪未闭合的结构
        stack = []
        in_string = False
        escape_next = False

        for i, ch in enumerate(text):
            if ch == "\\" and in_string and not escape_next:
                escape_next = True
                continue
            if escape_next:
                escape_next = False
                continue
            if ch == '"':
                in_string = not in_string
                continue
            if in_string:
                continue
            if ch == "{":
                stack.append("}")
            elif ch == "[":
                stack.append("]")
            elif ch in ("}", "]"):
                if stack and stack[-1] == ch:
                    stack.pop()

        # 如果在字符串中间截断，先关闭字符串
        result = text
        if in_string:
            result += '"'

        # 移除可能的尾部不完整内容（如截断的key或value）
        # 如果最后是引号后面跟着不完整内容，尝试清理
        orig = result
        result = re.sub(r'",\s*"[^"]*$', '",', result)
        result = re.sub(r'":\s*"[^"]*$', '": null', result)
        result = re.sub(r'":\s*$', '": null', result)
        if result != orig:
            logger.warning("JSON截断补全：已将不完整的尾部值替换为null")

        # 添加缺失的闭合括号
        for closer in reversed(stack):
            if closer == "}":
                result += "}"
            elif closer == "]":
                result += "]"

        return result

    def _parse_json_robust(self, text: str) -> dict:
        """健壮的JSON解析，处理常见格式问题"""
        # 大小限制：防止异常大的JSON消耗过多内存
        if len(text) > 1_000_000:  # 1MB
            raise json.JSONDecodeError("JSON文本过大（>1MB）", text, 0)

        # 尝试直接解析
        try:
            result = json.loads(text)
            if not isinstance(result, dict):
                raise json.JSONDecodeError(f"期望dict，得到{type(result).__name__}", text, 0)
            return result
        except json.JSONDecodeError:
            pass

        # 尝试修复常见问题
        fixed = text

        # 移除行首注释（不处理行内的//，避免误伤URL等合法内容）
        fixed = re.sub(r"^\s*//.*$", "", fixed, flags=re.MULTILINE)

        # 移除尾部逗号 (,] 或 ,})
        fixed = re.sub(r",\s*([\]}])", r"\1", fixed)

        # 尝试解析修复后的文本
        try:
            result = json.loads(fixed)
            if isinstance(result, dict):
                return result
        except json.JSONDecodeError:
            pass

        # 最后尝试：截取到最后一个有效的}之前
        last_brace = fixed.rfind("}")
        if last_brace > 0:
            try:
                result = json.loads(fixed[:last_brace+1])
                if isinstance(result, dict):
                    return result
            except json.JSONDecodeError:
                pass

        # 尝试补全截断的JSON
        completed = self._try_complete_json(fixed)
        try:
            result = json.loads(completed)
            if isinstance(result, dict):
                return result
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
