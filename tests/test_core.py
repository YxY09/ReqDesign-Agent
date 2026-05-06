"""核心模块测试"""

import json
import os
import sys
import pytest


from agent.config import AgentConfig
from agent.logger import setup_logger
from agent.main import parse_args


class TestAgentConfig:
    def test_default_config(self):
        config = AgentConfig()
        assert config.llm.provider == "openai"
        assert config.llm.model == "gpt-4o"
        assert config.llm.temperature == 0.3
        assert config.retry.max_retries == 3

    def test_load_from_yaml(self, tmp_path):
        yaml_content = """llm:
  provider: deepseek
  model: deepseek-chat
  temperature: 0.5
retry:
  max_retries: 5
"""
        config_file = tmp_path / "test_config.yaml"
        config_file.write_text(yaml_content)
        config = AgentConfig.load_from_yaml(str(config_file))
        assert config.llm.provider == "deepseek"
        assert config.llm.model == "deepseek-chat"
        assert config.llm.temperature == 0.5
        assert config.retry.max_retries == 5

    def test_load_missing_file(self):
        with pytest.raises(FileNotFoundError):
            AgentConfig.load_from_yaml("nonexistent.yaml")

    def test_validate_valid(self):
        config = AgentConfig()
        errors = config.validate()
        assert len(errors) == 0

    def test_validate_invalid(self):
        config = AgentConfig()
        config.llm.provider = ""
        config.llm.model = ""
        config.llm.temperature = 3.0
        errors = config.validate()
        assert len(errors) == 3

    def test_validate_unknown_provider(self):
        config = AgentConfig()
        config.llm.provider = "unknown_llm"
        errors = config.validate()
        assert any("provider" in e and "不支持" in e for e in errors)

    def test_validate_invalid_log_level(self):
        config = AgentConfig()
        config.logging.level = "VERBOSE"
        errors = config.validate()
        assert any("level" in e for e in errors)

    def test_validate_negative_max_tokens(self):
        config = AgentConfig()
        config.llm.max_tokens = -1
        errors = config.validate()
        assert any("max_tokens" in e for e in errors)

    def test_validate_zero_max_tokens(self):
        config = AgentConfig()
        config.llm.max_tokens = 0
        errors = config.validate()
        assert any("max_tokens" in e for e in errors)

    def test_validate_string_temperature(self):
        """配置文件中temperature为字符串时不崩溃"""
        config = AgentConfig()
        config.llm.temperature = "hot"
        errors = config.validate()
        assert any("temperature" in e and "类型" in e for e in errors)

    def test_validate_int_log_level(self):
        """配置文件中level为整数时不崩溃"""
        config = AgentConfig()
        config.logging.level = 123
        errors = config.validate()
        assert any("level" in e and "类型" in e for e in errors)

    def test_validate_string_max_retries(self):
        """配置文件中max_retries为字符串时不崩溃"""
        config = AgentConfig()
        config.retry.max_retries = "three"
        errors = config.validate()
        assert any("max_retries" in e and "类型" in e for e in errors)

    def test_validate_string_max_tokens(self):
        """配置文件中max_tokens为字符串时不崩溃"""
        config = AgentConfig()
        config.llm.max_tokens = "abc"
        errors = config.validate()
        assert any("max_tokens" in e and "类型" in e for e in errors)

    def test_load_from_yaml_governance(self, tmp_path):
        yaml_content = """llm:
  provider: deepseek
  model: deepseek-chat
governance:
  enabled: true
  max_repair_rounds: 5
"""
        config_file = tmp_path / "test.yaml"
        config_file.write_text(yaml_content)
        config = AgentConfig.load_from_yaml(str(config_file))
        assert config._raw["governance"]["enabled"] is True
        assert config._raw["governance"]["max_repair_rounds"] == 5

    def test_get_api_key_from_config(self):
        config = AgentConfig()
        config.llm.api_key = "test-key"
        assert config.get_api_key() == "test-key"

    def test_get_api_key_from_env(self, monkeypatch):
        config = AgentConfig()
        config.llm.api_key = ""
        config.llm.provider = "openai"
        monkeypatch.setenv("OPENAI_API_KEY", "env-key")
        assert config.get_api_key() == "env-key"

    def test_get_api_key_missing(self):
        config = AgentConfig()
        config.llm.api_key = ""
        assert config.get_api_key() == ""

    def test_get_base_url_from_config(self):
        config = AgentConfig()
        config.llm.base_url = "https://custom.api.com/v1"
        assert config.get_base_url() == "https://custom.api.com/v1"

    def test_get_base_url_from_env(self, monkeypatch):
        config = AgentConfig()
        config.llm.base_url = ""
        config.llm.provider = "deepseek"
        monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://deepseek.api.com")
        assert config.get_base_url() == "https://deepseek.api.com"

    def test_get_base_url_env_qwen(self, monkeypatch):
        config = AgentConfig()
        config.llm.base_url = ""
        config.llm.provider = "qwen"
        monkeypatch.setenv("QWEN_BASE_URL", "https://qwen.api.com")
        assert config.get_base_url() == "https://qwen.api.com"

    def test_get_base_url_env_anthropic(self, monkeypatch):
        config = AgentConfig()
        config.llm.base_url = ""
        config.llm.provider = "anthropic"
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://anthropic.api.com")
        assert config.get_base_url() == "https://anthropic.api.com"

    def test_get_base_url_missing_env(self, monkeypatch):
        config = AgentConfig()
        config.llm.base_url = ""
        config.llm.provider = "openai"
        monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
        assert config.get_base_url() == ""

    def test_get_base_url_unknown_provider(self, monkeypatch):
        config = AgentConfig()
        config.llm.base_url = ""
        config.llm.provider = "unknown"
        assert config.get_base_url() == ""

    def test_logging_level_normalized_to_uppercase(self):
        """logging.level应在validate()后转为大写"""
        config = AgentConfig()
        config.logging.level = "info"
        errors = config.validate()
        assert errors == []
        assert config.logging.level == "INFO"

    def test_logging_level_invalid(self):
        """无效的logging.level应报错"""
        config = AgentConfig()
        config.logging.level = "INVALID"
        errors = config.validate()
        assert len(errors) > 0


