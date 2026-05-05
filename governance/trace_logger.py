"""全链路追踪模块"""

import json
import logging
import time
from pathlib import Path

from governance.models import TraceEntry

logger = logging.getLogger("reqdesign")


class TraceLogger:
    """全链路追踪记录器"""

    def __init__(self, output_dir: str = ""):
        self.entries: list[TraceEntry] = []
        self.output_dir = output_dir

    def log(self, stage: str, event_type: str, data: dict = None):
        """记录一条追踪条目"""
        entry = TraceEntry(
            timestamp=time.time(),
            stage=stage,
            event_type=event_type,
            data=data or {},
        )
        self.entries.append(entry)
        logger.debug(f"[Trace] {stage}/{event_type}: {_summarize_data(data)}")

    def log_llm_call(self, stage: str, method: str, messages: list,
                     result: str, duration: float):
        """记录LLM调用"""
        input_chars = 0
        for m in messages:
            if isinstance(m, dict):
                input_chars += len(str(m.get("content", "")))
            elif hasattr(m, "content"):
                input_chars += len(str(m.content))
            else:
                input_chars += len(str(m))
        self.log(stage, "llm_call", {
            "method": method,
            "input_messages": len(messages),
            "input_chars": input_chars,
            "output_chars": len(result),
            "duration_seconds": round(duration, 3),
        })

    def log_validation(self, stage: str, is_valid: bool, errors: list,
                       warnings: list, score: float):
        """记录校验结果"""
        self.log(stage, "validation", {
            "is_valid": is_valid,
            "errors": errors,
            "warnings": warnings,
            "score": score,
        })

    def log_repair(self, stage: str, attempt: int, error: str,
                   action: str, success: bool):
        """记录修复操作"""
        self.log(stage, "repair", {
            "attempt": attempt,
            "error": error,
            "action": action,
            "success": success,
        })

    def log_gate_decision(self, stage: str, decision: str, reason: str = ""):
        """记录门控决策"""
        self.log(stage, "gate_decision", {
            "decision": decision,
            "reason": reason,
        })

    def log_human_input(self, stage: str, action: str, feedback: str = ""):
        """记录人工输入"""
        self.log(stage, "human_input", {
            "action": action,
            "feedback": feedback,
        })

    def log_stage_start(self, stage: str):
        """记录阶段开始"""
        self.log(stage, "stage_start")

    def log_stage_end(self, stage: str, status: str, duration: float):
        """记录阶段结束"""
        self.log(stage, "stage_end", {
            "status": status,
            "duration_seconds": round(duration, 3),
        })

    def get_entries(self, stage: str = None,
                    event_type: str = None) -> list[TraceEntry]:
        """按条件过滤追踪条目"""
        result = self.entries
        if stage:
            result = [e for e in result if e.stage == stage]
        if event_type:
            result = [e for e in result if e.event_type == event_type]
        return result

    def get_summary(self) -> dict:
        """获取追踪摘要"""
        stages = {}
        for e in self.entries:
            if e.stage not in stages:
                stages[e.stage] = {"events": 0, "llm_calls": 0,
                                   "validations": 0, "repairs": 0}
            stages[e.stage]["events"] += 1
            if e.event_type == "llm_call":
                stages[e.stage]["llm_calls"] += 1
            elif e.event_type == "validation":
                stages[e.stage]["validations"] += 1
            elif e.event_type == "repair":
                stages[e.stage]["repairs"] += 1

        return {
            "total_entries": len(self.entries),
            "stages": stages,
        }

    def export_json(self, path: str = None) -> str:
        """导出追踪记录为JSON"""
        data = {
            "summary": self.get_summary(),
            "entries": [e.to_dict() for e in self.entries],
        }
        json_str = json.dumps(data, ensure_ascii=False, indent=2)
        if path:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_text(json_str, encoding="utf-8")
            logger.info(f"追踪记录已导出: {path}")
        return json_str

    def clear(self):
        """清空追踪记录"""
        self.entries.clear()


class TracingLLMClient:
    """透明包装LLMClient，捕获所有调用"""

    def __init__(self, llm_client, trace_logger: TraceLogger,
                 stage: str = "unknown"):
        self._client = llm_client
        self._trace = trace_logger
        self._stage = stage

    def set_stage(self, stage: str):
        """设置当前阶段名"""
        self._stage = stage

    @property
    def provider(self):
        return self._client.provider

    @property
    def model(self):
        return self._client.model

    @property
    def temperature(self):
        return self._client.temperature

    @property
    def max_tokens(self):
        return self._client.max_tokens

    def chat(self, messages: list[dict], temperature=None) -> str:
        """带追踪的chat调用"""
        start = time.time()
        try:
            result = self._client.chat(messages, temperature=temperature)
            duration = time.time() - start
            self._trace.log_llm_call(
                self._stage, "chat", messages, result, duration
            )
            return result
        except Exception as e:
            duration = time.time() - start
            self._trace.log(self._stage, "llm_error", {
                "method": "chat",
                "error": str(e),
                "duration_seconds": round(duration, 3),
            })
            raise

    def generate_json(self, prompt: str, system: str = "") -> dict:
        """带追踪的generate_json调用"""
        start = time.time()
        try:
            result = self._client.generate_json(prompt, system)
            duration = time.time() - start
            self._trace.log_llm_call(
                self._stage, "generate_json",
                [{"role": "user", "content": prompt}],
                json.dumps(result, ensure_ascii=False), duration
            )
            return result
        except Exception as e:
            duration = time.time() - start
            self._trace.log(self._stage, "llm_error", {
                "method": "generate_json",
                "error": str(e),
                "duration_seconds": round(duration, 3),
            })
            raise

    def generate_text(self, prompt: str, system: str = "") -> str:
        """带追踪的generate_text调用"""
        start = time.time()
        try:
            result = self._client.generate_text(prompt, system)
            duration = time.time() - start
            self._trace.log_llm_call(
                self._stage, "generate_text",
                [{"role": "user", "content": prompt}],
                result, duration
            )
            return result
        except Exception as e:
            duration = time.time() - start
            self._trace.log(self._stage, "llm_error", {
                "method": "generate_text",
                "error": str(e),
                "duration_seconds": round(duration, 3),
            })
            raise

    def __getattr__(self, name):
        """代理未包装的属性到内部客户端"""
        return getattr(self._client, name)


def _summarize_data(data: dict, max_len: int = 100) -> str:
    """截断数据为摘要"""
    if data is None:
        return ""
    s = str(data)
    if len(s) > max_len:
        return s[:max_len] + "..."
    return s
