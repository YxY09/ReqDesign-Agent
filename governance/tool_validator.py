"""工具输出校验模块"""

import json
from typing import Any

from governance.models import ValidationResult
from agent.mermaid_validator import MermaidValidator

# 各阶段必需的JSON字段
REQUIRED_JSON_FIELDS = {
    "requirement_analysis": ["actors", "functions", "entities"],
    "review_agent": ["overall_score"],
}

# 设计文档必需章节
DESIGN_SECTIONS = ["系统概述", "模块划分", "核心类"]


class ToolValidator:
    """校验各工具/Agent的输出"""

    def __init__(self, mermaid_validator: MermaidValidator = None):
        self.mermaid = mermaid_validator or MermaidValidator()

    def validate_json(self, data: Any, stage: str = "") -> ValidationResult:
        """校验JSON输出"""
        errors = []
        warnings = []

        if data is None:
            return ValidationResult(is_valid=False, errors=["输出为None"])

        if isinstance(data, str):
            try:
                data = json.loads(data)
            except json.JSONDecodeError as e:
                return ValidationResult(
                    is_valid=False, errors=[f"JSON解析失败: {e}"]
                )

        if not isinstance(data, dict):
            return ValidationResult(
                is_valid=False, errors=[f"期望dict类型，实际为{type(data).__name__}"]
            )

        if not data:
            return ValidationResult(is_valid=False, errors=["JSON为空对象"])

        # 检查必需字段
        required = REQUIRED_JSON_FIELDS.get(stage, [])
        for field in required:
            if field not in data:
                errors.append(f"缺少必需字段: {field}")
            elif not data[field]:
                warnings.append(f"字段为空: {field}")

        # 检查列表字段类型
        for key, val in data.items():
            if isinstance(val, list) and not val:
                warnings.append(f"列表字段为空: {key}")

        score = 1.0 if not errors else max(0.0, 1.0 - len(errors) * 0.3)
        return ValidationResult(
            is_valid=len(errors) == 0,
            errors=errors,
            warnings=warnings,
            score=score,
        )

    def validate_mermaid(self, content: str,
                         diagram_type: str = "") -> ValidationResult:
        """校验Mermaid输出"""
        if not content or not content.strip():
            return ValidationResult(is_valid=False, errors=["Mermaid代码为空"])

        is_valid, msg = self.mermaid.validate(content, diagram_type)
        errors = [] if is_valid else [msg]
        score = 1.0 if is_valid else 0.0
        return ValidationResult(
            is_valid=is_valid, errors=errors, score=score
        )

    def validate_markdown(self, content: str,
                          stage: str = "") -> ValidationResult:
        """校验Markdown输出"""
        errors = []
        warnings = []

        if not content or not content.strip():
            return ValidationResult(is_valid=False, errors=["Markdown内容为空"])

        if len(content.strip()) < 20:
            warnings.append("内容过短（<20字符）")

        # 设计文档特殊检查
        if stage == "design":
            content_lower = content.lower()
            for section in DESIGN_SECTIONS:
                if section not in content and section.lower() not in content_lower:
                    warnings.append(f"缺少章节: {section}")

        # 测试用例特殊检查
        if stage == "test_cases":
            if "|" not in content:
                warnings.append("未检测到表格格式")

        score = 1.0 if not errors else max(0.0, 1.0 - len(errors) * 0.3)
        if warnings:
            score = min(score, max(0.7, 1.0 - len(warnings) * 0.1))

        return ValidationResult(
            is_valid=len(errors) == 0,
            errors=errors,
            warnings=warnings,
            score=score,
        )

    def validate_output(self, output: Any, output_type: str,
                        stage: str = "") -> ValidationResult:
        """通用校验入口"""
        if output_type == "json":
            return self.validate_json(output, stage)
        elif output_type == "mermaid":
            return self.validate_mermaid(output, stage)
        elif output_type == "markdown":
            return self.validate_markdown(output, stage)
        else:
            if output is None or (isinstance(output, str) and not output.strip()):
                return ValidationResult(is_valid=False, errors=["输出为空"])
            return ValidationResult(is_valid=True)
