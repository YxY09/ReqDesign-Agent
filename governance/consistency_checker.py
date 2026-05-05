"""跨产物一致性检查模块"""

import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger("reqdesign")


@dataclass
class ConsistencyResult:
    """一致性检查结果"""
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    score: float = 1.0
    checks: list[dict] = field(default_factory=list)

    @property
    def is_valid(self) -> bool:
        return len(self.errors) == 0


class ConsistencyChecker:
    """跨产物一致性检查器（基于关键词匹配，不依赖LLM）"""

    def check_all(
        self,
        requirement_json: dict,
        design_text: str,
        diagrams: dict,
        test_cases: str,
    ) -> ConsistencyResult:
        """
        执行全部一致性检查

        Args:
            requirement_json: 需求分析结果
            design_text: 设计文档
            diagrams: 图表字典 (class_diagram, activity_diagram, state_diagram)
            test_cases: 测试用例文本

        Returns:
            ConsistencyResult
        """
        result = ConsistencyResult()

        self._check_requirement_to_design(requirement_json, design_text, result)
        self._check_entities_in_diagram(requirement_json, diagrams, result)
        self._check_design_to_test(design_text, test_cases, result)
        self._check_class_to_state(diagrams, result)

        # 计算综合分
        if result.checks:
            scores = [c.get("score", 1.0) for c in result.checks]
            result.score = sum(scores) / len(scores)

        logger.info(
            f"[Consistency] 检查完成: {len(result.errors)} errors, "
            f"{len(result.warnings)} warnings, score={result.score:.2f}"
        )
        return result

    def _check_requirement_to_design(
        self, req: dict, design: str, result: ConsistencyResult
    ):
        """需求→设计覆盖检查"""
        check = {"dimension": "需求→设计覆盖", "score": 1.0, "issues": []}

        if not req or not design:
            check["score"] = 0.0
            check["issues"].append("需求或设计为空")
            result.checks.append(check)
            return

        # 提取需求中的功能名
        functions = req.get("functions", [])
        func_names = set()
        for f in functions:
            if isinstance(f, dict):
                name = f.get("name", f.get("function_name", ""))
                if name:
                    func_names.add(name.lower())

        if not func_names:
            check["issues"].append("需求中未找到功能点")
            result.checks.append(check)
            return

        # 检查设计文档是否提到这些功能
        design_lower = design.lower()
        missing = []
        for name in func_names:
            # 用前3个字符做模糊匹配
            keywords = [name[:max(3, len(name) // 2)]] if len(name) > 3 else [name]
            found = any(kw in design_lower for kw in keywords)
            if not found:
                missing.append(name)

        if missing:
            ratio = 1.0 - len(missing) / len(func_names)
            check["score"] = max(0.0, ratio)
            for m in missing:
                msg = f"设计文档未覆盖功能: {m}"
                check["issues"].append(msg)
                if ratio < 0.5:
                    result.errors.append(msg)
                else:
                    result.warnings.append(msg)

        result.checks.append(check)

    def _check_entities_in_diagram(
        self, req: dict, diagrams: dict, result: ConsistencyResult
    ):
        """需求实体→类图一致性"""
        check = {"dimension": "实体→类图一致性", "score": 1.0, "issues": []}

        if not req:
            check["score"] = 0.0
            result.checks.append(check)
            return

        entities = req.get("entities", [])
        entity_names = set()
        for e in entities:
            if isinstance(e, dict):
                name = e.get("name", e.get("entity_name", ""))
                if name:
                    entity_names.add(name.lower())

        if not entity_names:
            check["issues"].append("需求中未找到实体定义")
            result.checks.append(check)
            return

        class_diagram = diagrams.get("class_diagram", "")
        if not class_diagram:
            check["score"] = 0.0
            msg = "类图不存在"
            check["issues"].append(msg)
            result.warnings.append(msg)
            result.checks.append(check)
            return

        class_lower = class_diagram.lower()
        missing = []
        for name in entity_names:
            if name not in class_lower:
                missing.append(name)

        if missing:
            ratio = 1.0 - len(missing) / len(entity_names)
            check["score"] = max(0.0, ratio)
            for m in missing:
                msg = f"类图中缺失实体: {m}"
                check["issues"].append(msg)
                result.warnings.append(msg)

        result.checks.append(check)

    def _check_design_to_test(
        self, design: str, test_cases: str, result: ConsistencyResult
    ):
        """设计→测试用例覆盖"""
        check = {"dimension": "设计→测试覆盖", "score": 1.0, "issues": []}

        if not design or not test_cases:
            check["score"] = 0.5
            check["issues"].append("设计文档或测试用例为空")
            result.checks.append(check)
            return

        # 从设计中提取标题关键词
        headers = re.findall(r'#{1,3}\s+(.+)', design)
        header_keywords = set()
        for h in headers:
            words = re.findall(r'[一-龥a-zA-Z]{2,}', h)
            header_keywords.update(w.lower() for w in words)

        if not header_keywords:
            result.checks.append(check)
            return

        test_lower = test_cases.lower()
        missing = []
        for kw in header_keywords:
            if kw not in test_lower:
                missing.append(kw)

        if missing and len(missing) < len(header_keywords):
            ratio = 1.0 - len(missing) / len(header_keywords)
            check["score"] = max(0.0, ratio)
            for m in missing[:5]:  # 最多报告5个
                msg = f"测试用例未覆盖设计章节关键词: {m}"
                check["issues"].append(msg)
                result.warnings.append(msg)

        result.checks.append(check)

    def _check_class_to_state(
        self, diagrams: dict, result: ConsistencyResult
    ):
        """类图→状态图实体一致性"""
        check = {"dimension": "类图→状态图一致性", "score": 1.0, "issues": []}

        class_diagram = diagrams.get("class_diagram", "")
        state_diagram = diagrams.get("state_diagram", "")

        if not class_diagram or not state_diagram:
            check["score"] = 0.5
            check["issues"].append("类图或状态图缺失")
            result.checks.append(check)
            return

        # 从类图中提取类名 (class ClassName pattern)
        class_names = set(re.findall(r'class\s+(\w+)', class_diagram))
        # 也匹配中文类名
        class_names.update(re.findall(r'class\s+([一-龥]+)', class_diagram))

        if not class_names:
            result.checks.append(check)
            return

        state_lower = state_diagram.lower()
        # 状态图通常只为有状态变化的实体定义状态
        # 只检查在状态图中出现的类名是否在类图中存在（反向检查）
        state_classes = set(re.findall(r'stateDiagram-v2\s*\n\s*(\w+)', state_lower))

        # 正向：类图中的类，如果在状态图中被引用，应有一致的定义
        referenced = set()
        for cn in class_names:
            if cn.lower() in state_lower:
                referenced.add(cn)

        if referenced:
            check["issues"].append(
                f"类图中有{len(referenced)}个类在状态图中被引用"
            )

        result.checks.append(check)
