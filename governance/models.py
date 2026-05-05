"""治理框架数据模型"""

import json
import time
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any


class GateDecision(Enum):
    """阶段门控决策"""
    PROCEED = "proceed"
    RETRY = "retry"
    REPAIR = "repair"
    HALT = "halt"


class HumanAction(Enum):
    """人工检查点操作"""
    CONTINUE = "continue"
    MODIFY = "modify"
    REGENERATE = "regenerate"
    ABORT = "abort"


@dataclass
class ValidationResult:
    """校验结果"""
    is_valid: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    score: float = 1.0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "ValidationResult":
        return cls(
            is_valid=data.get("is_valid", False),
            errors=data.get("errors", []),
            warnings=data.get("warnings", []),
            score=data.get("score", 1.0),
        )


@dataclass
class RepairRecord:
    """修复记录"""
    attempt: int
    error: str
    action: str
    result: str
    success: bool

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "RepairRecord":
        return cls(**data)


@dataclass
class HumanDecision:
    """人工决策记录"""
    stage: str
    action: HumanAction
    feedback: str = ""
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["action"] = self.action.value
        return d

    @classmethod
    def from_dict(cls, data: dict) -> "HumanDecision":
        data = data.copy()
        data["action"] = HumanAction(data["action"])
        return cls(**data)


@dataclass
class TraceEntry:
    """追踪条目"""
    timestamp: float
    stage: str
    event_type: str
    data: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "TraceEntry":
        return cls(**data)


@dataclass
class StageRecord:
    """阶段执行记录"""
    stage_name: str
    input_data: Any = None
    output_data: Any = None
    validation_result: ValidationResult = field(
        default_factory=lambda: ValidationResult(is_valid=True)
    )
    repair_records: list[RepairRecord] = field(default_factory=list)
    start_time: float = 0.0
    end_time: float = 0.0
    status: str = "pending"

    @property
    def duration(self) -> float:
        if self.start_time and self.end_time:
            return self.end_time - self.start_time
        return 0.0

    def to_dict(self) -> dict:
        """完整序列化（保留全部数据）"""
        return {
            "stage_name": self.stage_name,
            "input_data": self.input_data,
            "output_data": self.output_data,
            "validation": self.validation_result.to_dict(),
            "repair_records": [r.to_dict() for r in self.repair_records],
            "start_time": self.start_time,
            "end_time": self.end_time,
            "duration": self.duration,
            "status": self.status,
        }

    def to_summary(self) -> dict:
        """摘要序列化（截断input/output，用于治理报告）"""
        return {
            "stage_name": self.stage_name,
            "input_summary": _summarize(self.input_data),
            "output_summary": _summarize(self.output_data),
            "validation": self.validation_result.to_dict(),
            "repair_records": [r.to_dict() for r in self.repair_records],
            "start_time": self.start_time,
            "end_time": self.end_time,
            "duration": self.duration,
            "status": self.status,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "StageRecord":
        return cls(
            stage_name=data["stage_name"],
            input_data=data.get("input_data", data.get("input_summary")),
            output_data=data.get("output_data", data.get("output_summary")),
            validation_result=ValidationResult.from_dict(data.get("validation", {})),
            repair_records=[
                RepairRecord.from_dict(r) for r in data.get("repair_records", [])
            ],
            start_time=data.get("start_time", 0.0),
            end_time=data.get("end_time", 0.0),
            status=data.get("status", "pending"),
        )


@dataclass
class GovernanceConfig:
    """治理配置"""
    enabled: bool = False
    trace_enabled: bool = True
    human_checkpoints: list[str] = field(default_factory=list)
    max_repair_rounds: int = 3
    gate_thresholds: dict = field(default_factory=lambda: {
        "syntax_valid": True,
        "min_completeness": 0.8,
        "min_consistency": 0.7,
    })

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "GovernanceConfig":
        return cls(
            enabled=data.get("enabled", False),
            trace_enabled=data.get("trace_enabled", True),
            human_checkpoints=data.get("human_checkpoints", []),
            max_repair_rounds=data.get("max_repair_rounds", 3),
            gate_thresholds=data.get("gate_thresholds", {
                "syntax_valid": True,
                "min_completeness": 0.8,
                "min_consistency": 0.7,
            }),
        )

    @classmethod
    def from_yaml_dict(cls, data: dict) -> "GovernanceConfig":
        """从YAML配置段加载"""
        gov = data.get("governance", {})
        return cls.from_dict(gov)


def _summarize(data: Any, max_len: int = 200) -> str:
    """将数据截断为摘要字符串"""
    if data is None:
        return ""
    s = str(data)
    if len(s) > max_len:
        return s[:max_len] + "..."
    return s