class TestParseArgs:
    def test_default_args(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["main", "--input", "test.md"])
        args = parse_args()
        assert args.task == "design"
        assert args.input == "test.md"
        assert args.output == "outputs/"
        assert args.config == "config.yaml"
        assert args.log_level == "INFO"
        assert args.enable_governance is False
        assert args.mode == "standard"
        assert args.enable_trace is False
        assert args.human_checkpoints == []
        assert args.benchmark is False

    def test_analyze_task(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["main", "--task", "analyze", "-i", "req.md"])
        args = parse_args()
        assert args.task == "analyze"

    def test_governance_mode(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", [
            "main", "-i", "req.md", "--enable-governance",
            "--enable-trace", "--human-checkpoints", "requirement_analysis", "diagram_generation"
        ])
        args = parse_args()
        assert args.enable_governance is True
        assert args.enable_trace is True
        assert args.human_checkpoints == ["requirement_analysis", "diagram_generation"]

    def test_benchmark_flag(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["main", "-i", "cases/", "--benchmark"])
        args = parse_args()
        assert args.benchmark is True

    def test_model_override(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["main", "-i", "test.md", "-m", "gpt-4o-mini", "-p", "openai"])
        args = parse_args()
        assert args.model == "gpt-4o-mini"
        assert args.provider == "openai"

    def test_max_retry(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["main", "-i", "test.md", "--max-retry", "5"])
        args = parse_args()
        assert args.max_retry == 5

    def test_mode_governed(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["main", "-i", "test.md", "--mode", "governed"])
        args = parse_args()
        assert args.mode == "governed"


