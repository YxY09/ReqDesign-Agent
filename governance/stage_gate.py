"""阶段门控模块"""

import logging
import re
from typing import Optional

from governance.models import (
    GateDecision, ValidationResult, GovernanceConfig
)

logger = logging.getLogger("reqdesign")


class StageGate:
    """阶段门控：每阶段执行后决定下一步"""

    def __init__(self, config: Optional[GovernanceConfig] = None):
        self.config = config or GovernanceConfig()
        self.thresholds = self.config.gate_thresholds

    def evaluate(
        self,
        stage_name: str,
        validation: ValidationResult,
        retry_count: int = 0,
        max_retries: int = 2,
        repair_count: int = 0,
    ) -> GateDecision:
        """
        根据校验结果决定下一步

        Returns:
            GateDecision: PROCEED/RETRY/REPAIR/HALT
        """
        # 校验通过，直接进入下一阶段
        if validation.is_valid:
            logger.info(f"[Gate:{stage_name}] PROCEED — 校验通过")
            return GateDecision.PROCEED

        # 检查是否需要HALT（分数过低且已重试/修复过）
        halt_threshold = self.thresholds.get("min_completeness", 0.8) * 0.4
        score = validation.score if validation.score is not None else 0.0
        if score < halt_threshold and (retry_count > 0 or repair_count > 0):
            logger.warning(
                f"[Gate:{stage_name}] HALT — 分数过低({validation.score})且已重试"
            )
            return GateDecision.HALT

        # 尝试重试
        if retry_count < max_retries and self._is_retryable(validation):
            logger.info(
                f"[Gate:{stage_name}] RETRY — 可恢复错误，"
                f"已重试{retry_count}/{max_retries}"
            )
            return GateDecision.RETRY

        # 尝试修复
        max_repairs = self.config.max_repair_rounds
        if repair_count < max_repairs:
            logger.info(
                f"[Gate:{stage_name}] REPAIR — 触发修复，"
                f"已修复{repair_count}/{max_repairs}"
            )
            return GateDecision.REPAIR

        # 修复也失败，HALT
        logger.warning(
            f"[Gate:{stage_name}] HALT — 达到最大修复轮次({max_repairs})"
        )
        return GateDecision.HALT

    def _is_retryable(self, validation: ValidationResult) -> bool:
        """判断错误是否可通过重试恢复（仅检查错误模式，不看分数）"""
        # 中文模式用子串匹配，英文/数字模式用词边界匹配避免误匹配
        substring_patterns = ["空响应", "超时", "截断", "网络", "为空", "为none", "解析失败"]
        word_patterns = re.compile(
            r'\b(?:timeout|empty|network|rate\s*limit|429|503)\b', re.IGNORECASE
        )
        for err in validation.errors:
            err_lower = err.lower()
            if any(p in err_lower for p in substring_patterns):
                return True
            if word_patterns.search(err):
                return True
        return False

