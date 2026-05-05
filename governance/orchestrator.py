"""任务编排器：治理模式下的完整流水线编排"""

import json
import logging
import time
from pathlib import Path
from typing import Any

from agent.config import AgentConfig
from agent.input_loader import InputLoader
from agent.requirement_analyzer import RequirementAnalyzer
from agent.design_planner import DesignPlanner
from agent.diagram_generator import DiagramGenerator
from agent.test_case_generator import TestCaseGenerator
from agent.review_agent import ReviewAgent
from agent.output_manager import OutputManager
from governance.models import (
    GovernanceConfig, StageRecord, ValidationResult, GateDecision
)
from governance.trace_logger import TraceLogger, TracingLLMClient
from governance.tool_validator import ToolValidator
from governance.stage_gate import StageGate
from governance.context_controller import ContextController
from governance.repair_controller import RepairController
from governance.human_checkpoint import HumanCheckpoint
from governance.prompt_registry import PromptRegistry
from governance.consistency_checker import ConsistencyChecker

logger = logging.getLogger("reqdesign")


class _RegenerateSignal(Exception):
    """内部信号：用户在人工检查点要求重新生成"""
    def __init__(self, stage: str):
        self.stage = stage


class TaskOrchestrator:
    """治理模式下的任务编排器"""

    def __init__(self, config: AgentConfig,
                 gov_config: GovernanceConfig = None):
        self.config = config
        self.gov = gov_config or GovernanceConfig.from_yaml_dict(config._raw)

        # 核心组件
        self.trace = TraceLogger()
        self.validator = ToolValidator()
        self.gate = StageGate(self.gov)
        self.context = ContextController()
        self.repair = RepairController(max_rounds=self.gov.max_repair_rounds)
        self.checkpoint = HumanCheckpoint(
            checkpoint_stages=self.gov.human_checkpoints,
            trace_logger=self.trace,
            interactive=True,
        )
        self.prompt_registry = PromptRegistry()
        self.consistency = ConsistencyChecker()

        # LLM客户端（带追踪包装）
        from agent.llm_client import LLMClient
        base_llm = LLMClient(config)
        self.llm = TracingLLMClient(base_llm, self.trace)

        # Agent实例（使用tracing LLM）
        self.input_loader = InputLoader()
        self.requirement_analyzer = RequirementAnalyzer(self.llm)
        self.design_planner = DesignPlanner(self.llm)
        self.diagram_generator = DiagramGenerator(self.llm)
        self.test_case_generator = TestCaseGenerator(self.llm)
        self.review_agent = ReviewAgent(
            self.llm, max_retries=config.retry.max_retries
        )

        # 阶段记录
        self.stage_records: list[StageRecord] = []

    def run_design_task(self, input_path: str, output_dir: str) -> dict:
        """治理模式下的完整设计任务"""
        logger.info("=== [Governed] 开始完整设计任务 ===")
        self.trace.log("system", "task_start", {
            "task": "design", "input": input_path, "output": output_dir
        })

        results = {}

        try:
            return self._run_design_stages(input_path, output_dir, results)
        finally:
            # 无论成功/失败/用户终止，都导出追踪和治理报告
            if self.gov.trace_enabled:
                self.trace.export_json(f"{output_dir}/trace.json")
            self._export_governance_report(output_dir, results)

    def _run_design_stages(self, input_path: str, output_dir: str, results: dict) -> dict:
        """执行设计任务的各个阶段"""

        # Stage 1: 读取输入
        record = self._run_stage("input_loader", self._stage_input, input_path)
        if record.status not in ("success", "repaired"):
            logger.error("输入读取失败，无法继续")
            return results
        requirement_text = record.output_data
        self.context.set("full_text", requirement_text)
        results["requirement_text"] = requirement_text

        # Stage 2: 需求分析
        self.llm.set_stage("requirement_analysis")
        record = self._run_stage("requirement_analysis", self._stage_analysis)
        req_json = record.output_data if record.status in ("success", "repaired") else {}
        self.context.set("requirement_json", req_json)
        results["requirement_analysis"] = req_json

        if not req_json:
            logger.error("需求分析失败，跳过后续阶段")
            return results

        # 轻量审查：需求分析后规则检查，结果合并到阶段门控
        lightweight_review = self._lightweight_review(req_json)
        if lightweight_review.get("issues"):
            logger.warning(f"[轻量审查] 需求分析问题: {lightweight_review['issues']}")
            # 将轻量审查问题合并到需求分析阶段的validation
            for issue in lightweight_review["issues"]:
                if issue not in record.validation_result.warnings:
                    record.validation_result.warnings.append(issue)
            record.validation_result.score = max(
                0.0, record.validation_result.score - 0.05 * len(lightweight_review["issues"])
            )
        results["lightweight_review"] = lightweight_review
        self.trace.log("system", "lightweight_review", lightweight_review)

        # Stage 3: 设计规划
        self.llm.set_stage("design_planner")
        record = self._run_stage("design_planner", self._stage_design)
        design_text = record.output_data if record.status in ("success", "repaired") else ""
        self.context.set("design_text", design_text)
        results["system_design"] = design_text

        if not design_text:
            logger.error("设计规划失败，跳过后续阶段")
            return results

        # Stage 4: 图生成
        self.llm.set_stage("diagram_generator")
        record = self._run_stage("diagram_generator", self._stage_diagrams)
        diagrams = record.output_data if record.status in ("success", "repaired") else {}
        self.context.set("diagrams", diagrams)
        results["diagrams"] = diagrams

        # Stage 5: 测试用例
        self.llm.set_stage("test_case_generator")
        record = self._run_stage("test_case_generator", self._stage_test_cases)
        test_cases = record.output_data if record.status in ("success", "repaired") else ""
        self.context.set("test_cases", test_cases)
        results["test_cases"] = test_cases

        # 跨产物一致性检查
        try:
            consistency_result = self.consistency.check_all(
                req_json, design_text, diagrams, test_cases
            )
            results["consistency"] = {
                "score": consistency_result.score,
                "errors": consistency_result.errors,
                "warnings": consistency_result.warnings,
                "checks": consistency_result.checks,
            }
            self.trace.log("system", "consistency_check", {
                "score": consistency_result.score,
                "error_count": len(consistency_result.errors),
                "warning_count": len(consistency_result.warnings),
                "errors": consistency_result.errors,
                "warnings": consistency_result.warnings,
                "checks": consistency_result.checks,
            })
        except Exception as e:
            logger.error(f"一致性检查失败: {e}", exc_info=True)
            results["consistency"] = {"score": 0, "errors": [str(e)], "warnings": [], "checks": []}

        # Stage 6: 审查与修复
        self.llm.set_stage("review_agent")
        record = self._run_stage("review_agent", self._stage_review)
        review_result = record.output_data if record.status in ("success", "repaired") else {}
        # 将一致性检查结果合并到审查阶段门控
        if consistency_result.errors:
            for err in consistency_result.errors:
                if err not in record.validation_result.errors:
                    record.validation_result.errors.append(err)
            record.validation_result.score = max(
                0.0, record.validation_result.score - 0.1 * len(consistency_result.errors)
            )
        if consistency_result.warnings:
            for w in consistency_result.warnings:
                if w not in record.validation_result.warnings:
                    record.validation_result.warnings.append(w)
        results["review"] = review_result

        # 生成审查报告
        review_report = ""
        try:
            review_report = self.review_agent.generate_report(review_result)
        except Exception as e:
            logger.error(f"审查报告生成失败: {e}", exc_info=True)
        results["review_report"] = review_report

        # 保存输出
        self._save_outputs(output_dir, results, requirement_text)

        score = review_result.get("overall_score", 0) if isinstance(review_result, dict) else 0
        logger.info(f"=== [Governed] 设计任务完成 === 综合得分: {score}")
        return results

    def run_analyze_task(self, input_path: str, output_dir: str) -> dict:
        """治理模式下的需求分析任务（使用治理流程）"""
        logger.info("=== [Governed] 开始需求分析任务 ===")

        analyze_results = {"requirement_analysis": {}}

        try:
            # Stage 1: 读取输入
            record = self._run_stage("input_loader", self._stage_input, input_path)
            if record.status not in ("success", "repaired"):
                logger.error("输入读取失败")
                return analyze_results

            requirement_text = record.output_data
            self.context.set("full_text", requirement_text)

            # Stage 2: 需求分析（带治理）
            self.llm.set_stage("requirement_analysis")
            record = self._run_stage("requirement_analysis", self._stage_analysis)
            req_json = record.output_data if record.status in ("success", "repaired") else {}

            # 轻量审查
            lightweight_review = self._lightweight_review(req_json)
            if lightweight_review.get("issues"):
                logger.warning(f"[轻量审查] {lightweight_review['issues']}")

            # 保存输出
            output_mgr = OutputManager(output_dir)
            output_mgr.save_requirement_analysis(req_json, requirement_text)

            analyze_results = {
                "requirement_analysis": req_json,
                "lightweight_review": lightweight_review,
            }

            logger.info("=== [Governed] 需求分析任务完成 ===")
            return analyze_results
        finally:
            if self.gov.trace_enabled:
                self.trace.export_json(f"{output_dir}/trace.json")
            self._export_governance_report(output_dir, analyze_results)

    def _run_stage(self, stage_name: str, stage_fn,
                   *args) -> StageRecord:
        """执行一个阶段，带追踪、校验、门控、真正的重试和多轮修复"""
        record = StageRecord(stage_name=stage_name, start_time=time.time())
        self.trace.log_stage_start(stage_name)

        # 记录该阶段期望的上下文字段
        expected_ctx = self.context.get_for_stage(stage_name)
        if expected_ctx:
            self.trace.log("context", "stage_context", {
                "stage": stage_name,
                "available_keys": list(expected_ctx.keys()),
            })
        retry_count = 0
        repair_count = 0
        max_retries = self.config.retry.max_retries
        output = None  # 修复后跳过stage_fn，直接校验修复结果
        agent_warnings = []

        while True:
            try:
                # 执行阶段（REPAIR后跳过，直接使用修复结果）
                if output is None:
                    raw_output = stage_fn(record, *args)

                    # 解包(output, warnings)元组
                    agent_warnings = []
                    if isinstance(raw_output, tuple) and len(raw_output) == 2:
                        output, agent_warnings = raw_output
                    else:
                        output = raw_output
                    record.output_data = output

                # 校验
                vr = self._validate_stage_output(stage_name, output)
                # 合并Agent warnings
                if agent_warnings:
                    vr.warnings.extend(agent_warnings)
                    vr.score = max(0.0, vr.score - 0.05 * len(agent_warnings))
                record.validation_result = vr
                self.trace.log_validation(
                    stage_name, vr.is_valid, vr.errors, vr.warnings, vr.score
                )

                # 门控
                decision = self.gate.evaluate(
                    stage_name, vr,
                    retry_count=retry_count,
                    repair_count=repair_count,
                    max_retries=max_retries,
                )
                self.trace.log_gate_decision(stage_name, decision.value)

                if decision == GateDecision.PROCEED:
                    record.status = "success"
                    break

                elif decision == GateDecision.RETRY:
                    retry_count += 1
                    logger.info(
                        f"[{stage_name}] RETRY {retry_count}/{max_retries}"
                    )
                    output = None  # 清空，下次循环重新执行stage_fn
                    continue

                elif decision == GateDecision.REPAIR:
                    repair_count += 1
                    logger.info(
                        f"[{stage_name}] REPAIR 轮次 {repair_count}"
                    )
                    output, repair_records = self._try_repair(
                        stage_name, output, vr
                    )
                    record.repair_records.extend(repair_records)
                    for rr in repair_records:
                        self.trace.log_repair(
                            stage_name, rr.attempt, rr.error,
                            rr.action, rr.success
                        )
                    record.output_data = output
                    agent_warnings = []  # 修复后清空旧warnings
                    # output已更新，下次循环跳过stage_fn直接校验

                else:  # HALT
                    record.status = "halted"
                    break

            except Exception as e:
                logger.error(f"阶段 {stage_name} 异常: {e}", exc_info=True)
                record.status = "failed"
                record.validation_result = ValidationResult(
                    is_valid=False, errors=[str(e)], score=0.0
                )
                break

        record.end_time = time.time()
        self.stage_records.append(record)
        self.trace.log_stage_end(
            stage_name, record.status, record.duration
        )

        # 人工检查点（所有阶段都可配置）
        # REGENERATE时重新执行整个阶段
        while True:
            try:
                self._check_human_checkpoint(stage_name, {stage_name: record.output_data})
                break
            except _RegenerateSignal:
                logger.info(f"[{stage_name}] 重新生成中...")
                output = None
                record = StageRecord(stage=stage_name)
                record.start_time = time.time()
                # 重新执行阶段
                try:
                    raw_output = stage_fn(record, *args)
                    agent_warnings = []
                    if isinstance(raw_output, tuple) and len(raw_output) == 2:
                        output, agent_warnings = raw_output
                    else:
                        output = raw_output
                    record.output_data = output
                    vr = self._validate_stage_output(stage_name, output)
                    if agent_warnings:
                        vr.warnings.extend(agent_warnings)
                        vr.score = max(0.0, vr.score - 0.05 * len(agent_warnings))
                    record.validation_result = vr
                    record.status = "success"
                    # 更新上下文，使后续阶段使用新输出
                    ctx_key = {
                        "requirement_analysis": "requirement_json",
                        "design_planner": "design_text",
                        "diagram_generator": "diagrams",
                        "test_case_generator": "test_cases",
                    }.get(stage_name)
                    if ctx_key:
                        self.context.set(ctx_key, output)
                except Exception as e:
                    logger.error(f"重新生成失败: {e}", exc_info=True)
                    record.status = "failed"
                record.end_time = time.time()
                self.stage_records[-1] = record

        # 上下文快照
        self.context.snapshot()

        return record

    def _validate_stage_output(self, stage: str,
                               output: Any) -> ValidationResult:
        """校验阶段输出"""
        if stage == "requirement_analysis":
            if output is None:
                return ValidationResult(is_valid=False, errors=["输出为空"], score=0.0)
            return self.validator.validate_json(output, stage)
        elif stage == "design_planner":
            if not output:
                return ValidationResult(is_valid=False, errors=["设计文档为空"], score=0.0)
            return self.validator.validate_markdown(output, stage)
        elif stage == "diagram_generator":
            if output is None:
                return ValidationResult(is_valid=False, errors=["输出为None"], score=0.0)
            if isinstance(output, dict):
                all_valid = True
                errors = []
                for name, content in output.items():
                    vr = self.validator.validate_mermaid(content, name)
                    if not vr.is_valid:
                        all_valid = False
                        errors.extend(vr.errors)
                return ValidationResult(
                    is_valid=all_valid, errors=errors,
                    score=1.0 if all_valid else 0.5
                )
            return ValidationResult(is_valid=False, errors=["输出格式错误"], score=0.0)
        elif stage == "test_case_generator":
            if not output:
                return ValidationResult(is_valid=False, errors=["测试用例为空"], score=0.0)
            return self.validator.validate_markdown(output, "test_cases")
        elif stage == "review_agent":
            if not isinstance(output, dict):
                return ValidationResult(is_valid=False, errors=["审查结果格式错误"], score=0.0)
            try:
                score = float(output.get("overall_score", 0))
            except (TypeError, ValueError):
                score = 0.0
            # 检测评分范围：>1则视为0-100制，否则0-1制
            if score > 1.0:
                score = score / 100
            score = max(0.0, min(1.0, score))
            is_valid = score >= 0.3
            return ValidationResult(
                is_valid=is_valid, score=score,
                errors=[] if is_valid else [f"审查得分过低: {score*100:.0f}"]
            )
        else:
            if output is None:
                return ValidationResult(is_valid=False, errors=["输出为空"], score=0.0)
            return ValidationResult(is_valid=True)

    def _try_repair(self, stage: str, output: Any,
                    vr: ValidationResult) -> tuple[Any, list]:
        """尝试修复"""
        req_json = self.context.get("requirement_json") or {}

        def repair_fn(current, errors):
            req_summary = str(req_json)[:500] if req_json else "无"
            current_str = str(current)
            # 在自然断点截断（换行符或句号）
            if len(current_str) > 2000:
                cut = current_str[:2000]
                last_nl = cut.rfind('\n')
                if last_nl > 1500:
                    cut = cut[:last_nl]
                current_str = cut + "\n...(截断)"
            prompt = (
                f"请修复以下输出中的问题。\n\n"
                f"需求摘要: {req_summary}\n\n"
                f"需要修复的问题:\n{chr(10).join(errors)}\n\n"
                f"当前输出:\n{current_str}"
            )
            if isinstance(current, dict):
                return self.llm.generate_json(prompt)
            return self.llm.generate_text(prompt)

        def validate_fn(data):
            return self._validate_stage_output(stage, data)

        return self.repair.attempt_repair(
            stage, output, validate_fn, repair_fn
        )

    def _check_human_checkpoint(self, stage: str, results: dict):
        """检查人工检查点"""
        if not self.checkpoint.is_checkpoint(stage):
            return

        summary = f"阶段 {stage} 完成"
        preview = json.dumps(
            results.get(stage, {}), ensure_ascii=False, indent=2
        )[:500]

        decision = self.checkpoint.pause(stage, summary, preview)
        if decision.action.value == "abort":
            raise SystemExit(f"用户在 {stage} 阶段终止执行")
        elif decision.action.value == "modify":
            feedback = decision.feedback or ""
            logger.info(f"[{stage}] 用户修改建议: {feedback}")
        elif decision.action.value == "regenerate":
            logger.info(f"[{stage}] 用户要求重新生成，将重新执行该阶段")
            raise _RegenerateSignal(stage)

    def _lightweight_review(self, req_json: dict) -> dict:
        """需求分析后轻量审查（纯规则，不调用LLM）"""
        issues = []
        if not isinstance(req_json, dict):
            return {"pass": False, "issues": ["需求分析结果格式错误（非dict）"]}
        if not req_json:
            return {"pass": False, "issues": ["需求分析结果为空"]}

        # 检查核心字段
        actors = req_json.get("actors", [])
        functions = req_json.get("functions", [])
        entities = req_json.get("entities", [])

        if not actors:
            issues.append("缺少参与者(actors)定义")
        if not functions:
            issues.append("缺少功能(functions)定义")
        if not entities:
            issues.append("缺少实体(entities)定义")

        # 检查数量合理性
        if isinstance(functions, list) and len(functions) < 2:
            issues.append(f"功能点过少({len(functions)})，可能遗漏")
        if isinstance(entities, list) and len(entities) < 2:
            issues.append(f"实体定义过少({len(entities)})，可能遗漏")

        # 检查功能完整性
        if isinstance(functions, list):
            for i, f in enumerate(functions):
                if isinstance(f, dict):
                    if not f.get("name") and not f.get("function_name"):
                        issues.append(f"功能点[{i}]缺少名称")
                    if not f.get("description"):
                        issues.append(f"功能点[{i}]缺少描述")

        return {
            "pass": len(issues) == 0,
            "issues": issues,
            "actor_count": len(actors) if isinstance(actors, list) else 0,
            "function_count": len(functions) if isinstance(functions, list) else 0,
            "entity_count": len(entities) if isinstance(entities, list) else 0,
        }

    # === 各阶段执行函数 ===

    def _stage_input(self, record: StageRecord,
                     input_path: str) -> str:
        """读取输入"""
        return self.input_loader.load(input_path)

    def _stage_analysis(self, record: StageRecord) -> tuple[dict, list]:
        """需求分析，返回(output, agent_warnings)"""
        text = self.context.get("full_text") or ""
        req_json = self.requirement_analyzer.analyze(text)
        warnings = self.requirement_analyzer.validate_result(req_json)
        if warnings:
            logger.warning(f"[requirement_analysis] 验证警告: {warnings}")
        return req_json, warnings

    def _stage_design(self, record: StageRecord) -> tuple[str, list]:
        """设计规划，返回(output, agent_warnings)"""
        req_json = self.context.get("requirement_json") or {}
        design = self.design_planner.generate_design(req_json)
        warnings = self.design_planner.validate_design(design, req_json)
        if warnings:
            logger.warning(f"[design_planner] 验证警告: {warnings}")
        return design, warnings

    def _stage_diagrams(self, record: StageRecord) -> dict:
        """图生成"""
        req_json = self.context.get("requirement_json") or {}
        design = self.context.get("design_text") or ""
        return self.diagram_generator.generate_all(req_json, design)

    def _stage_test_cases(self, record: StageRecord) -> tuple[str, list]:
        """测试用例生成，返回(output, agent_warnings)"""
        req_json = self.context.get("requirement_json") or {}
        design = self.context.get("design_text") or ""
        cases = self.test_case_generator.generate(req_json, design)
        warnings = self.test_case_generator.validate_test_cases(cases, req_json)
        if warnings:
            logger.warning(f"[test_case_generator] 验证警告: {warnings}")
        return cases, warnings

    def _stage_review(self, record: StageRecord) -> dict:
        """审查与修复"""
        req_json = self.context.get("requirement_json") or {}
        design = self.context.get("design_text") or ""
        diagrams = self.context.get("diagrams") or {}
        review_result, repaired = self.review_agent.review_and_repair(
            req_json, design, diagrams
        )
        self.context.set("diagrams", repaired)
        return review_result

    def _save_outputs(self, output_dir: str, results: dict,
                      requirement_text: str):
        """保存所有输出"""
        output_mgr = OutputManager(output_dir)
        output_mgr.save_all(
            requirement_json=results.get("requirement_analysis", {}),
            requirement_text=requirement_text,
            design_text=results.get("system_design", ""),
            diagrams=results.get("diagrams", {}),
            test_cases=results.get("test_cases", ""),
            review_report=results.get("review_report", ""),
            review_result=results.get("review", {}),
        )

    def _export_governance_report(self, output_dir: str, results: dict):
        """导出治理报告（使用to_summary截断版本）"""
        report = {
            "governance_summary": {
                "total_stages": len(self.stage_records),
                "succeeded": sum(
                    1 for r in self.stage_records if r.status == "success"
                ),
                "repaired": sum(
                    1 for r in self.stage_records if r.status == "repaired"
                ),
                "failed": sum(
                    1 for r in self.stage_records if r.status == "failed"
                ),
                "halted": sum(
                    1 for r in self.stage_records if r.status == "halted"
                ),
            },
            "stages": [r.to_summary() for r in self.stage_records],
            "prompt_versions": self.prompt_registry.get_all_versions(),
            "trace_summary": self.trace.get_summary(),
            "consistency": results.get("consistency", {}),
            "lightweight_review": results.get("lightweight_review", {}),
            "human_decisions": [
                {
                    "stage": d.stage,
                    "action": d.action.value,
                    "feedback": d.feedback,
                    "timestamp": d.timestamp,
                }
                for d in self.checkpoint.decisions
            ],
        }

        Path(output_dir).mkdir(parents=True, exist_ok=True)
        path = f"{output_dir}/governance_report.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        logger.info(f"治理报告已导出: {path}")
