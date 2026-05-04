"""配置管理模块"""

import os
import logging
import yaml
from dataclasses import dataclass, field

logger = logging.getLogger("reqdesign")


@dataclass
class LLMConfig:
    provider: str = "openai"
    model: str = "gpt-4o"
    api_key: str = ""
    base_url: str = ""
    temperature: float = 0.3
    max_tokens: int = 4096


@dataclass
class RetryConfig:
    max_retries: int = 3


@dataclass
class OutputConfig:
    default_dir: str = "outputs/"


@dataclass
class LoggingConfig:
    level: str = "INFO"
    log_dir: str = "logs/"


@dataclass
class AgentConfig:
    llm: LLMConfig = field(default_factory=LLMConfig)
    retry: RetryConfig = field(default_factory=RetryConfig)
    output: OutputConfig = field(default_factory=OutputConfig)
    logging: LoggingConfig = field(default_factory=LoggingConfig)

    @classmethod
    def load_from_yaml(cls, path: str) -> "AgentConfig":
        """从YAML文件加载配置"""
        if not os.path.exists(path):
            raise FileNotFoundError(f"配置文件不存在: {path}")
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        config = cls()
        if "llm" in data:
            for k, v in data["llm"].items():
                if hasattr(config.llm, k):
                    setattr(config.llm, k, v)
        if "retry" in data:
            for k, v in data["retry"].items():
                if hasattr(config.retry, k):
                    setattr(config.retry, k, v)
        if "output" in data:
            for k, v in data["output"].items():
                if hasattr(config.output, k):
                    setattr(config.output, k, v)
        if "logging" in data:
            for k, v in data["logging"].items():
                if hasattr(config.logging, k):
                    setattr(config.logging, k, v)
        logger.info(f"配置加载完成: provider={config.llm.provider}, model={config.llm.model}")
        return config

    def validate(self) -> list[str]:
        """验证配置，返回错误列表"""
        errors = []
        if not self.llm.provider:
            errors.append("llm.provider 不能为空")
        if not self.llm.model:
            errors.append("llm.model 不能为空")
        if self.llm.temperature < 0 or self.llm.temperature > 2:
            errors.append("llm.temperature 必须在 0-2 之间")
        if self.retry.max_retries < 0:
            errors.append("retry.max_retries 不能为负数")
        return errors

    def get_api_key(self) -> str:
        """获取API密钥，优先使用配置文件，否则从环境变量读取"""
        if self.llm.api_key:
            return self.llm.api_key
        env_map = {
            "openai": "OPENAI_API_KEY",
            "anthropic": "ANTHROPIC_AUTH_TOKEN",
            "deepseek": "DEEPSEEK_API_KEY",
            "qwen": "QWEN_API_KEY",
        }
        env_name = env_map.get(self.llm.provider, "OPENAI_API_KEY")
        return os.environ.get(env_name, "")

    def get_base_url(self) -> str:
        """获取API基础URL，优先使用配置文件，否则从环境变量读取"""
        if self.llm.base_url:
            return self.llm.base_url
        env_map = {
            "openai": "OPENAI_BASE_URL",
            "anthropic": "ANTHROPIC_BASE_URL",
            "deepseek": "DEEPSEEK_BASE_URL",
            "qwen": "QWEN_BASE_URL",
        }
        env_name = env_map.get(self.llm.provider, "")
        return os.environ.get(env_name, "")
