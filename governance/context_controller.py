"""上下文控制模块"""

import copy
import logging
from typing import Any

logger = logging.getLogger("reqdesign")


class ContextController:
    """管理阶段间传递的上下文"""

    # 每个阶段需要的上下文字段
    STAGE_CONTEXT_SPEC = {
        "requirement_analysis": {"full_text"},
        "design_planner": {"requirement_json"},
        "diagram_generator": {"requirement_json", "design_text"},
        "test_case_generator": {"requirement_json", "design_text"},
        "review_agent": {"requirement_json", "design_text", "diagrams"},
        "output_manager": {"all_outputs"},
    }

    def __init__(self):
        self._context: dict[str, Any] = {}
        self._history: list[dict] = []

    def set(self, key: str, value: Any):
        """设置上下文"""
        self._context[key] = value
        logger.debug(f"[Context] set {key} ({_type_name(value)})")

    def get(self, key: str, default: Any = None) -> Any:
        """获取上下文"""
        return self._context.get(key, default)

    def get_for_stage(self, stage_name: str) -> dict:
        """获取指定阶段需要的上下文子集"""
        spec = self.STAGE_CONTEXT_SPEC.get(stage_name)
        if spec is None:
            logger.debug(f"[Context] 未知阶段 {stage_name}，返回空上下文")
            return {}

        result = {}
        for key in spec:
            if key in self._context:
                result[key] = self._context[key]
        return result

    def update(self, data: dict):
        """批量更新上下文"""
        self._context.update(data)

    def snapshot(self) -> dict:
        """保存当前上下文快照"""
        snap = copy.deepcopy(self._context)
        self._history.append(snap)
        return snap

    def get_full_context(self) -> dict:
        """获取完整上下文"""
        return dict(self._context)

    def get_history(self) -> list[dict]:
        """获取上下文变更历史"""
        return list(self._history)

    def clear(self):
        """清空上下文"""
        self._context.clear()
        self._history.clear()


def _type_name(val: Any) -> str:
    """获取值的类型名（截断）"""
    name = type(val).__name__
    if isinstance(val, str):
        return f"str({len(val)}chars)"
    if isinstance(val, (list, dict)):
        return f"{name}({len(val)})"
    return name
