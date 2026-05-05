"""Prompt注册与管理模块"""

import hashlib
import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger("reqdesign")


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class PromptEntry:
    """单个Prompt条目"""

    def __init__(self, name: str, path: str, content: str,
                 version: Optional[str] = None):
        self.name = name
        self.path = path
        self.content = content
        self.version = version or hashlib.sha256(
            content.encode()
        ).hexdigest()[:12]

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "path": self.path,
            "version": self.version,
            "content_length": len(self.content),
        }


class PromptRegistry:
    """Prompt模板注册中心"""

    def __init__(self, prompts_dir: Optional[str] = None):
        if prompts_dir is None:
            prompts_dir = os.path.join(PROJECT_ROOT, "prompts")
        self.prompts_dir = Path(prompts_dir)
        self._prompts: dict[str, PromptEntry] = {}
        if self.prompts_dir.exists():
            self._scan()

    def _scan(self):
        """扫描prompts目录，注册所有模板"""
        for f in sorted(self.prompts_dir.glob("*.md")):
            name = f.stem
            try:
                content = f.read_text(encoding="utf-8")
            except Exception as e:
                logger.warning(f"[PromptRegistry] 无法读取 {f}: {e}，跳过")
                continue
            entry = PromptEntry(name=name, path=str(f), content=content)
            self._prompts[name] = entry
            logger.debug(f"[PromptRegistry] 注册: {name} v{entry.version}")
        logger.info(f"[PromptRegistry] 注册 {len(self._prompts)} 个Prompt模板")

    def get(self, name: str) -> Optional[PromptEntry]:
        """按名称获取Prompt"""
        return self._prompts.get(name)

    def get_content(self, name: str) -> str:
        """获取Prompt内容"""
        entry = self.get(name)
        if entry is None:
            raise KeyError(f"Prompt不存在: {name}")
        return entry.content

    def get_version(self, name: str) -> Optional[str]:
        """获取Prompt版本"""
        entry = self.get(name)
        return entry.version if entry else None

    def list_prompts(self) -> list[dict]:
        """列出所有Prompt"""
        return [e.to_dict() for e in self._prompts.values()]

    def has(self, name: str) -> bool:
        """检查Prompt是否存在"""
        return name in self._prompts

    def register(self, name: str, content: str, path: str = ""):
        """手动注册Prompt"""
        entry = PromptEntry(name=name, path=path, content=content)
        self._prompts[name] = entry

    def get_all_versions(self) -> dict[str, str]:
        """获取所有Prompt的版本映射"""
        return {name: entry.version
                for name, entry in self._prompts.items()}
