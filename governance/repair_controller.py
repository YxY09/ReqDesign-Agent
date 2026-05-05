"""修复控制模块"""

import logging
from typing import Callable, Any

from governance.models import RepairRecord, ValidationResult

logger = logging.getLogger("reqdesign")


class RepairController:
    """多轮修复控制器"""

    def __init__(self, max_rounds: int = 3):
        self.max_rounds = max_rounds

    def attempt_repair(
        self,
        stage_name: str,
        output: Any,
        validate_fn: Callable[[Any], ValidationResult],
        repair_fn: Callable[[Any, list[str]], Any],
    ) -> tuple[Any, list[RepairRecord]]:
        """
        尝试修复输出直到校验通过或达到最大轮次

        Args:
            stage_name: 阶段名
            output: 待校验的输出
            validate_fn: 校验函数，接收output返回ValidationResult
            repair_fn: 修复函数，接收(output, errors)返回修复后的output

        Returns:
            (修复后的output, 修复记录列表)
        """
        records = []
        current = output

        if self.max_rounds <= 0:
            logger.warning(f"[{stage_name}] max_rounds={self.max_rounds}，跳过修复")
            return current, records

        for attempt in range(1, self.max_rounds + 1):
            try:
                vr = validate_fn(current)
            except Exception as e:
                logger.warning(f"[{stage_name}] 校验函数异常: {e}", exc_info=True)
                vr = ValidationResult(is_valid=False, errors=[f"校验异常: {e}"], score=0.0)
            if vr is None:
                vr = ValidationResult(is_valid=False, errors=["校验函数返回None"], score=0.0)

            if vr.is_valid:
                logger.info(f"[{stage_name}] 校验通过，无需修复")
                return current, records

            logger.info(
                f"[{stage_name}] 修复尝试 {attempt}/{self.max_rounds}, "
                f"errors={vr.errors}"
            )

            try:
                repaired = repair_fn(current, vr.errors)
                if repaired is None:
                    logger.warning(f"[{stage_name}] 修复函数返回None，停止修复")
                    records.append(RepairRecord(
                        attempt=attempt, error=str(vr.errors),
                        action="llm_repair", result="returned_none", success=False,
                    ))
                    break
                try:
                    new_vr = validate_fn(repaired)
                except Exception as e:
                    logger.warning(f"[{stage_name}] 修复后校验异常: {e}", exc_info=True)
                    new_vr = ValidationResult(is_valid=False, errors=[f"校验异常: {e}"], score=0.0)
                if new_vr is None:
                    new_vr = ValidationResult(is_valid=False, errors=["校验函数返回None"], score=0.0)
                record = RepairRecord(
                    attempt=attempt,
                    error=str(vr.errors),
                    action="llm_repair",
                    result="success" if new_vr.is_valid else "still_invalid",
                    success=new_vr.is_valid,
                )
                records.append(record)

                # 只接受不比原来更差的修复结果
                if new_vr.is_valid or (new_vr.score is not None and vr.score is not None and new_vr.score >= vr.score):
                    current = repaired
                else:
                    logger.warning(f"[{stage_name}] 修复后质量下降({vr.score}->{new_vr.score})，保留原输出")

                if new_vr.is_valid:
                    logger.info(f"[{stage_name}] 修复成功（第{attempt}轮）")
                    return current, records

            except Exception as e:
                record = RepairRecord(
                    attempt=attempt,
                    error=str(vr.errors),
                    action="llm_repair",
                    result=f"exception: {e}",
                    success=False,
                )
                records.append(record)
                logger.warning(f"[{stage_name}] 修复异常: {e}", exc_info=True)

        logger.warning(
            f"[{stage_name}] 达到最大修复轮次({self.max_rounds})，保留当前输出"
        )
        return current, records

