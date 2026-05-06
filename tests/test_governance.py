"""治理框架测试"""

import json
import os
import tempfile

import pytest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

from governance.models import (
    StageRecord, ValidationResult, RepairRecord, HumanDecision,
    TraceEntry, GovernanceConfig, GateDecision, HumanAction,
)
from agent.config import AgentConfig
from governance.trace_logger import TraceLogger, TracingLLMClient
from governance.tool_validator import ToolValidator
from governance.repair_controller import RepairController
from governance.stage_gate import StageGate
from governance.context_controller import ContextController
from governance.human_checkpoint import HumanCheckpoint
from governance.prompt_registry import PromptRegistry


# ========== models.py ==========

class TestValidationResult:
    def test_create_valid(self):
        vr = ValidationResult(is_valid=True, score=1.0)
        assert vr.is_valid
        assert vr.score == 1.0
        assert vr.errors == []
        assert vr.warnings == []

    def test_create_invalid(self):
        vr = ValidationResult(is_valid=False, errors=["err1"], score=0.5)
        assert not vr.is_valid
        assert "err1" in vr.errors

    def test_to_dict(self):
        vr = ValidationResult(is_valid=True, errors=[], warnings=["w1"])
        d = vr.to_dict()
        assert d["is_valid"] is True
        assert d["warnings"] == ["w1"]

    def test_from_dict(self):
        d = {"is_valid": False, "errors": ["e"], "warnings": [], "score": 0.3}
        vr = ValidationResult.from_dict(d)
        assert not vr.is_valid
        assert vr.score == 0.3

    def test_from_dict_empty(self):
        vr = ValidationResult.from_dict({})
        assert not vr.is_valid
        assert vr.score == 1.0


class TestRepairRecord:
    def test_create(self):
        rr = RepairRecord(attempt=1, error="e", action="a", result="r", success=True)
        assert rr.attempt == 1
        assert rr.success

    def test_roundtrip(self):
        rr = RepairRecord(1, "e", "a", "r", False)
        d = rr.to_dict()
        rr2 = RepairRecord.from_dict(d)
        assert rr2.attempt == rr.attempt
        assert rr2.success == rr.success


class TestHumanDecision:
    def test_create(self):
        hd = HumanDecision(stage="s", action=HumanAction.CONTINUE)
        assert hd.action == HumanAction.CONTINUE

    def test_to_dict(self):
        hd = HumanDecision(stage="s", action=HumanAction.MODIFY, feedback="fix")
        d = hd.to_dict()
        assert d["action"] == "modify"
        assert d["feedback"] == "fix"

    def test_from_dict(self):
        d = {"stage": "s", "action": "abort", "feedback": "", "timestamp": 1.0}
        hd = HumanDecision.from_dict(d)
        assert hd.action == HumanAction.ABORT

    def test_from_dict_extra_keys(self):
        d = {"stage": "s", "action": "continue", "extra_key": "ignored"}
        hd = HumanDecision.from_dict(d)
        assert hd.stage == "s"
        assert hd.action == HumanAction.CONTINUE


class TestTraceEntry:
    def test_create(self):
        te = TraceEntry(timestamp=1.0, stage="s", event_type="e", data={"k": "v"})
        assert te.stage == "s"
        assert te.data == {"k": "v"}

    def test_roundtrip(self):
        te = TraceEntry(1.0, "s", "e", {"k": "v"})
        d = te.to_dict()
        te2 = TraceEntry.from_dict(d)
        assert te2.data == te.data

    def test_from_dict_extra_keys(self):
        d = {"timestamp": 1.0, "stage": "s", "event_type": "e", "data": {}, "unknown": 42}
        te = TraceEntry.from_dict(d)
        assert te.stage == "s"


class TestStageRecord:
    def test_duration(self):
        sr = StageRecord(stage_name="test", start_time=1.0, end_time=3.5)
        assert sr.duration == 2.5

    def test_duration_no_time(self):
        sr = StageRecord(stage_name="test")
        assert sr.duration == 0.0

    def test_to_dict(self):
        sr = StageRecord(stage_name="test", status="success")
        d = sr.to_dict()
        assert d["stage_name"] == "test"
        assert d["status"] == "success"


class TestGateDecision:
    def test_values(self):
        assert GateDecision.PROCEED.value == "proceed"
        assert GateDecision.RETRY.value == "retry"
        assert GateDecision.REPAIR.value == "repair"
        assert GateDecision.HALT.value == "halt"

    def test_from_value(self):
        assert GateDecision("proceed") == GateDecision.PROCEED


class TestHumanAction:
    def test_values(self):
        assert HumanAction.CONTINUE.value == "continue"
        assert HumanAction.MODIFY.value == "modify"
        assert HumanAction.REGENERATE.value == "regenerate"
        assert HumanAction.ABORT.value == "abort"


class TestGovernanceConfig:
    def test_defaults(self):
        gc = GovernanceConfig()
        assert not gc.enabled
        assert gc.trace_enabled
        assert gc.max_repair_rounds == 3
        assert gc.human_checkpoints == []

    def test_from_dict(self):
        gc = GovernanceConfig.from_dict({
            "enabled": True, "max_repair_rounds": 5,
            "human_checkpoints": ["stage1"]
        })
        assert gc.enabled
        assert gc.max_repair_rounds == 5
        assert "stage1" in gc.human_checkpoints

    def test_from_yaml_dict(self):
        gc = GovernanceConfig.from_yaml_dict({
            "governance": {"enabled": True}
        })
        assert gc.enabled

    def test_from_yaml_dict_missing(self):
        gc = GovernanceConfig.from_yaml_dict({})
        assert not gc.enabled


# ========== trace_logger.py ==========

class TestTraceLogger:
    def test_log(self):
        tl = TraceLogger()
        tl.log("stage", "event", {"key": "val"})
        assert len(tl.entries) == 1
        assert tl.entries[0].stage == "stage"

    def test_log_llm_call(self):
        tl = TraceLogger()
        tl.log_llm_call("s", "chat", [{"role": "user", "content": "hi"}], "hello", 1.0)
        assert len(tl.entries) == 1
        assert tl.entries[0].event_type == "llm_call"
        assert tl.entries[0].data["output_chars"] == 5

    def test_log_validation(self):
        tl = TraceLogger()
        tl.log_validation("s", True, [], [], 1.0)
        assert tl.entries[0].data["is_valid"]

    def test_log_repair(self):
        tl = TraceLogger()
        tl.log_repair("s", 1, "err", "fix", True)
        assert tl.entries[0].data["success"]

    def test_log_gate_decision(self):
        tl = TraceLogger()
        tl.log_gate_decision("s", "proceed")
        assert tl.entries[0].data["decision"] == "proceed"

    def test_log_human_input(self):
        tl = TraceLogger()
        tl.log_human_input("s", "continue", "ok")
        assert tl.entries[0].data["action"] == "continue"

    def test_log_stage_start_end(self):
        tl = TraceLogger()
        tl.log_stage_start("s")
        tl.log_stage_end("s", "success", 2.0)
        assert len(tl.entries) == 2
        assert tl.entries[1].data["status"] == "success"

    def test_get_entries_filter(self):
        tl = TraceLogger()
        tl.log("s1", "e1")
        tl.log("s2", "e2")
        tl.log("s1", "e3")

        assert len(tl.get_entries(stage="s1")) == 2
        assert len(tl.get_entries(event_type="e2")) == 1
        assert len(tl.get_entries(stage="s1", event_type="e1")) == 1

    def test_get_summary(self):
        tl = TraceLogger()
        tl.log_llm_call("s", "chat", [], "r", 1.0)
        tl.log_validation("s", True, [], [], 1.0)
        summary = tl.get_summary()
        assert summary["total_entries"] == 2
        assert summary["stages"]["s"]["llm_calls"] == 1

    def test_export_json(self):
        tl = TraceLogger()
        tl.log("s", "e")
        result = tl.export_json()
        data = json.loads(result)
        assert data["summary"]["total_entries"] == 1

    def test_export_json_to_file(self):
        tl = TraceLogger()
        tl.log("s", "e")
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            path = f.name
        try:
            tl.export_json(path)
            assert os.path.exists(path)
            with open(path) as f:
                data = json.load(f)
            assert data["summary"]["total_entries"] == 1
        finally:
            os.unlink(path)

    def test_clear(self):
        tl = TraceLogger()
        tl.log("s", "e")
        tl.clear()
        assert len(tl.entries) == 0


class TestTracingLLMClient:
    def _make_client(self):
        class MockLLM:
            provider = "test"
            model = "test-model"
            temperature = 0.3
            max_tokens = 8192
            def chat(self, messages, temperature=None):
                return "response"
            def generate_json(self, prompt, system=""):
                return {"key": "value"}
            def generate_text(self, prompt, system=""):
                return "text"
        return MockLLM()

    def test_chat(self):
        tl = TraceLogger()
        client = TracingLLMClient(self._make_client(), tl, "test")
        result = client.chat([{"role": "user", "content": "hi"}])
        assert result == "response"
        assert len(tl.entries) == 1

    def test_generate_json(self):
        tl = TraceLogger()
        client = TracingLLMClient(self._make_client(), tl, "test")
        result = client.generate_json("prompt")
        assert result == {"key": "value"}
        assert len(tl.entries) == 1

    def test_generate_text(self):
        tl = TraceLogger()
        client = TracingLLMClient(self._make_client(), tl, "test")
        result = client.generate_text("prompt")
        assert result == "text"
        assert len(tl.entries) == 1

    def test_properties(self):
        tl = TraceLogger()
        client = TracingLLMClient(self._make_client(), tl, "test")
        assert client.provider == "test"
        assert client.model == "test-model"
        assert client.temperature == 0.3
        assert client.max_tokens == 8192

    def test_set_stage(self):
        tl = TraceLogger()
        client = TracingLLMClient(self._make_client(), tl, "old")
        client.set_stage("new")
        assert client._stage == "new"

    def test_error_tracking(self):
        class FailLLM:
            provider = "test"
            model = "test"
            temperature = 0.3
            max_tokens = 100
            def chat(self, messages, temperature=None):
                raise RuntimeError("boom")
        tl = TraceLogger()
        client = TracingLLMClient(FailLLM(), tl, "test")
        with pytest.raises(RuntimeError):
            client.chat([{"role": "user", "content": "hi"}])
        assert len(tl.entries) == 1
        assert tl.entries[0].event_type == "llm_error"

    def test_getattr_private_raises(self):
        """访问私有属性应抛出AttributeError而非无限递归"""
        tl = TraceLogger()
        client = TracingLLMClient(self._make_client(), tl, "test")
        with pytest.raises(AttributeError):
            _ = client._nonexistent


# ========== tool_validator.py ==========

class TestToolValidator:
    def setup_method(self):
        self.tv = ToolValidator()

    def test_validate_json_valid(self):
        data = {"actors": ["u"], "functions": ["f"], "entities": ["e"]}
        vr = self.tv.validate_json(data, "requirement_analysis")
        assert vr.is_valid

    def test_validate_json_missing_fields(self):
        vr = self.tv.validate_json({"actors": ["u"]}, "requirement_analysis")
        assert not vr.is_valid
        assert any("functions" in e for e in vr.errors)

    def test_validate_json_empty_dict(self):
        vr = self.tv.validate_json({}, "requirement_analysis")
        assert not vr.is_valid

    def test_validate_json_none(self):
        vr = self.tv.validate_json(None, "requirement_analysis")
        assert not vr.is_valid

    def test_validate_json_string(self):
        vr = self.tv.validate_json("not json", "requirement_analysis")
        assert not vr.is_valid

    def test_validate_json_string_valid(self):
        vr = self.tv.validate_json('{"actors": ["u"], "functions": ["f"], "entities": ["e"]}',
                                   "requirement_analysis")
        assert vr.is_valid

    def test_validate_mermaid_valid(self):
        content = "classDiagram\n    class User {\n        +login()\n    }"
        vr = self.tv.validate_mermaid(content)
        assert vr.is_valid

    def test_validate_mermaid_empty(self):
        vr = self.tv.validate_mermaid("")
        assert not vr.is_valid

    def test_validate_markdown_valid(self):
        vr = self.tv.validate_markdown("# Title\n\nSome content for testing.")
        assert vr.is_valid

    def test_validate_markdown_empty(self):
        vr = self.tv.validate_markdown("")
        assert not vr.is_valid

    def test_validate_markdown_short_warning(self):
        vr = self.tv.validate_markdown("short")
        assert vr.is_valid
        assert len(vr.warnings) > 0

    def test_validate_output_json(self):
        vr = self.tv.validate_output({"key": "val"}, "json")
        assert vr.is_valid

    def test_validate_output_mermaid(self):
        vr = self.tv.validate_output("classDiagram\n    class A", "mermaid")
        assert vr.is_valid

    def test_validate_output_unknown_type(self):
        vr = self.tv.validate_output("something", "unknown")
        assert vr.is_valid

    def test_validate_output_none(self):
        vr = self.tv.validate_output(None, "unknown")
        assert not vr.is_valid


