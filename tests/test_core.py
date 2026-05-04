"""核心模块测试"""

import os
import sys
import pytest
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.config import AgentConfig, LLMConfig
from agent.logger import setup_logger


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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
