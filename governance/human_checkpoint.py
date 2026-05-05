"""人工检查点模块"""

import logging

from governance.models import HumanAction, HumanDecision

logger = logging.getLogger("reqdesign")

# Avoid circular import: TraceLogger is imported lazily via TYPE_CHECKING
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from governance.trace_logger import TraceLogger


class HumanCheckpoint:
    """人工检查点：在关键阶段暂停等待人工确认"""

    def __init__(self, checkpoint_stages: list[str] = None,
                 trace_logger: "TraceLogger | None" = None,
                 interactive: bool = True):
        """
        Args:
            checkpoint_stages: 需要人工检查的阶段列表
            trace_logger: 追踪记录器
            interactive: 是否交互式（CLI模式等待输入）
        """
        self.checkpoint_stages = set(checkpoint_stages or [])
        self.trace = trace_logger
        self.interactive = interactive
        self.decisions: list[HumanDecision] = []

    def is_checkpoint(self, stage_name: str) -> bool:
        """判断是否为检查点"""
        return stage_name in self.checkpoint_stages

    def pause(self, stage_name: str, summary: str = "",
              output_preview: str = "") -> HumanDecision:
        """
        暂停并等待人工决策

        Args:
            stage_name: 当前阶段名
            summary: 阶段执行摘要
            output_preview: 输出预览（截断）

        Returns:
            HumanDecision
        """
        if not self.is_checkpoint(stage_name):
            decision = HumanDecision(
                stage=stage_name, action=HumanAction.CONTINUE,
                feedback="非检查点，自动继续"
            )
            self._record(decision)
            return decision

        logger.info(f"[Checkpoint:{stage_name}] 需要人工确认")

        if not self.interactive:
            decision = HumanDecision(
                stage=stage_name, action=HumanAction.CONTINUE,
                feedback="非交互模式，自动继续"
            )
            self._record(decision)
            return decision

        # 交互模式
        self._print_checkpoint(stage_name, summary, output_preview)
        action = self._get_user_action()
        feedback = ""
        if action == HumanAction.MODIFY:
            while True:
                raw = input("请输入修改建议: ").strip()
                # 移除控制字符，防止日志注入
                feedback = "".join(c for c in raw if c.isprintable() or c in "\n\r\t")
                if feedback:
                    break
                print("修改建议不能为空，请重新输入")

        decision = HumanDecision(
            stage=stage_name, action=action, feedback=feedback
        )
        self._record(decision)
        return decision

    def _print_checkpoint(self, stage_name: str, summary: str,
                          output_preview: str):
        """打印检查点信息"""
        lines = [
            "",
            "=" * 60,
            f"  人工检查点: {stage_name}",
            "=" * 60,
        ]
        if summary:
            lines.append(f"  摘要: {summary}")
        if output_preview:
            preview = output_preview[:500]
            if len(output_preview) > 500:
                preview += "..."
            # 移除终端控制字符，防止注入
            preview = "".join(c for c in preview if c.isprintable() or c in "\n\r\t")
            lines.append(f"  输出预览:\n{preview}")
        lines.extend([
            "-" * 60,
            "  请选择操作:",
            "  [c] 继续 (continue)",
            "  [m] 修改后继续 (modify)",
            "  [r] 重新生成 (regenerate)",
            "  [a] 终止 (abort)",
            "-" * 60,
        ])
        msg = "\n".join(lines)
        print(msg)
        logger.info(f"[Checkpoint:{stage_name}] 等待人工决策")

    def _get_user_action(self) -> HumanAction:
        """获取用户操作"""
        action_map = {
            "c": HumanAction.CONTINUE,
            "m": HumanAction.MODIFY,
            "r": HumanAction.REGENERATE,
            "a": HumanAction.ABORT,
        }
        while True:
            try:
                choice = input("请输入选择 [c/m/r/a]: ").strip().lower()
                if choice in action_map:
                    return action_map[choice]
                print("无效选择，请输入 c/m/r/a")
            except (EOFError, KeyboardInterrupt):
                print("\n检测到中断，终止执行")
                return HumanAction.ABORT

    def _record(self, decision: HumanDecision):
        """记录决策"""
        self.decisions.append(decision)
        if self.trace:
            self.trace.log_human_input(
                decision.stage, decision.action.value, decision.feedback
            )
        logger.info(
            f"[Checkpoint:{decision.stage}] 用户选择: {decision.action.value}"
        )

    def get_decisions(self) -> list[HumanDecision]:
        """获取所有决策记录"""
        return list(self.decisions)