class TestLogger:
    def test_setup_logger(self, tmp_path):
        logger = setup_logger("test_logger", "DEBUG", str(tmp_path / "logs"))
        assert logger.level == 10  # DEBUG
        assert len(logger.handlers) == 2  # console + file

    def test_logger_writes_to_file(self, tmp_path):
        log_dir = str(tmp_path / "logs")
        logger = setup_logger("test_file", "INFO", log_dir)
        logger.info("test message")
        # 检查日志文件是否创建
        log_files = os.listdir(log_dir)
        assert len(log_files) == 1
        assert log_files[0].startswith("reqdesign_")
        assert log_files[0].endswith(".log")

    def test_logger_no_duplicate_handlers(self, tmp_path):
        log_dir = str(tmp_path / "logs")
        logger1 = setup_logger("test_dup", "INFO", log_dir)
        logger2 = setup_logger("test_dup", "INFO", log_dir)
        assert logger1 is logger2
        assert len(logger1.handlers) == 2


# ========== LLMClient tests ==========

class TestLLMClientInit:
    """测试LLMClient初始化"""

    def test_missing_api_key_raises(self, monkeypatch):
        """未设置API密钥时抛出ValueError"""
        from agent.llm_client import LLMClient
        # 确保环境变量中没有key
        monkeypatch.delenv("TESTPROV_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        config = AgentConfig()
        config.llm.provider = "testprov"
        config.llm.api_key = ""
        with pytest.raises(ValueError, match="未设置API密钥"):
            LLMClient(config)

    def test_unsupported_provider_raises(self):
        """不支持的provider抛出ValueError"""
        from agent.llm_client import LLMClient
        config = AgentConfig()
        config.llm.provider = "unsupported_llm"
        config.llm.api_key = "test-key"
        with pytest.raises(ValueError, match="不支持"):
            LLMClient(config)


class TestLLMClientExtractJson:
    """测试_extract_json_text"""

    def _make_client(self):
        from agent.llm_client import LLMClient
        client = LLMClient.__new__(LLMClient)
        return client

    def test_no_json_found_returns_raw(self):
        """没有JSON对象时返回原文本"""
        client = self._make_client()
        result = client._extract_json_text("no json here")
        assert result == "no json here"

    def test_code_block_extraction(self):
        """从markdown代码块中提取JSON"""
        client = self._make_client()
        raw = '```json\n{"key": "value"}\n```'
        result = client._extract_json_text(raw)
        assert result == '{"key": "value"}'

    def test_json_with_surrounding_text(self):
        """从包含前后文本的响应中提取JSON"""
        client = self._make_client()
        raw = 'Here is the result: {"key": "value"} end'
        result = client._extract_json_text(raw)
        assert result == '{"key": "value"}'


class TestLLMClientParseJsonRobust:
    """测试_parse_json_robust"""

    def _make_client(self):
        from agent.llm_client import LLMClient
        client = LLMClient.__new__(LLMClient)
        return client

    def test_trailing_garbage_after_brace(self):
        """JSON后有垃圾内容时截取到最后一个}"""
        client = self._make_client()
        result = client._parse_json_robust('{"a": 1} garbage text')
        assert result == {"a": 1}

    def test_trailing_comma_in_object(self):
        """尾部逗号被修复"""
        client = self._make_client()
        result = client._parse_json_robust('{"a": 1, "b": 2,}')
        assert result == {"a": 1, "b": 2}

    def test_comment_lines_removed(self):
        """行首注释被移除"""
        client = self._make_client()
        text = '// comment\n{"a": 1}\n// another'
        result = client._parse_json_robust(text)
        assert result == {"a": 1}

    def test_too_large_raises(self):
        """超过1MB的JSON抛出异常"""
        client = self._make_client()
        huge = '{"a": "' + "x" * 2_000_000 + '"}'
        with pytest.raises(json.JSONDecodeError, match="过大"):
            client._parse_json_robust(huge)

    def test_non_dict_raises(self):
        """非dict类型JSON抛出异常"""
        client = self._make_client()
        with pytest.raises(json.JSONDecodeError, match="无法解析"):
            client._parse_json_robust('[1, 2, 3]')


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