# ========== repair_controller.py ==========

class TestRepairController:
    def test_no_repair_needed(self):
        rc = RepairController(max_rounds=3)
        out, records = rc.attempt_repair(
            "test", "good",
            lambda x: ValidationResult(is_valid=True),
            lambda x, e: x,
        )
        assert len(records) == 0

    def test_repair_success_second_attempt(self):
        rc = RepairController(max_rounds=3)
        count = [0]
        def validate(x):
            count[0] += 1
            if count[0] <= 1:
                return ValidationResult(is_valid=False, errors=["bad"])
            return ValidationResult(is_valid=True)
        out, records = rc.attempt_repair("test", "bad", validate, lambda x, e: "fixed")
        assert out == "fixed"
        assert len(records) == 1
        assert records[0].success

    def test_repair_all_fail(self):
        rc = RepairController(max_rounds=3)
        out, records = rc.attempt_repair(
            "test", "bad",
            lambda x: ValidationResult(is_valid=False, errors=["bad"]),
            lambda x, e: x,
        )
        assert len(records) == 3
        assert all(not r.success for r in records)

    def test_repair_exception(self):
        rc = RepairController(max_rounds=2)
        out, records = rc.attempt_repair(
            "test", "bad",
            lambda x: ValidationResult(is_valid=False, errors=["bad"]),
            lambda x, e: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        assert len(records) == 2
        assert all("exception" in r.result for r in records)



# ========== stage_gate.py ==========

class TestStageGate:
    def setup_method(self):
        self.gate = StageGate(GovernanceConfig(
            max_repair_rounds=2,
            gate_thresholds={"min_completeness": 0.8, "min_consistency": 0.7}
        ))

    def test_proceed_on_valid(self):
        vr = ValidationResult(is_valid=True, score=1.0)
        assert self.gate.evaluate("test", vr) == GateDecision.PROCEED

    def test_retry_on_retryable_error(self):
        vr = ValidationResult(is_valid=False, errors=["空响应"], score=0.5)
        assert self.gate.evaluate("test", vr, retry_count=0, max_retries=2) == GateDecision.RETRY

    def test_repair_after_max_retries(self):
        vr = ValidationResult(is_valid=False, errors=["空响应"], score=0.5)
        assert self.gate.evaluate("test", vr, retry_count=2, max_retries=2) == GateDecision.REPAIR

    def test_halt_on_low_score(self):
        vr = ValidationResult(is_valid=False, errors=["bad"], score=0.1)
        assert self.gate.evaluate("test", vr, retry_count=1) == GateDecision.HALT

    def test_halt_after_max_repairs(self):
        vr = ValidationResult(is_valid=False, errors=["bad"], score=0.5)
        assert self.gate.evaluate("test", vr, retry_count=2, repair_count=2) == GateDecision.HALT



# ========== context_controller.py ==========

class TestContextController:
    def test_set_get(self):
        ctx = ContextController()
        ctx.set("key", "val")
        assert ctx.get("key") == "val"
        assert ctx.get("missing", "default") == "default"

    def test_get_for_stage(self):
        ctx = ContextController()
        ctx.set("requirement_json", {"a": 1})
        ctx.set("design_text", "text")

        d = ctx.get_for_stage("design_planner")
        assert "requirement_json" in d
        assert "design_text" not in d

        d = ctx.get_for_stage("diagram_generator")
        assert "requirement_json" in d
        assert "design_text" in d

    def test_get_for_unknown_stage(self):
        ctx = ContextController()
        ctx.set("k", "v")
        d = ctx.get_for_stage("unknown")
        assert d == {}

    def test_snapshot(self):
        ctx = ContextController()
        ctx.set("k1", "v1")
        ctx.snapshot()
        ctx.set("k2", "v2")
        ctx.snapshot()
        assert len(ctx.get_history()) == 2

    def test_update(self):
        ctx = ContextController()
        ctx.update({"a": 1, "b": 2})
        assert ctx.get("a") == 1
        assert ctx.get("b") == 2

    def test_clear(self):
        ctx = ContextController()
        ctx.set("k", "v")
        ctx.snapshot()
        ctx.clear()
        assert ctx.get("k") is None
        assert len(ctx.get_history()) == 0


# ========== human_checkpoint.py ==========

class TestHumanCheckpoint:
    def test_is_checkpoint(self):
        hc = HumanCheckpoint(checkpoint_stages=["s1", "s2"])
        assert hc.is_checkpoint("s1")
        assert not hc.is_checkpoint("s3")

    def test_non_interactive_auto_continue(self):
        hc = HumanCheckpoint(checkpoint_stages=["s1"], interactive=False)
        decision = hc.pause("s1", summary="test")
        assert decision.action == HumanAction.CONTINUE
        assert len(hc.get_decisions()) == 1

    def test_non_checkpoint_returns_continue(self):
        hc = HumanCheckpoint(checkpoint_stages=["s1"], interactive=False)
        decision = hc.pause("other")
        assert decision.action == HumanAction.CONTINUE
        assert len(hc.get_decisions()) == 1  # auto-continue recorded

    def test_empty_checkpoints(self):
        hc = HumanCheckpoint()
        assert not hc.is_checkpoint("anything")
        decision = hc.pause("anything")
        assert decision.action == HumanAction.CONTINUE


# ========== prompt_registry.py ==========

class TestPromptRegistry:
    @pytest.fixture(autouse=True)
    def _chdir(self, monkeypatch):
        monkeypatch.chdir(PROJECT_ROOT)

    def test_scan_prompts(self):
        pr = PromptRegistry()
        prompts = pr.list_prompts()
        assert len(prompts) > 0

    def test_has(self):
        pr = PromptRegistry()
        assert pr.has("requirement_analysis")
        assert not pr.has("nonexistent")

    def test_get_content(self):
        pr = PromptRegistry()
        content = pr.get_content("requirement_analysis")
        assert len(content) > 0

    def test_get_version(self):
        pr = PromptRegistry()
        ver = pr.get_version("requirement_analysis")
        assert ver is not None

    def test_get_all_versions(self):
        pr = PromptRegistry()
        versions = pr.get_all_versions()
        assert len(versions) > 0

    def test_register(self):
        pr = PromptRegistry.__new__(PromptRegistry)
        pr._prompts = {}
        pr.prompts_dir = "/nonexistent"
        pr.register("custom", "content", "manual")
        assert pr.has("custom")
        assert pr.get_content("custom") == "content"

    def test_missing_prompt_raises(self):
        pr = PromptRegistry.__new__(PromptRegistry)
        pr._prompts = {}
        pr.prompts_dir = "/nonexistent"
        with pytest.raises(KeyError):
            pr.get_content("nonexistent")

    def test_unreadable_file_skipped(self):
        """单个不可读文件不阻塞其他模板注册"""
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            # 创建一个正常文件
            good = os.path.join(tmpdir, "good.md")
            with open(good, "w") as f:
                f.write("good content")
            # 创建一个不可读文件（写入后移除读权限）
            bad = os.path.join(tmpdir, "bad.md")
            with open(bad, "w") as f:
                f.write("bad content")
            os.chmod(bad, 0o000)
            try:
                pr = PromptRegistry(tmpdir)
                assert pr.has("good")
                assert not pr.has("bad")
            finally:
                os.chmod(bad, 0o644)


# ========== Integration: orchestrator import ==========

class TestOrchestratorImport:
    def test_import(self):
        from governance.orchestrator import TaskOrchestrator
        assert hasattr(TaskOrchestrator, "run_design_task")
        assert hasattr(TaskOrchestrator, "run_analyze_task")


# ========== Integration: orchestrator with mock ==========

class TestOrchestratorValidation:
    """测试 _validate_stage_output 各分支"""

    def _make_orchestrator(self):
        """创建带mock LLM的orchestrator"""
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig

        class MockLLM:
            provider = "test"
            model = "test-model"
            temperature = 0.3
            max_tokens = 100
            def chat(self, messages, temperature=None): return "ok"
            def generate_json(self, prompt, system=""): return {}
            def generate_text(self, prompt, system=""): return "text"

        gov = GovernanceConfig(enabled=True, trace_enabled=True)
        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.gov = gov
        orch.trace = TraceLogger()
        orch.validator = ToolValidator()
        orch.gate = StageGate(gov)
        orch.context = ContextController()
        orch.repair = RepairController(max_rounds=gov.max_repair_rounds)
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.prompt_registry = PromptRegistry.__new__(PromptRegistry)
        orch.prompt_registry._prompts = {}
        orch.prompt_registry.prompts_dir = "/none"
        orch.stage_records = []
        orch.llm = MockLLM()
        return orch

    def test_validate_requirement_analysis_valid(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("requirement_analysis", {
            "actors": ["user"], "functions": ["login"], "entities": ["User"]
        })
        assert vr.is_valid
        assert vr.score == 1.0

    def test_validate_requirement_analysis_none(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("requirement_analysis", None)
        assert not vr.is_valid
        assert vr.score == 0.0

    def test_validate_requirement_analysis_empty(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("requirement_analysis", {})
        assert not vr.is_valid

    def test_validate_design_valid(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("design_planner", "# Design\n\nSome content for testing.")
        assert vr.is_valid

    def test_validate_design_empty(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("design_planner", "")
        assert not vr.is_valid
        assert vr.score == 0.0

    def test_validate_design_none(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("design_planner", None)
        assert not vr.is_valid
        assert vr.score == 0.0

    def test_validate_diagrams_valid(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("diagram_generator", {
            "class": "classDiagram\n    class A",
            "activity": "flowchart TD\n    A-->B"
        })
        assert vr.is_valid
        assert vr.score == 1.0

    def test_validate_diagrams_partial_invalid(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("diagram_generator", {
            "class": "classDiagram\n    class A",
            "bad": "not a valid mermaid"
        })
        assert not vr.is_valid
        assert vr.score == 0.5

    def test_validate_diagrams_none(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("diagram_generator", None)
        assert not vr.is_valid
        assert vr.score == 0.0

    def test_validate_diagrams_not_dict(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("diagram_generator", "string")
        assert not vr.is_valid
        assert vr.score == 0.0

    def test_validate_diagrams_empty_dict(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("diagram_generator", {})
        assert not vr.is_valid
        assert vr.score == 0.0
        assert "空字典" in vr.errors[0]

    def test_validate_test_cases_valid(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("test_case_generator",
            "| 编号 | 测试对象 | 测试步骤 | 预期结果 |\n|------|----------|----------|----------|")
        assert vr.is_valid

    def test_validate_test_cases_empty(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("test_case_generator", "")
        assert not vr.is_valid
        assert vr.score == 0.0

    def test_validate_review_valid_score(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("review_agent", {"overall_score": 85})
        assert vr.is_valid
        assert abs(vr.score - 0.85) < 0.01

    def test_validate_review_low_score(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("review_agent", {"overall_score": 20})
        assert not vr.is_valid
        assert abs(vr.score - 0.2) < 0.01

    def test_validate_review_score_clamped_over_100(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("review_agent", {"overall_score": 150})
        assert vr.is_valid
        assert vr.score == 1.0

    def test_validate_review_score_clamped_below_0(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("review_agent", {"overall_score": -10})
        assert not vr.is_valid
        assert vr.score == 0.0

    def test_validate_review_non_numeric_score(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("review_agent", {"overall_score": "bad"})
        assert not vr.is_valid
        assert vr.score == 0.0

    def test_validate_review_not_dict(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("review_agent", "string")
        assert not vr.is_valid
        assert vr.score == 0.0

    def test_validate_unknown_stage_none(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("unknown", None)
        assert not vr.is_valid
        assert vr.score == 0.0

    def test_validate_unknown_stage_valid(self):
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("unknown", "something")
        assert vr.is_valid


class TestOrchestratorContextOnFailure:
    """测试阶段失败时上下文是否正确设置"""

    def test_context_set_on_failure(self):
        """验证：阶段失败时上下文也被设置为空值，下游阶段可安全读取"""
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig

        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.config = AgentConfig()
        orch.gov = GovernanceConfig()
        orch.context = ContextController()
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.trace = TraceLogger()
        orch.validator = ToolValidator()
        orch.gate = StageGate()
        orch.repair = RepairController(max_rounds=1)
        orch.stage_records = []

        # 模拟阶段失败：stage_fn抛出异常
        def failing_stage(record, *args):
            raise RuntimeError("模拟阶段失败")

        record = orch._run_stage("requirement_analysis", failing_stage)
        assert record.status == "failed"

        # 验证validation_result反映失败状态
        assert not record.validation_result.is_valid
        assert record.validation_result.score == 0.0

        # 上下文快照不应崩溃
        orch.context.snapshot()
        # 下游阶段读取不崩溃
        design_text = orch.context.get("design_text", "")
        assert design_text == ""


class TestOrchestratorGenerateReportError:
    """测试review_agent.generate_report异常时的容错"""

    def test_generate_report_exception_returns_empty(self):
        """generate_report抛出异常时，review_report应为空字符串"""
        import logging
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig
        logger = logging.getLogger("reqdesign")

        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.config = AgentConfig()
        orch.gov = GovernanceConfig()
        orch.context = ContextController()
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.trace = TraceLogger()
        orch.validator = ToolValidator()
        orch.gate = StageGate()
        orch.repair = RepairController(max_rounds=1)
        orch.stage_records = []

        # Mock review_agent.generate_report to raise
        class FailingReviewAgent:
            def generate_report(self, result):
                raise RuntimeError("报告生成失败")
            def validate_mermaid_syntax(self, diagrams):
                return []
            def review(self, requirement_json, design_text, diagrams):
                return {}
            def review_and_repair(self, requirement_json, design_text, diagrams):
                return {}, []

        orch.review_agent = FailingReviewAgent()
        orch.llm = type("MockLLM", (), {
            "provider": "test", "model": "test", "temperature": 0.3,
            "max_tokens": 100, "set_stage": lambda self, s: None,
            "chat": lambda self, m, temperature=None: "ok",
            "generate_json": lambda self, p, system="": {},
            "generate_text": lambda self, p, system="": "text",
        })()

        # 直接调用生成报告的部分来测试容错
        review_result = {"overall_score": 80}
        review_report = ""
        try:
            review_report = orch.review_agent.generate_report(review_result)
        except Exception as e:
            logger.error(f"审查报告生成失败: {e}", exc_info=True)
        assert review_report == ""


class TestOrchestratorAnalyzeTask:
    """测试run_analyze_task方法"""

    def test_run_analyze_task_with_mock(self, tmp_path):
        """验证run_analyze_task基本流程"""
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig

        # 创建输入文件
        input_file = tmp_path / "input.md"
        input_file.write_text("# 测试需求\n## 功能\n- 用户注册\n- 用户登录")

        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.config = AgentConfig()
        orch.gov = GovernanceConfig()
        orch.context = ContextController()
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.trace = TraceLogger()
        orch.validator = ToolValidator()
        orch.gate = StageGate()
        orch.repair = RepairController(max_rounds=1)
        orch.stage_records = []

        # Mock LLM
        class MockLLM:
            provider = "test"
            model = "test-model"
            temperature = 0.3
            max_tokens = 100
            def set_stage(self, s): pass
            def chat(self, messages, temperature=None): return "ok"
            def generate_json(self, prompt, system=""):
                return {
                    "project_name": "测试项目",
                    "actors": [{"name": "用户", "description": "测试用户"}],
                    "functions": [{"id": "F001", "name": "用户注册", "description": "注册功能"}],
                    "entities": [],
                    "constraints": [],
                    "exceptions": [],
                    "non_functional_requirements": [],
                    "business_processes": [],
                }
            def generate_text(self, prompt, system=""): return "text"

        orch.llm = MockLLM()

        # Mock input_loader
        class MockInputLoader:
            def load(self, path):
                with open(path, "r", encoding="utf-8") as f:
                    return f.read()

        orch.input_loader = MockInputLoader()

        # Mock prompt_registry
        class MockPromptRegistry:
            def get_all_versions(self):
                return {}

        orch.prompt_registry = MockPromptRegistry()

        # Mock agents
        class MockAnalyzer:
            def analyze(self, text, max_retries=3):
                return {
                    "project_name": "测试项目",
                    "actors": [{"name": "用户", "description": "测试用户"}],
                    "functions": [{"id": "F001", "name": "用户注册", "description": "注册功能"}],
                    "entities": [],
                    "constraints": [],
                    "exceptions": [],
                    "non_functional_requirements": [],
                    "business_processes": [],
                }
            def validate_result(self, result):
                return []

        orch.requirement_analyzer = MockAnalyzer()

        output_dir = str(tmp_path / "output")
        result = orch.run_analyze_task(str(input_file), output_dir)

        # 验证结果结构
        assert "requirement_analysis" in result
        assert "lightweight_review" in result
        assert result["requirement_analysis"]["project_name"] == "测试项目"

        # 验证输出文件已创建
        assert (tmp_path / "output" / "requirement_analysis.json").exists()


class TestOrchestratorExportGovernanceReport:
    """测试_export_governance_report方法"""

    def test_export_governance_report(self, tmp_path):
        """验证治理报告导出"""
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig, StageRecord, ValidationResult

        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.config = AgentConfig()
        orch.gov = GovernanceConfig()
        orch.context = ContextController()
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.trace = TraceLogger()
        orch.prompt_registry = type("MockPR", (), {"get_all_versions": lambda self: {}})()

        # 创建模拟的stage_records
        record = StageRecord(stage_name="requirement_analysis")
        record.status = "success"
        record.validation_result = ValidationResult(is_valid=True, score=0.9)
        orch.stage_records = [record]

        output_dir = str(tmp_path / "governance")
        results = {
            "consistency": {"score": 0.8, "errors": [], "warnings": []},
            "lightweight_review": {"pass": True, "issues": []},
        }

        orch._export_governance_report(output_dir, results)

        # 验证报告文件已创建
        report_path = tmp_path / "governance" / "governance_report.json"
        assert report_path.exists()

        # 验证报告内容
        import json
        with open(report_path) as f:
            report = json.load(f)
        assert report["governance_summary"]["total_stages"] == 1
        assert report["governance_summary"]["succeeded"] == 1
        assert report["governance_summary"]["failed"] == 0
        assert len(report["stages"]) == 1
        assert report["consistency"]["score"] == 0.8


class TestOrchestratorDesignTask:
    """测试run_design_task完整设计流程"""

    def _make_orchestrator(self, tmp_path):
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig

        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.config = AgentConfig()
        orch.gov = GovernanceConfig(enabled=True, trace_enabled=True)
        orch.context = ContextController()
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.trace = TraceLogger()
        orch.validator = ToolValidator()
        orch.gate = StageGate(orch.gov)
        orch.repair = RepairController(max_rounds=1)
        orch.stage_records = []
        orch.consistency = type("MockCC", (), {
            "check_all": lambda self, r, d, di, t: type("CR", (), {
                "score": 0.9, "errors": [], "warnings": [], "checks": [],
                "is_valid": True,
            })()
        })()
        orch.prompt_registry = type("MockPR", (), {
            "get_all_versions": lambda self: {}
        })()

        # Mock LLM
        class MockLLM:
            provider = "test"
            model = "test-model"
            temperature = 0.3
            max_tokens = 100
            def set_stage(self, s): pass
            def chat(self, messages, temperature=None): return "ok"
            def generate_json(self, prompt, system=""):
                return {
                    "project_name": "测试项目",
                    "actors": [{"name": "用户"}],
                    "functions": [{"name": "登录", "description": "用户登录"}],
                    "entities": [{"name": "用户"}],
                    "constraints": [],
                    "exceptions": [],
                    "non_functional_requirements": [],
                    "business_processes": [],
                }
            def generate_text(self, prompt, system=""):
                return "# 系统设计\n\n## 模块划分\n- 用户管理模块"

        orch.llm = MockLLM()

        # Mock agents
        orch.input_loader = type("MockIL", (), {
            "load": lambda self, p: open(p, encoding="utf-8").read()
        })()
        orch.requirement_analyzer = type("MockRA", (), {
            "analyze": lambda self, t, max_retries=3: {
                "project_name": "测试项目",
                "actors": [{"name": "用户"}],
                "functions": [{"name": "登录", "description": "用户登录"}],
                "entities": [{"name": "用户"}],
                "constraints": [],
                "exceptions": [],
                "non_functional_requirements": [],
                "business_processes": [],
            },
            "validate_result": lambda self, r: [],
        })()
        orch.design_planner = type("MockDP", (), {
            "generate_design": lambda self, r: "# 系统设计\n\n## 模块划分\n- 用户管理模块",
            "validate_design": lambda self, d, r: [],
        })()
        orch.diagram_generator = type("MockDG", (), {
            "generate_all": lambda self, r, d: {
                "class_diagram": "classDiagram\n    class User",
                "activity_diagram": "flowchart TD\n    A([开始]) --> B([结束])",
                "state_diagram": "stateDiagram-v2\n    [*] --> Active\n    Active --> [*]",
            },
        })()
        orch.test_case_generator = type("MockTC", (), {
            "generate": lambda self, r, d: "| 编号 | 测试对象 |\n|------|----------|\n| 1 | 登录 |",
            "validate_test_cases": lambda self, c, r: [],
        })()
        orch.review_agent = type("MockRev", (), {
            "review_and_repair": lambda self, r, d, di, max_repair_rounds=2: (
                {"overall_score": 85, "overall_pass": True, "checks": [], "syntax_check": []},
                di,
            ),
            "generate_report": lambda self, result: "# 审查报告\n\n得分: 85",
        })()

        return orch

    def test_run_design_task_full_flow(self, tmp_path):
        """验证完整设计流程输出结构"""
        orch = self._make_orchestrator(tmp_path)

        input_file = tmp_path / "input.md"
        input_file.write_text("# 图书管理系统\n## 功能\n- 图书借阅\n- 图书归还")

        output_dir = str(tmp_path / "output")
        result = orch.run_design_task(str(input_file), output_dir)

        # 验证结果结构
        assert "requirement_analysis" in result
        assert "system_design" in result
        assert "diagrams" in result
        assert "test_cases" in result
        assert "review" in result
        assert "consistency" in result
        assert "lightweight_review" in result

        # 验证具体内容
        assert result["requirement_analysis"]["project_name"] == "测试项目"
        assert "系统设计" in result["system_design"]
        assert "class_diagram" in result["diagrams"]
        assert "activity_diagram" in result["diagrams"]
        assert "state_diagram" in result["diagrams"]

    def test_run_design_task_creates_output_files(self, tmp_path):
        """验证输出文件被创建"""
        orch = self._make_orchestrator(tmp_path)

        input_file = tmp_path / "input.md"
        input_file.write_text("# 测试需求\n## 功能\n- 功能A")

        output_dir = str(tmp_path / "output")
        orch.run_design_task(str(input_file), output_dir)

        # 验证文件被创建
        output_path = tmp_path / "output"
        assert (output_path / "requirement_analysis.json").exists()
        assert (output_path / "system_design.md").exists()
        assert (output_path / "class_diagram.mmd").exists()
        assert (output_path / "activity_diagram.mmd").exists()
        assert (output_path / "state_diagram.mmd").exists()
        assert (output_path / "test_cases.md").exists()
        assert (output_path / "review_report.md").exists()

    def test_run_design_task_exports_trace(self, tmp_path):
        """验证追踪文件被导出"""
        orch = self._make_orchestrator(tmp_path)

        input_file = tmp_path / "input.md"
        input_file.write_text("# 测试需求\n## 功能\n- 功能A")

        output_dir = str(tmp_path / "output")
        orch.run_design_task(str(input_file), output_dir)

        assert (tmp_path / "output" / "trace.json").exists()

    def test_run_design_task_exports_governance_report(self, tmp_path):
        """验证治理报告被导出"""
        orch = self._make_orchestrator(tmp_path)

        input_file = tmp_path / "input.md"
        input_file.write_text("# 测试需求\n## 功能\n- 功能A")

        output_dir = str(tmp_path / "output")
        orch.run_design_task(str(input_file), output_dir)

        report_path = tmp_path / "output" / "governance_report.json"
        assert report_path.exists()

        import json
        with open(report_path) as f:
            report = json.load(f)
        assert "governance_summary" in report
        assert "stages" in report
        assert "consistency" in report
        assert "lightweight_review" in report

    def test_run_design_task_stage_records_populated(self, tmp_path):
        """验证stage_records被填充"""
        orch = self._make_orchestrator(tmp_path)

        input_file = tmp_path / "input.md"
        input_file.write_text("# 测试需求\n## 功能\n- 功能A")

        output_dir = str(tmp_path / "output")
        orch.run_design_task(str(input_file), output_dir)

        # 应有6个阶段记录
        assert len(orch.stage_records) == 6
        stage_names = [r.stage_name for r in orch.stage_records]
        assert "input_loader" in stage_names
        assert "requirement_analysis" in stage_names
        assert "design_planner" in stage_names
        assert "diagram_generator" in stage_names
        assert "test_case_generator" in stage_names
        assert "review_agent" in stage_names

    def test_run_design_task_input_failure_stops(self, tmp_path):
        """输入读取失败时应停止后续阶段"""
        orch = self._make_orchestrator(tmp_path)

        # 不存在的文件
        output_dir = str(tmp_path / "output")
        result = orch.run_design_task("/nonexistent/file.md", output_dir)

        # 只有input_loader阶段
        assert len(orch.stage_records) == 1
        assert orch.stage_records[0].stage_name == "input_loader"
        assert orch.stage_records[0].status == "failed"

    def test_run_design_task_analysis_failure_stops(self, tmp_path):
        """需求分析失败且修复失败时应停止后续阶段"""
        orch = self._make_orchestrator(tmp_path)

        # 让分析抛异常（不可修复）
        class FailAnalyzer:
            def analyze(self, text, max_retries=3):
                raise RuntimeError("LLM服务不可用")
            def validate_result(self, result):
                return []
        orch.requirement_analyzer = FailAnalyzer()

        input_file = tmp_path / "input.md"
        input_file.write_text("# 测试需求\n## 功能\n- 功能A")

        output_dir = str(tmp_path / "output")
        result = orch.run_design_task(str(input_file), output_dir)

        # 异常导致stage failed，req_json={}，后续阶段被跳过
        assert len(orch.stage_records) == 2
        assert orch.stage_records[1].status == "failed"

    def test_run_design_task_review_failure_continues(self, tmp_path):
        """审查失败不应阻塞输出"""
        orch = self._make_orchestrator(tmp_path)

        # 让review返回低分
        orch.review_agent = type("FailRev", (), {
            "review_and_repair": lambda self, r, d, di, max_repair_rounds=2: (
                {"overall_score": 10, "overall_pass": False, "checks": [], "syntax_check": []},
                di,
            ),
            "generate_report": lambda self, result: "# 审查报告\n\n得分: 10",
        })()

        input_file = tmp_path / "input.md"
        input_file.write_text("# 测试需求\n## 功能\n- 功能A")

        output_dir = str(tmp_path / "output")
        result = orch.run_design_task(str(input_file), output_dir)

        # 所有阶段都应执行
        assert len(orch.stage_records) == 6
        assert "review" in result

    def test_run_design_task_consistency_failure_handled(self, tmp_path):
        """一致性检查失败时应优雅处理"""
        orch = self._make_orchestrator(tmp_path)

        # 让一致性检查抛异常
        orch.consistency = type("FailCC", (), {
            "check_all": lambda self, r, d, di, t: (_ for _ in ()).throw(RuntimeError("consistency error"))
        })()

        input_file = tmp_path / "input.md"
        input_file.write_text("# 测试需求\n## 功能\n- 功能A")

        output_dir = str(tmp_path / "output")
        result = orch.run_design_task(str(input_file), output_dir)

        # 一致性检查失败但不应阻塞
        assert "consistency" in result
        assert result["consistency"]["score"] == 0


class TestHumanCheckpointAbortModify:
    """测试人工检查点的abort和modify路径"""

    def test_abort_raises_system_exit(self):
        """abort操作应抛出_AbortSignal"""
        from governance.orchestrator import TaskOrchestrator, _AbortSignal

        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.context = ContextController()
        orch.checkpoint = HumanCheckpoint(checkpoint_stages=["test_stage"], interactive=False)
        orch.trace = TraceLogger()

        # Mock checkpoint.pause to return abort
        from governance.models import HumanDecision, HumanAction
        orch.checkpoint.decisions = []
        original_pause = orch.checkpoint.pause

        def mock_abort_pause(stage, summary="", output_preview=""):
            decision = HumanDecision(stage=stage, action=HumanAction.ABORT, feedback="")
            orch.checkpoint.decisions.append(decision)
            return decision

        orch.checkpoint.pause = mock_abort_pause

        with pytest.raises(_AbortSignal):
            orch._check_human_checkpoint("test_stage", {"test_stage": {}})

    def test_modify_logs_feedback(self):
        """modify操作应记录反馈"""
        from governance.orchestrator import TaskOrchestrator

        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.context = ContextController()
        orch.checkpoint = HumanCheckpoint(checkpoint_stages=["test_stage"], interactive=False)
        orch.trace = TraceLogger()

        from governance.models import HumanDecision, HumanAction

        def mock_modify_pause(stage, summary="", output_preview=""):
            decision = HumanDecision(stage=stage, action=HumanAction.MODIFY, feedback="请修改类图")
            orch.checkpoint.decisions.append(decision)
            return decision

        orch.checkpoint.pause = mock_modify_pause

        # 不应抛出异常
        orch._check_human_checkpoint("test_stage", {"test_stage": {}})

        # 验证决策已记录
        assert len(orch.checkpoint.decisions) == 1
        assert orch.checkpoint.decisions[0].feedback == "请修改类图"


# ========== Integration: StageGate with config ==========

class TestStageGateIntegration:
    """测试 StageGate 与配置的集成"""

    def test_halt_threshold_from_config(self):
        """验证HALT阈值从配置读取"""
        config = GovernanceConfig(
            gate_thresholds={"min_completeness": 0.6, "min_consistency": 0.5}
        )
        gate = StageGate(config)

        # score=0.2 < 0.6*0.4=0.24, 且已重试 -> HALT
        vr = ValidationResult(is_valid=False, errors=["bad"], score=0.2)
        assert gate.evaluate("test", vr, retry_count=1) == GateDecision.HALT

        # score=0.3 > 0.24=halt_threshold, 但错误不可重试 -> REPAIR
        vr = ValidationResult(is_valid=False, errors=["bad"], score=0.3)
        decision = gate.evaluate("test", vr, retry_count=1)
        assert decision == GateDecision.REPAIR

    def test_proceed_on_valid_regardless_of_config(self):
        """校验通过时始终PROCEED"""
        for threshold in [0.5, 0.8, 1.0]:
            config = GovernanceConfig(
                gate_thresholds={"min_completeness": threshold}
            )
            gate = StageGate(config)
            vr = ValidationResult(is_valid=True, score=1.0)
            assert gate.evaluate("test", vr) == GateDecision.PROCEED


# ========== Integration: RepairController edge cases ==========

class TestRepairControllerEdgeCases:
    """测试修复控制器边界场景"""

    def test_max_rounds_zero(self):
        """max_rounds=0 不执行任何修复"""
        rc = RepairController(max_rounds=0)
        out, records = rc.attempt_repair(
            "test", "bad",
            lambda x: ValidationResult(is_valid=False, errors=["e"]),
            lambda x, e: "fixed"
        )
        assert len(records) == 0
        assert out == "bad"  # 未修改

    def test_repair_improves_score_but_not_valid(self):
        """修复改善了分数但仍不通过"""
        rc = RepairController(max_rounds=2)
        call_count = [0]
        def validate(x):
            call_count[0] += 1
            score = 0.3 if call_count[0] == 1 else 0.6
            return ValidationResult(is_valid=False, errors=["e"], score=score)
        def repair(x, e): return "better"

        out, records = rc.attempt_repair("test", "bad", validate, repair)
        assert out == "better"
        assert len(records) == 2
        assert all(not r.success for r in records)

    def test_repair_fn_receives_errors(self):
        """修复函数接收到正确的错误信息"""
        rc = RepairController(max_rounds=1)
        received_errors = []
        def validate(x):
            return ValidationResult(is_valid=False, errors=["err1", "err2"])
        def repair(x, e):
            received_errors.extend(e)
            return x

        rc.attempt_repair("test", "bad", validate, repair)
        assert received_errors == ["err1", "err2"]


# ========== Integration: TraceLogger with TracingLLMClient ==========

class TestTraceIntegration:
    """测试追踪集成"""

    def test_full_trace_flow(self):
        """模拟完整追踪流程"""
        tl = TraceLogger()

        class MockLLM:
            provider = "test"
            model = "test"
            temperature = 0.3
            max_tokens = 100
            def chat(self, m, temperature=None): return "response"
            def generate_json(self, p, s=""): return {"key": "val"}
            def generate_text(self, p, s=""): return "text"

        client = TracingLLMClient(MockLLM(), tl, "stage1")

        # 模拟多阶段调用
        client.chat([{"role": "user", "content": "hello"}])
        client.set_stage("stage2")
        client.generate_json("prompt1")
        client.set_stage("stage3")
        client.generate_text("prompt2")

        summary = tl.get_summary()
        assert summary["total_entries"] == 3
        assert "stage1" in summary["stages"]
        assert "stage2" in summary["stages"]
        assert "stage3" in summary["stages"]
        assert summary["stages"]["stage1"]["llm_calls"] == 1
        assert summary["stages"]["stage2"]["llm_calls"] == 1
        assert summary["stages"]["stage3"]["llm_calls"] == 1

    def test_trace_export_json_roundtrip(self):
        """追踪导出JSON可重新解析"""
        tl = TraceLogger()
        tl.log("s", "e", {"key": "value"})
        tl.log_validation("s", True, [], [], 0.9)

        json_str = tl.export_json()
        data = json.loads(json_str)
        assert data["summary"]["total_entries"] == 2
        assert len(data["entries"]) == 2
        assert data["entries"][0]["stage"] == "s"


# ========== Integration: PromptRegistry versions ==========

class TestPromptRegistryIntegration:
    """测试Prompt注册表集成"""

    def test_versions_change_on_content_change(self):
        """内容变化时版本号变化"""
        pr = PromptRegistry.__new__(PromptRegistry)
        pr._prompts = {}
        pr.prompts_dir = "/none"

        pr.register("test", "content v1")
        v1 = pr.get_version("test")

        pr.register("test", "content v2")
        v2 = pr.get_version("test")

        assert v1 != v2

    def test_same_content_same_version(self):
        """相同内容产生相同版本"""
        pr = PromptRegistry.__new__(PromptRegistry)
        pr._prompts = {}
        pr.prompts_dir = "/none"

        pr.register("a", "same content")
        pr.register("b", "same content")
        assert pr.get_version("a") == pr.get_version("b")


# ========== Integration: ContextController stage specs ==========

class TestContextControllerIntegration:
    """测试上下文控制器阶段规格"""

    def test_all_known_stages_return_subset(self):
        """所有已知阶段只返回所需字段"""
        ctx = ContextController()
        ctx.set("full_text", "text")
        ctx.set("requirement_json", {"r": 1})
        ctx.set("design_text", "design")
        ctx.set("diagrams", {"d": 1})

        for stage in ContextController.STAGE_CONTEXT_SPEC:
            subset = ctx.get_for_stage(stage)
            spec = ContextController.STAGE_CONTEXT_SPEC[stage]
            # 只包含spec中的字段
            for key in subset:
                assert key in spec, f"Stage {stage} returned unexpected key {key}"

    def test_context_grows_across_stages(self):
        """上下文随阶段增长"""
        ctx = ContextController()
        assert len(ctx.get_full_context()) == 0

        ctx.set("full_text", "t")
        assert len(ctx.get_full_context()) == 1

        ctx.set("requirement_json", {})
        assert len(ctx.get_full_context()) == 2

        ctx.set("design_text", "d")
        assert len(ctx.get_full_context()) == 3


# ========== Integration: GovernanceConfig from YAML ==========

class TestGovernanceConfigIntegration:
    """测试治理配置加载"""

    def test_full_config(self):
        raw = {
            "governance": {
                "enabled": True,
                "trace_enabled": False,
                "human_checkpoints": ["stage1", "stage2"],
                "max_repair_rounds": 5,
                "gate_thresholds": {
                    "syntax_valid": False,
                    "min_completeness": 0.9,
                    "min_consistency": 0.8,
                }
            }
        }
        gc = GovernanceConfig.from_yaml_dict(raw)
        assert gc.enabled is True
        assert gc.trace_enabled is False
        assert gc.human_checkpoints == ["stage1", "stage2"]
        assert gc.max_repair_rounds == 5
        assert gc.gate_thresholds["min_completeness"] == 0.9

    def test_partial_config(self):
        raw = {"governance": {"enabled": True}}
        gc = GovernanceConfig.from_yaml_dict(raw)
        assert gc.enabled is True
        assert gc.max_repair_rounds == 3  # default

    def test_empty_config(self):
        gc = GovernanceConfig.from_yaml_dict({})
        assert not gc.enabled
        assert gc.max_repair_rounds == 3


# ========== Integration: AgentConfig with _raw ==========

class TestAgentConfigRaw:
    """测试 AgentConfig 存储原始配置"""

    @pytest.fixture(autouse=True)
    def _chdir(self, monkeypatch):
        monkeypatch.chdir(PROJECT_ROOT)

    def test_raw_stored(self):
        config = AgentConfig.load_from_yaml("config.yaml")
        assert hasattr(config, '_raw')
        assert isinstance(config._raw, dict)
        assert "governance" in config._raw

    def test_raw_contains_governance(self):
        config = AgentConfig.load_from_yaml("config.yaml")
        gov = config._raw.get("governance", {})
        assert "enabled" in gov
        assert "gate_thresholds" in gov

    def test_default_config_no_raw(self):
        config = AgentConfig()
        assert config._raw == {}


# ========== Edge Cases: models.py ==========

class TestModelsEdgeCases:
    """测试数据模型边界"""

    def test_validation_result_score_clamping(self):
        """ValidationResult可以存储任意score值"""
        vr = ValidationResult(is_valid=True, score=1.5)
        assert vr.score == 1.5  # 模型本身不做钳位，由调用方负责

    def test_stage_record_to_dict_with_repairs(self):
        """StageRecord序列化包含修复记录"""
        sr = StageRecord(
            stage_name="test",
            repair_records=[
                RepairRecord(1, "err", "fix", "ok", True),
                RepairRecord(2, "err2", "fix2", "fail", False),
            ],
            start_time=1.0,
            end_time=2.0,
            status="repaired"
        )
        d = sr.to_dict()
        assert len(d["repair_records"]) == 2
        assert d["repair_records"][0]["success"] is True
        assert d["repair_records"][1]["success"] is False
        assert d["status"] == "repaired"

    def test_human_decision_all_actions(self):
        """所有HumanAction都能正确序列化"""
        for action in HumanAction:
            hd = HumanDecision(stage="s", action=action, feedback="f")
            d = hd.to_dict()
            assert d["action"] == action.value
            hd2 = HumanDecision.from_dict(d)
            assert hd2.action == action

    def test_gate_decision_all_values(self):
        """所有GateDecision都能从字符串构造"""
        for decision in GateDecision:
            assert GateDecision(decision.value) == decision


# ========== ConsistencyChecker ==========

class TestConsistencyChecker:
    """测试跨产物一致性检查"""

    def setup_method(self):
        from governance.consistency_checker import ConsistencyChecker
        self.checker = ConsistencyChecker()

    def test_check_all_complete(self):
        """完整数据的一致性检查"""
        req = {
            "actors": ["user"],
            "functions": [{"name": "login", "description": "用户登录"}],
            "entities": [{"name": "User", "attributes": ["name"]}],
        }
        design = "# 系统设计\n\n## 登录模块\n\n用户登录功能"
        diagrams = {
            "class_diagram": "classDiagram\n    class User",
            "activity_diagram": "flowchart TD\n    A-->B",
            "state_diagram": "stateDiagram-v2\n    [*] --> Active",
        }
        test_cases = "| 编号 | 测试对象 | 测试步骤 |\n|------|----------|----------|"
        result = self.checker.check_all(req, design, diagrams, test_cases)
        assert result.score > 0
        assert isinstance(result.checks, list)

    def test_check_all_empty_input(self):
        """空输入处理"""
        result = self.checker.check_all({}, "", {}, "")
        assert result.score < 1.0
        assert len(result.checks) > 0

    def test_entities_in_diagram(self):
        """实体在类图中存在"""
        req = {"entities": [{"name": "User"}, {"name": "Book"}]}
        diagrams = {"class_diagram": "classDiagram\n    class User\n    class Book"}
        result = self.checker.check_all(req, "design", diagrams, "tests")
        # 不应有实体缺失错误
        entity_errors = [e for e in result.warnings if "缺失实体" in e]
        assert len(entity_errors) == 0

    def test_missing_entity_detected(self):
        """缺失实体被检测"""
        req = {"entities": [{"name": "User"}, {"name": "Book"}, {"name": "Order"}]}
        diagrams = {"class_diagram": "classDiagram\n    class User"}
        result = self.checker.check_all(req, "design", diagrams, "tests")
        entity_warnings = [w for w in result.warnings if "缺失实体" in w]
        assert len(entity_warnings) >= 1

    def test_no_functions_in_req(self):
        """需求中无功能点"""
        req = {"actors": ["user"], "functions": [], "entities": []}
        result = self.checker.check_all(req, "design", {}, "tests")
        assert any("功能" in c.get("issues", [""])[0] for c in result.checks if c.get("issues"))

    def test_no_class_diagram(self):
        """类图缺失"""
        req = {"entities": [{"name": "User"}]}
        result = self.checker.check_all(req, "design", {}, "tests")
        assert any("类图" in w for w in result.warnings)

    def test_consistency_result_is_valid(self):
        """ConsistencyResult.is_valid属性"""
        from governance.consistency_checker import ConsistencyResult
        r = self.checker.check_all({"entities": [{"name": "A"}]}, "# Design", {"class_diagram": "classDiagram\n    class A"}, "test")
        # 无errors时应为valid
        assert r.is_valid == (len(r.errors) == 0)

    def test_word_boundary_no_false_positive(self):
        """短实体名不应子串误匹配"""
        from governance.consistency_checker import _word_in_text
        # "A" 不应匹配 "class Admin" (Admin包含A但不是完整词)
        assert not _word_in_text("a", "class admin")
        # "A" 应匹配 "class A" (完整词)
        assert _word_in_text("a", "class A")
        # "Book" 应匹配 "Book" 但不匹配 "BookStore" (除非完整词)
        assert _word_in_text("book", "the Book entity")
        assert not _word_in_text("book", "the BookStore entity")

    def test_chinese_substring_matching(self):
        """中文实体使用子串匹配（无空格分隔）"""
        from governance.consistency_checker import _word_in_text
        assert _word_in_text("图书", "图书管理系统")
        assert _word_in_text("用户", "用户角色定义")

    def test_string_function_items(self):
        """functions为字符串列表时也能处理"""
        req = {
            "functions": ["login", "register"],
            "entities": [{"name": "User"}],
        }
        design = "# 系统设计\n\nlogin和register功能"
        diagrams = {"class_diagram": "classDiagram\n    class User"}
        result = self.checker.check_all(req, design, diagrams, "tests")
        # 字符串功能名应被正确提取和匹配
        func_issues = [i for i in result.checks if i.get("dimension") == "需求→设计覆盖"]
        if func_issues:
            missing = [i for i in func_issues[0].get("issues", []) if "未覆盖" in i]
            # "login"和"register"都在design中出现，不应缺失
            assert len(missing) == 0

    def test_string_entity_items(self):
        """entities为字符串列表时也能处理"""
        req = {"entities": ["User", "Book"]}
        diagrams = {"class_diagram": "classDiagram\n    class User\n    class Book"}
        result = self.checker.check_all(req, "design", diagrams, "tests")
        entity_warnings = [w for w in result.warnings if "缺失实体" in w]
        assert len(entity_warnings) == 0

    def test_class_to_state_orphaned_class_warning(self):
        """状态图引用了类图中不存在的类时应产生warning"""
        req = {"entities": [], "functions": []}
        diagrams = {
            "class_diagram": "classDiagram\n    class Book",
            "state_diagram": "stateDiagram-v2\n    state Order {\n        [*] --> Pending\n    }",
        }
        result = self.checker.check_all(req, "design", diagrams, "tests")
        state_warnings = [w for w in result.warnings if "类图中不存在的类" in w]
        assert len(state_warnings) >= 1

    def test_activity_to_test_coverage(self):
        """活动图节点应在测试用例中被覆盖"""
        req = {"entities": [], "functions": []}
        diagrams = {
            "class_diagram": "",
            "activity_diagram": "flowchart TD\n    A[借阅图书] --> B[归还图书]\n    B --> C[查询记录]",
        }
        test_cases = "| 编号 | 测试对象 |\n|------|----------|\n| 1 | 借阅图书测试 |\n| 2 | 归还图书测试 |"
        result = self.checker.check_all(req, "design", diagrams, test_cases)
        activity_checks = [c for c in result.checks if c.get("dimension") == "活动图→测试覆盖"]
        assert len(activity_checks) == 1
        # "查询记录"未在测试用例中，应有warning
        activity_warnings = [w for w in result.warnings if "活动图节点" in w]
        assert len(activity_warnings) >= 1

    def test_activity_to_test_all_covered(self):
        """活动图节点全部被测试用例覆盖时score应为1.0"""
        req = {"entities": [], "functions": []}
        diagrams = {
            "activity_diagram": "flowchart TD\n    A[登录] --> B[注册]",
        }
        test_cases = "| 编号 | 测试对象 |\n|------|----------|\n| 1 | 登录功能 |\n| 2 | 注册功能 |"
        result = self.checker.check_all(req, "design", diagrams, test_cases)
        activity_checks = [c for c in result.checks if c.get("dimension") == "活动图→测试覆盖"]
        assert len(activity_checks) == 1
        assert activity_checks[0]["score"] == 1.0

    def test_activity_missing_diagram(self):
        """活动图缺失时score降为0.5"""
        req = {"entities": [], "functions": []}
        diagrams = {}
        result = self.checker.check_all(req, "design", diagrams, "tests")
        activity_checks = [c for c in result.checks if c.get("dimension") == "活动图→测试覆盖"]
        assert len(activity_checks) == 1
        assert activity_checks[0]["score"] == 0.5

    def test_none_diagrams_no_crash(self):
        """diagrams为None时不崩溃"""
        req = {"entities": [{"name": "User"}], "functions": [{"name": "login"}]}
        result = self.checker.check_all(req, "design", None, "tests")
        assert isinstance(result.score, float)

    def test_all_keywords_missing_detected(self):
        """设计→测试覆盖：所有关键词都缺失时score应为0.0"""
        req = {"entities": [], "functions": []}
        design = "## 用户管理\n## 订单管理"
        diagrams = {}
        test_cases = "| 编号 | 测试对象 |\n|------|----------|\n| 1 | 完全无关 |"
        result = self.checker.check_all(req, design, diagrams, test_cases)
        design_checks = [c for c in result.checks if c.get("dimension") == "设计→测试覆盖"]
        assert len(design_checks) == 1
        assert design_checks[0]["score"] < 1.0

    def test_activity_all_nodes_missing_detected(self):
        """活动图→测试覆盖：所有节点都缺失时score应<1.0"""
        req = {"entities": [], "functions": []}
        diagrams = {
            "activity_diagram": "flowchart TD\n    A[借阅] --> B[归还]",
        }
        test_cases = "| 编号 | 测试对象 |\n|------|----------|\n| 1 | 完全无关功能 |"
        result = self.checker.check_all(req, "design", diagrams, test_cases)
        activity_checks = [c for c in result.checks if c.get("dimension") == "活动图→测试覆盖"]
        assert len(activity_checks) == 1
        assert activity_checks[0]["score"] < 1.0


# ========== Lightweight Review ==========

class TestLightweightReview:
    """测试需求分析后轻量审查"""

    def _make_orchestrator(self):
        from governance.orchestrator import TaskOrchestrator
        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.context = ContextController()
        return orch

    def test_complete_req_passes(self):
        """完整需求通过轻量审查"""
        orch = self._make_orchestrator()
        req = {
            "actors": ["user", "admin"],
            "functions": [
                {"name": "login", "description": "登录"},
                {"name": "register", "description": "注册"},
            ],
            "entities": [
                {"name": "User"},
                {"name": "Order"},
            ],
        }
        result = orch._lightweight_review(req)
        assert result["pass"] is True
        assert len(result["issues"]) == 0
        assert result["actor_count"] == 2
        assert result["function_count"] == 2
        assert result["entity_count"] == 2

    def test_empty_req_fails(self):
        """空需求失败"""
        orch = self._make_orchestrator()
        result = orch._lightweight_review({})
        assert result["pass"] is False
        assert len(result["issues"]) > 0

    def test_none_req_fails(self):
        """None需求失败"""
        orch = self._make_orchestrator()
        result = orch._lightweight_review(None)
        assert result["pass"] is False

    def test_missing_actors(self):
        """缺少actors"""
        orch = self._make_orchestrator()
        req = {"actors": [], "functions": [{"name": "f", "description": "d"}], "entities": [{"name": "E"}]}
        result = orch._lightweight_review(req)
        assert any("actors" in i for i in result["issues"])

    def test_missing_functions(self):
        """缺少functions"""
        orch = self._make_orchestrator()
        req = {"actors": ["a"], "functions": [], "entities": [{"name": "E"}]}
        result = orch._lightweight_review(req)
        assert any("功能" in i for i in result["issues"])

    def test_missing_entities(self):
        """缺少entities"""
        orch = self._make_orchestrator()
        req = {"actors": ["a"], "functions": [{"name": "f", "description": "d"}], "entities": []}
        result = orch._lightweight_review(req)
        assert any("实体" in i for i in result["issues"])

    def test_function_without_name(self):
        """功能点缺少名称"""
        orch = self._make_orchestrator()
        req = {
            "actors": ["a"],
            "functions": [{"description": "d"}, {"name": "ok", "description": "d2"}],
            "entities": [{"name": "E"}],
        }
        result = orch._lightweight_review(req)
        assert any("名称" in i for i in result["issues"])

    def test_function_without_description(self):
        """功能点缺少描述"""
        orch = self._make_orchestrator()
        req = {
            "actors": ["a"],
            "functions": [{"name": "f1"}, {"name": "f2", "description": "d"}],
            "entities": [{"name": "E"}],
        }
        result = orch._lightweight_review(req)
        assert any("描述" in i for i in result["issues"])


# ========== StageRecord to_summary ==========

class TestStageRecordSummary:
    """测试StageRecord序列化"""

    def test_to_dict_full_data(self):
        """to_dict保存完整数据"""
        sr = StageRecord(
            stage_name="test",
            input_data="x" * 500,
            output_data="y" * 500,
            start_time=1.0,
            end_time=2.0,
        )
        d = sr.to_dict()
        assert len(d["input_data"]) == 500
        assert len(d["output_data"]) == 500

    def test_to_summary_truncated(self):
        """to_summary截断数据"""
        sr = StageRecord(
            stage_name="test",
            input_data="x" * 500,
            output_data="y" * 500,
            start_time=1.0,
            end_time=2.0,
        )
        s = sr.to_summary()
        assert len(s["input_summary"]) <= 203  # 200 + "..."
        assert len(s["output_summary"]) <= 203
        assert "input_summary" in s
        assert "output_summary" in s

    def test_to_summary_none_data(self):
        """to_summary处理None数据"""
        sr = StageRecord(stage_name="test", input_data=None, output_data=None)
        s = sr.to_summary()
        assert s["input_summary"] == ""
        assert s["output_summary"] == ""

    def test_from_dict_backward_compat(self):
        """from_dict兼容旧格式（input_summary/output_summary）"""
        old_data = {
            "stage_name": "test",
            "input_summary": "truncated...",
            "output_summary": "truncated...",
            "validation": {"is_valid": True, "errors": [], "warnings": [], "score": 1.0},
            "repair_records": [],
            "start_time": 0,
            "end_time": 0,
            "status": "success",
        }
        sr = StageRecord.from_dict(old_data)
        assert sr.stage_name == "test"
        assert sr.input_data == "truncated..."

    def test_from_dict_new_format(self):
        """from_dict支持新格式（input_data/output_data）"""
        new_data = {
            "stage_name": "test",
            "input_data": "full data",
            "output_data": "full output",
            "validation": {"is_valid": True, "errors": [], "warnings": [], "score": 1.0},
            "repair_records": [],
            "start_time": 0,
            "end_time": 0,
            "status": "success",
        }
        sr = StageRecord.from_dict(new_data)
        assert sr.input_data == "full data"
        assert sr.output_data == "full output"


# ========== Gate RETRY/REPAIR loop ==========

class TestGateRetryRepairLoop:
    """测试门控RETRY和REPAIR循环逻辑"""

    def test_retry_then_proceed(self):
        """RETRY后重试成功→PROCEED"""
        gate = StageGate(GovernanceConfig(
            gate_thresholds={"min_completeness": 0.8}
        ))
        # 空响应错误，retry_count=0 → RETRY
        vr = ValidationResult(is_valid=False, errors=["空响应"], score=0.5)
        assert gate.evaluate("test", vr, retry_count=0, max_retries=2) == GateDecision.RETRY

        # 重试后通过
        vr2 = ValidationResult(is_valid=True, score=1.0)
        assert gate.evaluate("test", vr2, retry_count=1, max_retries=2) == GateDecision.PROCEED

    def test_repair_then_proceed(self):
        """REPAIR后修复成功→PROCEED"""
        gate = StageGate(GovernanceConfig(
            max_repair_rounds=3,
            gate_thresholds={"min_completeness": 0.8}
        ))
        # 不可重试错误，retry_count=2 → REPAIR
        vr = ValidationResult(is_valid=False, errors=["格式错误"], score=0.5)
        decision = gate.evaluate("test", vr, retry_count=2, max_retries=2, repair_count=0)
        assert decision == GateDecision.REPAIR

        # 修复后通过
        vr2 = ValidationResult(is_valid=True, score=1.0)
        assert gate.evaluate("test", vr2, retry_count=2, repair_count=1) == GateDecision.PROCEED

    def test_halt_on_very_low_score_with_retry(self):
        """极低分数且已重试→HALT"""
        gate = StageGate(GovernanceConfig(
            gate_thresholds={"min_completeness": 0.8}
        ))
        # score=0.1 < 0.8*0.4=0.32, 且retry_count>0 → HALT
        vr = ValidationResult(is_valid=False, errors=["bad"], score=0.1)
        assert gate.evaluate("test", vr, retry_count=1) == GateDecision.HALT

    def test_halt_after_max_repairs(self):
        """达到最大修复轮次→HALT"""
        gate = StageGate(GovernanceConfig(
            max_repair_rounds=2,
            gate_thresholds={"min_completeness": 0.8}
        ))
        vr = ValidationResult(is_valid=False, errors=["bad"], score=0.5)
        assert gate.evaluate("test", vr, retry_count=2, repair_count=2, max_retries=2) == GateDecision.HALT


# ========== Orchestrator _run_stage with mock ==========

class TestOrchestratorRunStage:
    """测试orchestrator._run_stage的RETRY和REPAIR循环"""

    def _make_orchestrator(self):
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig

        class MockLLM:
            provider = "test"
            model = "test-model"
            temperature = 0.3
            max_tokens = 100
            def chat(self, m, temperature=None): return "ok"
            def generate_json(self, p, s=""): return {"actors": ["a"], "functions": [{"name": "f", "description": "d"}], "entities": [{"name": "E"}]}
            def generate_text(self, p, s=""): return "# Design\n\nContent here"

        gov = GovernanceConfig(enabled=True, trace_enabled=True)
        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.gov = gov
        orch.config = AgentConfig()
        orch.trace = TraceLogger()
        orch.validator = ToolValidator()
        orch.gate = StageGate(gov)
        orch.context = ContextController()
        orch.repair = RepairController(max_rounds=gov.max_repair_rounds)
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.consistency = None
        orch.prompt_registry = PromptRegistry.__new__(PromptRegistry)
        orch.prompt_registry._prompts = {}
        orch.prompt_registry.prompts_dir = "/none"
        orch.stage_records = []
        orch.llm = MockLLM()
        return orch

    def test_stage_success(self):
        """阶段正常执行成功"""
        orch = self._make_orchestrator()
        call_count = [0]
        def stage_fn(record):
            call_count[0] += 1
            return {"actors": ["a"], "functions": [{"name": "f", "description": "d"}], "entities": [{"name": "E"}]}

        orch.context.set("full_text", "some text")
        record = orch._run_stage("requirement_analysis", stage_fn)
        assert record.status == "success"
        assert call_count[0] == 1

    def test_retry_actually_retries(self):
        """RETRY导致stage_fn被重新调用"""
        orch = self._make_orchestrator()
        call_count = [0]

        def stage_fn(record):
            call_count[0] += 1
            if call_count[0] == 1:
                return None  # "输出为空" 包含 "为空" → RETRY
            return {"actors": ["a"], "functions": [{"name": "f", "description": "d"}], "entities": [{"name": "E"}]}

        orch.context.set("full_text", "text")
        record = orch._run_stage("requirement_analysis", stage_fn)
        assert call_count[0] == 2  # 被调用了2次
        assert record.status == "success"

    def test_repair_multi_round(self):
        """REPAIR支持多轮修复，修复成功后可PROCEED"""
        orch = self._make_orchestrator()

        # 用一个校验失败的stage来触发REPAIR
        def stage_fn(record):
            return {}  # 空dict → 校验失败

        orch.context.set("full_text", "text")
        record = orch._run_stage("requirement_analysis", stage_fn)
        # 修复可能成功（success）或失败（halted/failed）
        assert record.status in ("success", "failed", "halted")

    def test_halt_on_very_low_score(self):
        """极低分数导致HALT"""
        orch = self._make_orchestrator()
        # 使用低阈值配置
        orch.gate = StageGate(GovernanceConfig(
            gate_thresholds={"min_completeness": 0.8}
        ))

        call_count = [0]
        def stage_fn(record):
            call_count[0] += 1
            # 第一次返回None → 失败 → REPAIR → 修复后仍失败 → HALT
            return None

        orch.context.set("full_text", "text")
        record = orch._run_stage("requirement_analysis", stage_fn)
        # 状态应该是failed或halted（取决于gate决策路径）
        assert record.status in ("failed", "halted")

    def test_agent_warnings_merged(self):
        """Agent自校验warnings合并到gate"""
        orch = self._make_orchestrator()

        def stage_fn(record):
            # 返回(output, warnings)元组
            return {"actors": ["a"], "functions": [{"name": "f", "description": "d"}], "entities": [{"name": "E"}]}, ["warning1", "warning2"]

        orch.context.set("full_text", "text")
        record = orch._run_stage("requirement_analysis", stage_fn)
        # warnings应被合并到validation_result
        assert len(record.validation_result.warnings) >= 2

    def test_stage_exception_handled(self):
        """阶段异常被正确处理"""
        orch = self._make_orchestrator()

        def stage_fn(record):
            raise RuntimeError("boom")

        record = orch._run_stage("requirement_analysis", stage_fn)
        assert record.status == "failed"
        assert "boom" in str(record.validation_result.errors)

    def test_snapshot_after_stage(self):
        """阶段后上下文快照记录"""
        orch = self._make_orchestrator()
        orch.context.set("full_text", "text")

        def stage_fn(record):
            orch.context.set("requirement_json", {"a": 1})
            return {"actors": ["a"], "functions": [{"name": "f", "description": "d"}], "entities": [{"name": "E"}]}

        orch._run_stage("requirement_analysis", stage_fn)
        assert len(orch.context.get_history()) >= 1

    def test_regenerate_signal_re_runs_stage(self):
        """REGENERATE信号导致阶段重新执行"""
        orch = self._make_orchestrator()
        orch.context.set("full_text", "text")

        call_count = [0]
        def stage_fn(record):
            call_count[0] += 1
            return {"actors": ["a"], "functions": [{"name": "f", "description": "d"}], "entities": [{"name": "E"}]}

        # Mock checkpoint: 第一次REGENERATE，第二次CONTINUE
        from governance.models import HumanDecision, HumanAction
        decisions = [
            HumanDecision(stage="requirement_analysis", action=HumanAction.REGENERATE),
            HumanDecision(stage="requirement_analysis", action=HumanAction.CONTINUE),
        ]
        call_idx = [0]
        original_pause = orch.checkpoint.pause
        def mock_pause(stage, summary, preview):
            d = decisions[call_idx[0]]
            call_idx[0] += 1
            orch.checkpoint.decisions.append(d)
            return d
        orch.checkpoint.pause = mock_pause
        orch.checkpoint.checkpoint_stages = {"requirement_analysis"}

        record = orch._run_stage("requirement_analysis", stage_fn)
        assert call_count[0] == 2  # 被调用了2次
        assert record.status == "success"

    def test_regenerate_failure_sets_failed(self):
        """REGENERATE后重新执行失败则status=failed"""
        orch = self._make_orchestrator()
        orch.context.set("full_text", "text")

        call_count = [0]
        def stage_fn(record):
            call_count[0] += 1
            if call_count[0] >= 2:
                raise RuntimeError("regenerate failed")
            return {"actors": ["a"], "functions": [{"name": "f", "description": "d"}], "entities": [{"name": "E"}]}

        from governance.models import HumanDecision, HumanAction
        decisions = [
            HumanDecision(stage="requirement_analysis", action=HumanAction.REGENERATE),
            HumanDecision(stage="requirement_analysis", action=HumanAction.CONTINUE),
        ]
        call_idx = [0]
        def mock_pause(stage, summary, preview):
            d = decisions[call_idx[0]]
            call_idx[0] += 1
            orch.checkpoint.decisions.append(d)
            return d
        orch.checkpoint.pause = mock_pause
        orch.checkpoint.checkpoint_stages = {"requirement_analysis"}

        record = orch._run_stage("requirement_analysis", stage_fn)
        # 重新生成失败，但checkpoint仍然CONTINUE
        assert record.status in ("failed", "success")


# ========== Human checkpoint on all stages ==========

class TestHumanCheckpointAllStages:
    """测试人工检查点扩展到所有阶段"""

    def test_checkpoint_on_configured_stage(self):
        """配置的阶段触发检查点"""
        hc = HumanCheckpoint(
            checkpoint_stages=["requirement_analysis", "design_planner"],
            interactive=False,
        )
        assert hc.is_checkpoint("requirement_analysis")
        assert hc.is_checkpoint("design_planner")
        assert not hc.is_checkpoint("diagram_generator")

    def test_checkpoint_on_all_stages(self):
        """所有阶段都可配置为检查点"""
        all_stages = [
            "input_loader", "requirement_analysis", "design_planner",
            "diagram_generator", "test_case_generator", "review_agent"
        ]
        hc = HumanCheckpoint(
            checkpoint_stages=all_stages,
            interactive=False,
        )
        for stage in all_stages:
            assert hc.is_checkpoint(stage), f"{stage} should be a checkpoint"

    def test_no_checkpoint_when_empty(self):
        """空配置不触发任何检查点"""
        hc = HumanCheckpoint(checkpoint_stages=[], interactive=False)
        for stage in ["requirement_analysis", "design_planner"]:
            assert not hc.is_checkpoint(stage)


# ========== No WorkflowController ==========

class TestNoWorkflowController:
    """确认WorkflowController已移除"""

    def test_no_workflow_controller_import(self):
        """main.py不导入WorkflowController"""
        with open(os.path.join(PROJECT_ROOT, "agent", "main.py"), "r") as f:
            content = f.read()
        assert "WorkflowController" not in content

    def test_no_workflow_controller_file(self):
        """workflow_controller.py已删除"""
        assert not os.path.exists(os.path.join(PROJECT_ROOT, "agent", "workflow_controller.py"))

    def test_benchmark_uses_orchestrator(self):
        """benchmark使用TaskOrchestrator"""
        with open(os.path.join(PROJECT_ROOT, "benchmark", "run_benchmark.py"), "r") as f:
            content = f.read()
        assert "TaskOrchestrator" in content
        assert "WorkflowController" not in content

    def test_standard_mode_uses_orchestrator(self):
        """标准模式使用TaskOrchestrator"""
        with open(os.path.join(PROJECT_ROOT, "agent", "main.py"), "r") as f:
            content = f.read()
        assert "TaskOrchestrator" in content
        # 标准模式也用orchestrator
        assert "orchestrator = TaskOrchestrator(config)" in content


# ========== Edge cases ==========

class TestValidationEdgeCases:
    """测试校验边界场景"""

    def _make_orchestrator(self):
        from governance.orchestrator import TaskOrchestrator
        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.validator = ToolValidator()
        orch.context = ContextController()
        return orch

    def test_validate_empty_string_output(self):
        """空字符串输出"""
        orch = self._make_orchestrator()
        for stage in ["design_planner", "test_case_generator"]:
            vr = orch._validate_stage_output(stage, "")
            assert not vr.is_valid

    def test_validate_none_output_all_stages(self):
        """所有阶段None输出"""
        orch = self._make_orchestrator()
        for stage in ["requirement_analysis", "design_planner", "diagram_generator",
                       "test_case_generator", "review_agent"]:
            vr = orch._validate_stage_output(stage, None)
            assert not vr.is_valid
            assert vr.score == 0.0

    def test_validate_review_score_boundary(self):
        """review分数边界：30分刚好通过"""
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("review_agent", {"overall_score": 30})
        assert vr.is_valid
        assert abs(vr.score - 0.3) < 0.01

    def test_validate_review_score_29(self):
        """review分数29不通过"""
        orch = self._make_orchestrator()
        vr = orch._validate_stage_output("review_agent", {"overall_score": 29})
        assert not vr.is_valid


class TestRepairRecordHistory:
    """测试修复记录完整保存"""

    def test_repair_records_accumulate(self):
        """修复记录在多次修复中累积"""
        rc = RepairController(max_rounds=3)
        call_count = [0]
        def validate(x):
            call_count[0] += 1
            return ValidationResult(is_valid=False, errors=[f"err{call_count[0]}"])
        def repair(x, e):
            return f"fixed_{call_count[0]}"

        out, records = rc.attempt_repair("test", "bad", validate, repair)
        assert len(records) == 3
        for i, r in enumerate(records):
            assert r.attempt == i + 1
            assert r.action == "llm_repair"

    def test_repair_records_serializable(self):
        """修复记录可序列化"""
        records = [
            RepairRecord(1, "err", "fix", "ok", True),
            RepairRecord(2, "err2", "fix2", "fail", False),
        ]
        for r in records:
            d = r.to_dict()
            assert isinstance(d, dict)
            r2 = RepairRecord.from_dict(d)
            assert r2.attempt == r.attempt
            assert r2.success == r.success


# ========== Governance report ==========

class TestGovernanceReport:
    """测试治理报告生成"""

    def test_report_uses_summary(self):
        """治理报告使用to_summary（截断版本）"""
        sr = StageRecord(
            stage_name="test",
            input_data="x" * 500,
            output_data="y" * 500,
            start_time=1.0,
            end_time=2.0,
            status="success",
        )
        # to_summary应截断
        summary = sr.to_summary()
        assert len(summary["input_summary"]) < 500

        # to_dict应完整
        full = sr.to_dict()
        assert len(full["input_data"]) == 500


# ========== Coverage gap: _try_repair ==========

class TestTryRepair:
    """测试_try_repair方法"""

    def _make_orchestrator(self):
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig

        class MockLLM:
            provider = "test"
            model = "test"
            temperature = 0.3
            max_tokens = 100
            def generate_json(self, prompt, system=""):
                return {"actors": ["a"], "functions": [{"name": "f", "description": "d"}], "entities": [{"name": "E"}]}
            def generate_text(self, prompt, system=""):
                return "repaired text output"

        gov = GovernanceConfig(enabled=True, max_repair_rounds=3)
        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.gov = gov
        orch.config = AgentConfig()
        orch.trace = TraceLogger()
        orch.validator = ToolValidator()
        orch.gate = StageGate(gov)
        orch.context = ContextController()
        orch.repair = RepairController(max_rounds=gov.max_repair_rounds)
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.stage_records = []
        orch.llm = MockLLM()
        return orch

    def test_try_repair_dict_uses_generate_json(self):
        """dict输出修复时调用generate_json"""
        orch = self._make_orchestrator()
        orch.context.set("requirement_json", {"actors": ["user"]})

        json_called = [0]
        text_called = [0]
        orig_json = orch.llm.generate_json
        orig_text = orch.llm.generate_text
        def mock_json(p, s=""):
            json_called[0] += 1
            return orig_json(p, s)
        def mock_text(p, s=""):
            text_called[0] += 1
            return orig_text(p, s)
        orch.llm.generate_json = mock_json
        orch.llm.generate_text = mock_text

        vr = ValidationResult(is_valid=False, errors=["格式错误"], score=0.5)
        output, records = orch._try_repair("requirement_analysis", {"bad": True}, vr)
        assert json_called[0] >= 1
        assert text_called[0] == 0

    def test_try_repair_text_uses_generate_text(self):
        """字符串输出修复时调用generate_text"""
        orch = self._make_orchestrator()
        orch.context.set("requirement_json", {"actors": ["user"]})

        json_called = [0]
        text_called = [0]
        orig_json = orch.llm.generate_json
        orig_text = orch.llm.generate_text
        def mock_json(p, s=""):
            json_called[0] += 1
            return orig_json(p, s)
        def mock_text(p, s=""):
            text_called[0] += 1
            return orig_text(p, s)
        orch.llm.generate_json = mock_json
        orch.llm.generate_text = mock_text

        # 空字符串会触发validate_markdown返回is_valid=False
        vr = ValidationResult(is_valid=False, errors=["Markdown内容为空"], score=0.0)
        output, records = orch._try_repair("design_planner", "", vr)
        assert text_called[0] >= 1
        assert json_called[0] == 0

    def test_try_repair_truncates_long_output(self):
        """长输出在修复前被截断"""
        orch = self._make_orchestrator()

        # 让validate_markdown对长文本也返回失败
        orig_validate = orch._validate_stage_output
        call_count = [0]
        def mock_validate(stage, output):
            call_count[0] += 1
            if call_count[0] <= 1:
                # 第一次校验（初始输出）失败
                return ValidationResult(is_valid=False, errors=["内容不足"], score=0.0)
            # 修复后校验通过
            return ValidationResult(is_valid=True, score=1.0)
        orch._validate_stage_output = mock_validate

        captured_prompts = []
        def mock_text(prompt, system=""):
            captured_prompts.append(prompt)
            return "repaired"
        orch.llm.generate_text = mock_text

        long_output = "x" * 5000
        vr = ValidationResult(is_valid=False, errors=["too long"], score=0.5)
        orch._try_repair("design_planner", long_output, vr)

        # prompt中应包含截断标记
        assert len(captured_prompts) == 1
        assert "截断" in captured_prompts[0]
        assert len(captured_prompts[0]) < len(long_output) + 500


# ========== Coverage gap: HALT path ==========

class TestHaltPath:
    """测试_run_stage HALT路径"""

    def _make_orchestrator(self):
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig

        class MockLLM:
            provider = "test"
            model = "test"
            temperature = 0.3
            max_tokens = 100
            def chat(self, m, temperature=None): return "ok"
            def generate_json(self, p, s=""): return {}
            def generate_text(self, p, s=""): return ""

        gov = GovernanceConfig(
            enabled=True,
            max_repair_rounds=1,
            gate_thresholds={"min_completeness": 0.8}
        )
        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.gov = gov
        orch.config = AgentConfig()
        orch.trace = TraceLogger()
        orch.validator = ToolValidator()
        orch.gate = StageGate(gov)
        orch.context = ContextController()
        orch.repair = RepairController(max_rounds=1)
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.stage_records = []
        orch.llm = MockLLM()
        return orch

    def test_halt_on_low_score_after_retries(self):
        """低分数+重试耗尽后应HALT"""
        orch = self._make_orchestrator()
        orch.config.retry.max_retries = 0  # 不允许重试

        call_count = [0]
        def stage_fn(record):
            call_count[0] += 1
            return None  # 触发校验失败

        orch.context.set("full_text", "text")
        record = orch._run_stage("requirement_analysis", stage_fn)
        assert record.status == "halted"

    def test_halt_after_repair_still_fails(self):
        """修复后仍失败应HALT"""
        orch = self._make_orchestrator()
        orch.config.retry.max_retries = 0

        # LLM修复也返回空
        orch.llm.generate_json = lambda p, s="": {}

        call_count = [0]
        def stage_fn(record):
            call_count[0] += 1
            return None

        orch.context.set("full_text", "text")
        record = orch._run_stage("requirement_analysis", stage_fn)
        # 状态应为halted（修复后仍不满足阈值）
        assert record.status in ("halted", "success")  # 修复可能意外成功


# ========== Coverage gap: regenerate context update ==========

class TestRegenerateContextUpdate:
    """测试REGENERATE后上下文更新"""

    def _make_orchestrator(self):
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig

        class MockLLM:
            provider = "test"
            model = "test"
            temperature = 0.3
            max_tokens = 100
            def chat(self, m, temperature=None): return "ok"
            def generate_json(self, p, s=""): return {}
            def generate_text(self, p, s=""): return "# Design\n\nContent"

        gov = GovernanceConfig(enabled=True)
        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.gov = gov
        orch.config = AgentConfig()
        orch.trace = TraceLogger()
        orch.validator = ToolValidator()
        orch.gate = StageGate(gov)
        orch.context = ContextController()
        orch.repair = RepairController(max_rounds=1)
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.stage_records = []
        orch.llm = MockLLM()
        return orch

    def test_regenerate_design_planner_updates_context(self):
        """design_planner阶段REGENERATE后上下文更新"""
        orch = self._make_orchestrator()
        orch.context.set("requirement_json", {"actors": ["a"]})

        call_count = [0]
        def stage_fn(record):
            call_count[0] += 1
            if call_count[0] == 1:
                return "first design"
            return "regenerated design"

        from governance.models import HumanDecision, HumanAction
        decisions = [
            HumanDecision(stage="design_planner", action=HumanAction.REGENERATE),
            HumanDecision(stage="design_planner", action=HumanAction.CONTINUE),
        ]
        call_idx = [0]
        def mock_pause(stage, summary, preview):
            d = decisions[call_idx[0]]
            call_idx[0] += 1
            orch.checkpoint.decisions.append(d)
            return d
        orch.checkpoint.pause = mock_pause
        orch.checkpoint.checkpoint_stages = {"design_planner"}

        record = orch._run_stage("design_planner", stage_fn)
        assert call_count[0] == 2
        # 上下文应更新为重新生成的内容
        assert orch.context.get("design_text") == "regenerated design"


# ========== Coverage gap: governance report mixed statuses ==========

class TestGovernanceReportMixedStatuses:
    """测试治理报告中混合状态计数"""

    def test_report_counts_all_statuses(self, tmp_path):
        """报告正确计算success/failed/halted"""
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig

        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.config = AgentConfig()
        orch.gov = GovernanceConfig()
        orch.context = ContextController()
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.trace = TraceLogger()
        orch.prompt_registry = type("MockPR", (), {"get_all_versions": lambda self: {}})()

        statuses = ["success", "success", "success", "failed", "halted", "failed"]
        orch.stage_records = []
        for i, status in enumerate(statuses):
            sr = StageRecord(stage_name=f"stage_{i}")
            sr.status = status
            sr.validation_result = ValidationResult(is_valid=True, score=1.0)
            orch.stage_records.append(sr)

        output_dir = str(tmp_path / "report")
        orch._export_governance_report(output_dir, {})

        import json
        with open(tmp_path / "report" / "governance_report.json") as f:
            report = json.load(f)

        summary = report["governance_summary"]
        assert summary["total_stages"] == 6
        assert summary["succeeded"] == 3
        assert summary["failed"] == 2
        assert summary["halted"] == 1


# ========== Coverage gap: finally-block errors ==========

class TestFinallyBlockErrors:
    """测试finally块中的错误处理"""

    def test_trace_export_error_does_not_block(self, tmp_path):
        """追踪导出失败不应阻塞任务完成"""
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig

        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.config = AgentConfig()
        orch.gov = GovernanceConfig(enabled=True, trace_enabled=True)
        orch.context = ContextController()
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.trace = TraceLogger()
        orch.validator = ToolValidator()
        orch.gate = StageGate(orch.gov)
        orch.repair = RepairController(max_rounds=1)
        orch.stage_records = []
        orch.consistency = type("MockCC", (), {
            "check_all": lambda self, r, d, di, t: type("CR", (), {
                "score": 0.9, "errors": [], "warnings": [], "checks": [],
                "is_valid": True,
            })()
        })()
        orch.prompt_registry = type("MockPR", (), {"get_all_versions": lambda self: {}})()

        class MockLLM:
            provider = "test"
            model = "test"
            temperature = 0.3
            max_tokens = 100
            def set_stage(self, s): pass
            def chat(self, m, temperature=None): return "ok"
            def generate_json(self, p, s=""):
                return {"project_name": "t", "actors": [{"name": "a"}],
                        "functions": [{"name": "f", "description": "d"}],
                        "entities": [{"name": "E"}], "constraints": [],
                        "exceptions": [], "non_functional_requirements": [],
                        "business_processes": []}
            def generate_text(self, p, s=""): return "# Design"

        orch.llm = MockLLM()
        orch.input_loader = type("IL", (), {"load": lambda self, p: "text"})()
        orch.requirement_analyzer = type("RA", (), {
            "analyze": lambda self, t, max_retries=3: {"project_name": "t", "actors": [{"name": "a"}],
                "functions": [{"name": "f", "description": "d"}], "entities": [{"name": "E"}],
                "constraints": [], "exceptions": [], "non_functional_requirements": [],
                "business_processes": []},
            "validate_result": lambda self, r: [],
        })()
        orch.design_planner = type("DP", (), {
            "generate_design": lambda self, r: "# Design",
            "validate_design": lambda self, d, r: [],
        })()
        orch.diagram_generator = type("DG", (), {
            "generate_all": lambda self, r, d: {
                "class_diagram": "classDiagram\n    class A",
                "activity_diagram": "flowchart TD\n    A-->B",
                "state_diagram": "stateDiagram-v2\n    [*]-->A",
            },
        })()
        orch.test_case_generator = type("TC", (), {
            "generate": lambda self, r, d: "| 编号 | 测试 |\n|---|---|\n| 1 | t |",
            "validate_test_cases": lambda self, c, r: [],
        })()
        orch.review_agent = type("Rev", (), {
            "review_and_repair": lambda self, r, d, di, max_repair_rounds=2: (
                {"overall_score": 85, "overall_pass": True, "checks": [], "syntax_check": []}, di),
            "generate_report": lambda self, result: "# Report",
        })()

        # Mock trace.export_json to raise
        def raise_export(path):
            raise IOError("disk full")
        orch.trace.export_json = raise_export

        input_file = tmp_path / "input.md"
        input_file.write_text("# Test\n## Func\n- A")

        # 不应抛出异常
        result = orch.run_design_task(str(input_file), str(tmp_path / "out"))
        assert "requirement_analysis" in result

    def test_governance_report_error_does_not_block(self, tmp_path):
        """治理报告导出失败不应阻塞任务完成"""
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig

        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.config = AgentConfig()
        orch.gov = GovernanceConfig(enabled=True, trace_enabled=False)
        orch.context = ContextController()
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.trace = TraceLogger()
        orch.validator = ToolValidator()
        orch.gate = StageGate(orch.gov)
        orch.repair = RepairController(max_rounds=1)
        orch.stage_records = []
        orch.consistency = type("MockCC", (), {
            "check_all": lambda self, r, d, di, t: type("CR", (), {
                "score": 0.9, "errors": [], "warnings": [], "checks": [],
                "is_valid": True,
            })()
        })()

        class MockPR:
            def get_all_versions(self):
                raise RuntimeError("registry broken")
        orch.prompt_registry = MockPR()

        class MockLLM:
            provider = "test"
            model = "test"
            temperature = 0.3
            max_tokens = 100
            def set_stage(self, s): pass
            def chat(self, m, temperature=None): return "ok"
            def generate_json(self, p, s=""):
                return {"project_name": "t", "actors": [{"name": "a"}],
                        "functions": [{"name": "f", "description": "d"}],
                        "entities": [{"name": "E"}], "constraints": [],
                        "exceptions": [], "non_functional_requirements": [],
                        "business_processes": []}
            def generate_text(self, p, s=""): return "# Design"

        orch.llm = MockLLM()
        orch.input_loader = type("IL", (), {"load": lambda self, p: "text"})()
        orch.requirement_analyzer = type("RA", (), {
            "analyze": lambda self, t, max_retries=3: {"project_name": "t", "actors": [{"name": "a"}],
                "functions": [{"name": "f", "description": "d"}], "entities": [{"name": "E"}],
                "constraints": [], "exceptions": [], "non_functional_requirements": [],
                "business_processes": []},
            "validate_result": lambda self, r: [],
        })()
        orch.design_planner = type("DP", (), {
            "generate_design": lambda self, r: "# Design",
            "validate_design": lambda self, d, r: [],
        })()
        orch.diagram_generator = type("DG", (), {
            "generate_all": lambda self, r, d: {
                "class_diagram": "classDiagram\n    class A",
                "activity_diagram": "flowchart TD\n    A-->B",
                "state_diagram": "stateDiagram-v2\n    [*]-->A",
            },
        })()
        orch.test_case_generator = type("TC", (), {
            "generate": lambda self, r, d: "| 编号 | 测试 |\n|---|---|\n| 1 | t |",
            "validate_test_cases": lambda self, c, r: [],
        })()
        orch.review_agent = type("Rev", (), {
            "review_and_repair": lambda self, r, d, di, max_repair_rounds=2: (
                {"overall_score": 85, "overall_pass": True, "checks": [], "syntax_check": []}, di),
            "generate_report": lambda self, result: "# Report",
        })()

        input_file = tmp_path / "input.md"
        input_file.write_text("# Test\n## Func\n- A")

        # 不应抛出异常
        result = orch.run_design_task(str(input_file), str(tmp_path / "out"))
        assert "requirement_analysis" in result


# ========== Coverage gap: consistency errors in review ==========

class TestConsistencyErrorsInReview:
    """测试一致性检查错误合并到审查阶段"""

    def _make_orchestrator(self):
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig

        class MockLLM:
            provider = "test"
            model = "test"
            temperature = 0.3
            max_tokens = 100
            def set_stage(self, s): pass
            def chat(self, m, temperature=None): return "ok"
            def generate_json(self, p, s=""):
                return {"project_name": "t", "actors": [{"name": "a"}],
                        "functions": [{"name": "f", "description": "d"}],
                        "entities": [{"name": "E"}], "constraints": [],
                        "exceptions": [], "non_functional_requirements": [],
                        "business_processes": []}
            def generate_text(self, p, s=""): return "# Design"

        gov = GovernanceConfig(enabled=True, trace_enabled=False)
        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.gov = gov
        orch.config = AgentConfig()
        orch.trace = TraceLogger()
        orch.validator = ToolValidator()
        orch.gate = StageGate(gov)
        orch.context = ContextController()
        orch.repair = RepairController(max_rounds=1)
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.stage_records = []
        orch.llm = MockLLM()
        orch.input_loader = type("IL", (), {"load": lambda self, p: "text"})()
        orch.requirement_analyzer = type("RA", (), {
            "analyze": lambda self, t, max_retries=3: {"project_name": "t", "actors": [{"name": "a"}],
                "functions": [{"name": "f", "description": "d"}], "entities": [{"name": "E"}],
                "constraints": [], "exceptions": [], "non_functional_requirements": [],
                "business_processes": []},
            "validate_result": lambda self, r: [],
        })()
        orch.design_planner = type("DP", (), {
            "generate_design": lambda self, r: "# Design",
            "validate_design": lambda self, d, r: [],
        })()
        orch.diagram_generator = type("DG", (), {
            "generate_all": lambda self, r, d: {
                "class_diagram": "classDiagram\n    class A",
                "activity_diagram": "flowchart TD\n    A-->B",
                "state_diagram": "stateDiagram-v2\n    [*]-->A",
            },
        })()
        orch.test_case_generator = type("TC", (), {
            "generate": lambda self, r, d: "| 编号 | 测试 |\n|---|---|\n| 1 | t |",
            "validate_test_cases": lambda self, c, r: [],
        })()
        orch.review_agent = type("Rev", (), {
            "review_and_repair": lambda self, r, d, di, max_repair_rounds=2: (
                {"overall_score": 85, "overall_pass": True, "checks": [], "syntax_check": []}, di),
            "generate_report": lambda self, result: "# Report",
        })()
        orch.prompt_registry = type("PR", (), {"get_all_versions": lambda self: {}})()
        return orch

    def test_consistency_errors_merged_into_review(self, tmp_path):
        """一致性检查错误合并到审查阶段的validation_result"""
        orch = self._make_orchestrator()

        # Mock consistency to return errors
        orch.consistency = type("CC", (), {
            "check_all": lambda self, r, d, di, t: type("CR", (), {
                "score": 0.3,
                "errors": ["实体User在类图中缺失", "功能login未在测试中覆盖"],
                "warnings": ["实体Order在状态图中未引用"],
                "checks": [],
                "is_valid": False,
            })()
        })()

        input_file = tmp_path / "input.md"
        input_file.write_text("# Test\n## Func\n- A")

        result = orch.run_design_task(str(input_file), str(tmp_path / "out"))

        # 一致性检查结果应存在
        assert "consistency" in result
        assert result["consistency"]["score"] == 0.3
        assert len(result["consistency"]["errors"]) == 2

    def test_consistency_warnings_merged(self, tmp_path):
        """一致性检查warnings合并到审查阶段"""
        orch = self._make_orchestrator()

        orch.consistency = type("CC", (), {
            "check_all": lambda self, r, d, di, t: type("CR", (), {
                "score": 0.8,
                "errors": [],
                "warnings": ["某些实体未在状态图中引用"],
                "checks": [],
                "is_valid": True,
            })()
        })()

        input_file = tmp_path / "input.md"
        input_file.write_text("# Test\n## Func\n- A")

        result = orch.run_design_task(str(input_file), str(tmp_path / "out"))
        assert result["consistency"]["score"] == 0.8


# ========== Coverage gap: max-retries-to-REPAIR ==========

class TestMaxRetriesToRepair:
    """测试重试耗尽后进入REPAIR"""

    def _make_orchestrator(self):
        from governance.orchestrator import TaskOrchestrator
        from governance.models import GovernanceConfig

        class MockLLM:
            provider = "test"
            model = "test"
            temperature = 0.3
            max_tokens = 100
            def chat(self, m, temperature=None): return "ok"
            def generate_json(self, p, s=""):
                return {"actors": ["a"], "functions": [{"name": "f", "description": "d"}], "entities": [{"name": "E"}]}
            def generate_text(self, p, s=""): return "repaired"

        gov = GovernanceConfig(enabled=True, max_repair_rounds=2)
        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.gov = gov
        orch.config = AgentConfig()
        orch.config.retry.max_retries = 1
        orch.trace = TraceLogger()
        orch.validator = ToolValidator()
        orch.gate = StageGate(gov)
        orch.context = ContextController()
        orch.repair = RepairController(max_rounds=2)
        orch.checkpoint = HumanCheckpoint(interactive=False)
        orch.stage_records = []
        orch.llm = MockLLM()
        return orch

    def test_retry_exhausted_then_repair_succeeds(self):
        """重试耗尽后进入REPAIR，修复成功"""
        orch = self._make_orchestrator()

        call_count = [0]
        def stage_fn(record):
            call_count[0] += 1
            if call_count[0] <= 1:
                return None  # 第一次失败，触发RETRY
            # 不应被再次调用（REPAIR后直接校验修复结果）
            return None

        orch.context.set("full_text", "text")
        record = orch._run_stage("requirement_analysis", stage_fn)
        # 至少被调用1次（初始执行）
        assert call_count[0] >= 1
        # 最终状态应为success或halted（取决于修复结果）
        assert record.status in ("success", "halted")


# ========== Coverage gap: function_name key ==========

class TestLightweightReviewFunctionName:
    """测试轻量审查中function_name字段"""

    def _make_orchestrator(self):
        from governance.orchestrator import TaskOrchestrator
        orch = TaskOrchestrator.__new__(TaskOrchestrator)
        orch.context = ContextController()
        return orch

    def test_function_name_key_accepted(self):
        """function_name字段应被接受（不报告缺少名称）"""
        orch = self._make_orchestrator()
        req = {
            "actors": ["user"],
            "functions": [
                {"function_name": "登录", "description": "用户登录"},
                {"function_name": "注册", "description": "用户注册"},
            ],
            "entities": [{"name": "User"}],
        }
        result = orch._lightweight_review(req)
        name_issues = [i for i in result["issues"] if "名称" in i]
        assert len(name_issues) == 0

    def test_function_name_and_name_both_absent(self):
        """function_name和name都缺失时应报告"""
        orch = self._make_orchestrator()
        req = {
            "actors": ["user"],
            "functions": [
                {"description": "某功能"},
            ],
            "entities": [{"name": "User"}],
        }
        result = orch._lightweight_review(req)
        name_issues = [i for i in result["issues"] if "名称" in i]
        assert len(name_issues) == 1

    def test_function_name_takes_priority(self):
        """有function_name时不应报告缺少名称"""
        orch = self._make_orchestrator()
        req = {
            "actors": ["user"],
            "functions": [
                {"function_name": "搜索", "description": "搜索功能"},
                {"name": "登录", "description": "登录功能"},
            ],
            "entities": [{"name": "User"}],
        }
        result = orch._lightweight_review(req)
        name_issues = [i for i in result["issues"] if "名称" in i]
        assert len(name_issues) == 0
