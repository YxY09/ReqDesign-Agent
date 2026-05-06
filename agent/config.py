"""配置管理模块"""

import copy
import os
import logging
import yaml
from dataclasses import dataclass, field

logger = logging.getLogger("reqdesign")


@dataclass
class LLMConfig:
    provider: str = "openai"
    model: str = "gpt-4o"
    api_key: str = field(default="", repr=False)  # 不在repr中暴露密钥
    base_url: str = ""
    temperature: float = 0.3
    max_tokens: int = 8192
    timeout: int = 120  # LLM调用超时秒数


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
    _raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def load_from_yaml(cls, path: str) -> "AgentConfig":
        """从YAML文件加载配置"""
        if not os.path.exists(path):
            raise FileNotFoundError(f"配置文件不存在: {path}")
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        if not data:
            logger.warning(f"配置文件为空: {path}，使用默认配置")
            return cls()
        # 存储原始配置，但脱敏API密钥
        safe_raw = copy.deepcopy(data)
        if "llm" in safe_raw and "api_key" in safe_raw["llm"]:
            safe_raw["llm"]["api_key"] = "***"
        config = cls(_raw=safe_raw)
        if "llm" in data and isinstance(data["llm"], dict):
            for k, v in data["llm"].items():
                if hasattr(config.llm, k):
                    # 类型强制转换：YAML可能将0.3解析为float，将120解析为int
                    field_type = type(getattr(config.llm, k))
                    try:
                        if field_type is float and v is not None:
                            v = float(v)
                        elif field_type is int and v is not None:
                            v = int(v)
                    except (TypeError, ValueError):
                        pass  # 保留原值，validate()会报错
                    setattr(config.llm, k, v)
        for section_name in ("retry", "output", "logging"):
            section_data = data.get(section_name)
            if not isinstance(section_data, dict):
                continue
            section_obj = getattr(config, section_name)
            for k, v in section_data.items():
                if hasattr(section_obj, k):
                    field_type = type(getattr(section_obj, k))
                    try:
                        if field_type is float and v is not None:
                            v = float(v)
                        elif field_type is int and v is not None:
                            v = int(v)
                    except (TypeError, ValueError):
                        pass
                    setattr(section_obj, k, v)
        errors = config.validate()
        if errors:
            logger.warning(f"配置验证警告: {errors}")
        logger.info(f"配置加载完成: provider={config.llm.provider}, model={config.llm.model}")
        return config

    VALID_PROVIDERS = ("openai", "anthropic", "deepseek", "qwen")
    VALID_LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")

    def validate(self) -> list[str]:
        """验证配置，返回错误列表"""
        errors = []
        if not self.llm.provider:
            errors.append("llm.provider 不能为空")
        elif self.llm.provider not in self.VALID_PROVIDERS:
            errors.append(f"llm.provider 不支持 '{self.llm.provider}'，可选: {self.VALID_PROVIDERS}")
        if not self.llm.model:
            errors.append("llm.model 不能为空")
        try:
            if not (0 <= self.llm.temperature <= 2):
                errors.append("llm.temperature 必须在 0-2 之间")
        except TypeError:
            errors.append(f"llm.temperature 类型错误，期望数字，得到 {type(self.llm.temperature).__name__}")
        try:
            if self.llm.max_tokens < 1:
                errors.append("llm.max_tokens 必须 >= 1")
        except TypeError:
            errors.append(f"llm.max_tokens 类型错误，期望整数，得到 {type(self.llm.max_tokens).__name__}")
        try:
            if self.retry.max_retries < 0:
                errors.append("retry.max_retries 不能为负数")
        except TypeError:
            errors.append(f"retry.max_retries 类型错误，期望整数，得到 {type(self.retry.max_retries).__name__}")
        try:
            if self.llm.timeout <= 0:
                errors.append("llm.timeout 必须为正数")
        except TypeError:
            errors.append(f"llm.timeout 类型错误，期望数字，得到 {type(self.llm.timeout).__name__}")
        try:
            if self.logging.level.upper() not in self.VALID_LOG_LEVELS:
                errors.append(f"logging.level 不支持 '{self.logging.level}'，可选: {self.VALID_LOG_LEVELS}")
            else:
                self.logging.level = self.logging.level.upper()
        except AttributeError:
            errors.append(f"logging.level 类型错误，期望字符串，得到 {type(self.logging.level).__name__}")
        return errors

    def get_api_key(self) -> str:
        """获取API密钥，优先使用配置文件，否则从环境变量读取"""
        if self.llm.api_key:
            return self.llm.api_key
        env_map = {
            "openai": ("OPENAI_API_KEY",),
            "anthropic": ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"),
            "deepseek": ("DEEPSEEK_API_KEY",),
            "qwen": ("QWEN_API_KEY",),
        }
        env_names = env_map.get(self.llm.provider, ("OPENAI_API_KEY",))
        for name in env_names:
            key = os.environ.get(name, "")
            if key:
                return key
        return ""

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
