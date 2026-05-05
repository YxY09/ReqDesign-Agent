"""共享的Prompt模板加载工具，带文件级缓存"""

import logging
import os

logger = logging.getLogger("reqdesign")

PROMPT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "prompts")

# 模块级缓存：避免重复读取磁盘
_cache: dict[str, str] = {}


def load_prompt(filename: str, fallback: str = "") -> str:
    """
    加载Prompt模板文件，带缓存。

    Args:
        filename: prompts/ 目录下的文件名（如 "requirement_analysis.md"）
        fallback: 文件不存在时的默认内容

    Returns:
        Prompt模板文本
    """
    if filename in _cache:
        return _cache[filename]

    # 防止路径穿越
    safe_name = os.path.basename(filename)
    path = os.path.join(PROMPT_DIR, safe_name)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        _cache[filename] = content
        return content

    logger.warning(f"Prompt模板不存在: {path}，使用默认模板")
    return fallback


def clear_cache():
    """清空缓存（用于测试）"""
    _cache.clear()
