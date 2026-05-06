"""跨产物一致性检查模块"""

import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger("reqdesign")

# 预编译热路径正则
_RE_CJK = re.compile(r'[一-鿿]')
_RE_CONSTRAINT_SPLIT = re.compile(r'[，,、;；的时了后]')
_RE_HEADER_FIND = re.compile(r'#{1,3}\s+(.+)')
_RE_HEADER_WORDS = re.compile(r'[一-龥a-zA-Z]{2,}')
# 活动图节点提取
_RE_ACTIVITY_NODE_CONTENT = re.compile(r'\w+[\[\(>{]([^}\]\)]+)')
_RE_ACTIVITY_NODE_WORDS = re.compile(r'[一-龥a-zA-Z]{2,}')
_RE_ACTIVITY_NODE_ID = re.compile(r'(?:-->|---)\s*(\w+)')
# 类图/状态图类名提取
_RE_CLASS_NAME = re.compile(r'class\s+(\w+)')
_RE_CLASS_NAME_CJK = re.compile(r'class\s+([一-鿿]+)')
_RE_STATE_NAME = re.compile(r'state\s+"?(\w+)"?')
_RE_STATE_NAME_CJK = re.compile(r'state\s+([一-鿿]+)')
_RE_ARROW_LEFT = re.compile(r'(\S+)\s*-->')
_RE_ARROW_RIGHT = re.compile(r'-->\s*(\S+)')

# Mermaid关键字集合（用于过滤状态图中的非实体引用）
_MERMAID_KEYWORDS = frozenset({
    "[*]", "state", "class", "note", "end", "start",
    "participant", "actor", "as", "left", "right", "of",
    "section", "choice", "fork", "join", "activate", "deactivate",
})


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
        if not isinstance(requirement_json, dict):
            requirement_json = {}
        if diagrams is None:
            diagrams = {}
        if design_text is None:
            design_text = ""
        if test_cases is None:
            test_cases = ""

        self._check_requirement_to_design(requirement_json, design_text, result)
        self._check_entities_in_diagram(requirement_json, diagrams, result)
        self._check_constraints_in_design(requirement_json, design_text, result)
        self._check_design_to_test(design_text, test_cases, result)
        self._check_activity_to_test(diagrams, test_cases, result)
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

        if not isinstance(req, dict) or not design:
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
            elif isinstance(f, str) and f.strip():
                func_names.add(f.strip().lower())

        if not func_names:
            check["issues"].append("需求中未找到功能点")
            result.checks.append(check)
            return

        # 检查设计文档是否提到这些功能
        design_lower = design.lower()
        missing = []
        for name in func_names:
            if not _word_in_text(name, design_lower):
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

    def _check_constraints_in_design(
        self, req: dict, design: str, result: ConsistencyResult
    ):
        """需求约束→设计覆盖检查"""
        check = {"dimension": "约束→设计覆盖", "score": 1.0, "issues": []}

        if not isinstance(req, dict) or not design:
            result.checks.append(check)
            return

        constraints = req.get("constraints", [])
        constraint_descs = []
        for c in constraints:
            if isinstance(c, dict):
                desc = c.get("description", "")
                if desc:
                    constraint_descs.append(desc)
            elif isinstance(c, str) and c.strip():
                constraint_descs.append(c.strip())

        if not constraint_descs:
            result.checks.append(check)
            return

        design_lower = design.lower()
        missing = []
        for desc in constraint_descs:
            # 提取关键词检查是否在设计中出现
            keywords = _RE_CONSTRAINT_SPLIT.split(desc)
            keywords = [kw for kw in keywords if len(kw) >= 2]
            if keywords:
                matched = sum(1 for kw in keywords if kw in design_lower)
                if matched / len(keywords) < 0.5:
                    missing.append(desc)

        if missing:
            ratio = 1.0 - len(missing) / len(constraint_descs)
            check["score"] = max(0.0, ratio)
            for m in missing[:3]:
                msg = f"设计文档未覆盖约束: {m}"
                check["issues"].append(msg)
                result.warnings.append(msg)

        result.checks.append(check)

    def _check_entities_in_diagram(
        self, req: dict, diagrams: dict, result: ConsistencyResult
    ):
        """需求实体→类图一致性"""
        check = {"dimension": "实体→类图一致性", "score": 1.0, "issues": []}

        if not isinstance(req, dict):
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
            elif isinstance(e, str) and e.strip():
                entity_names.add(e.strip().lower())

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
            if not _word_in_text(name, class_lower):
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
        headers = _RE_HEADER_FIND.findall(design)
        header_keywords = set()
        for h in headers:
            words = _RE_HEADER_WORDS.findall(h)
            header_keywords.update(w.lower() for w in words)

        if not header_keywords:
            result.checks.append(check)
            return

        test_lower = test_cases.lower()
        missing = []
        for kw in header_keywords:
            if not _word_in_text(kw, test_lower):
                missing.append(kw)

        if missing:
            ratio = 1.0 - len(missing) / len(header_keywords)
            check["score"] = max(0.0, ratio)
            for m in missing[:5]:  # 最多报告5个
                msg = f"测试用例未覆盖设计章节关键词: {m}"
                check["issues"].append(msg)
                result.warnings.append(msg)

        result.checks.append(check)

    def _check_activity_to_test(
        self, diagrams: dict, test_cases: str, result: ConsistencyResult
    ):
        """活动图→测试用例覆盖"""
        check = {"dimension": "活动图→测试覆盖", "score": 1.0, "issues": []}

        activity_diagram = diagrams.get("activity_diagram", "")
        if not activity_diagram or not test_cases:
            check["score"] = 0.5 if not activity_diagram else 1.0
            if not activity_diagram:
                check["issues"].append("活动图缺失")
            result.checks.append(check)
            return

        # 从活动图中提取节点文本（括号内的内容和节点ID）
        node_texts = set()
        # 匹配 A[文本] 或 A(文本) 或 A{文本} 或 A>文本]
        for m in _RE_ACTIVITY_NODE_CONTENT.findall(activity_diagram):
            words = _RE_ACTIVITY_NODE_WORDS.findall(m)
            node_texts.update(w.lower() for w in words)
        # 也匹配纯节点ID（如 A-->B 中的 B）
        node_ids = _RE_ACTIVITY_NODE_ID.findall(activity_diagram)
        # 过滤掉单字母节点ID（太短容易误匹配）
        node_texts.update(n.lower() for n in node_ids if len(n) > 1)

        if not node_texts:
            result.checks.append(check)
            return

        test_lower = test_cases.lower()
        missing = []
        for nt in node_texts:
            if not _word_in_text(nt, test_lower):
                missing.append(nt)

        if missing:
            ratio = 1.0 - len(missing) / len(node_texts)
            check["score"] = max(0.0, ratio)
            for m in missing[:5]:
                msg = f"测试用例未覆盖活动图节点: {m}"
                check["issues"].append(msg)
                result.warnings.append(msg)

        result.checks.append(check)

    def _check_class_to_state(
        self, diagrams: dict, result: ConsistencyResult
    ):
        """类图→状态图实体一致性（反向：状态图引用的类应在类图中存在）"""
        check = {"dimension": "类图→状态图一致性", "score": 1.0, "issues": []}

        class_diagram = diagrams.get("class_diagram", "")
        state_diagram = diagrams.get("state_diagram", "")

        if not class_diagram or not state_diagram:
            check["score"] = 0.5
            check["issues"].append("类图或状态图缺失")
            result.checks.append(check)
            return

        # 从类图中提取类名
        class_names = set(_RE_CLASS_NAME.findall(class_diagram))
        class_names.update(_RE_CLASS_NAME_CJK.findall(class_diagram))
        class_names_lower = {c.lower() for c in class_names}

        if not class_names:
            result.checks.append(check)
            return

        # 从状态图中提取被引用的类名（state关键字后的名称）
        state_refs = set(_RE_STATE_NAME.findall(state_diagram))
        state_refs.update(_RE_STATE_NAME_CJK.findall(state_diagram))
        # 也从箭头定义中提取状态名（如 待借阅 --> 已借阅）
        state_refs.update(_RE_ARROW_LEFT.findall(state_diagram))
        state_refs.update(_RE_ARROW_RIGHT.findall(state_diagram))
        # 过滤掉Mermaid关键字和特殊标记
        state_refs = {s for s in state_refs if s not in _MERMAID_KEYWORDS and len(s) > 1}

        # 反向检查：状态图引用的类应在类图中定义
        orphaned = []
        for ref in state_refs:
            if ref.lower() not in class_names_lower:
                orphaned.append(ref)

        if orphaned:
            check["score"] = max(0.0, 1.0 - len(orphaned) / max(len(state_refs), 1))
            for o in orphaned:
                msg = f"状态图引用了类图中不存在的类: {o}"
                check["issues"].append(msg)
                result.warnings.append(msg)

        result.checks.append(check)


_WORD_PATTERN_CACHE: dict[str, re.Pattern] = {}
_MAX_CACHE_SIZE = 2048


def _word_in_text(word: str, text: str) -> bool:
    """检查word是否作为完整词出现在text中（避免子串误匹配）"""
    # 中文字符不需要词边界（无空格分隔）
    if _RE_CJK.search(word):
        if len(word) < 2:
            return False  # 单字中文太容易误匹配
        return word in text
    # 英文/数字：用非字母数字下划线字符作为分隔符判断完整词
    # 不用\b是因为Python regex将中文视为\w，导致"login和register"被当作一个词
    pattern_key = word.lower()
    pattern = _WORD_PATTERN_CACHE.get(pattern_key)
    if pattern is None:
        # 缓存满时清空，防止长时间运行内存泄漏
        if len(_WORD_PATTERN_CACHE) >= _MAX_CACHE_SIZE:
            _WORD_PATTERN_CACHE.clear()
        pattern = re.compile(
            r'(?<![a-zA-Z0-9_])' + re.escape(word) + r'(?![a-zA-Z0-9_])',
            re.IGNORECASE
        )
        _WORD_PATTERN_CACHE[pattern_key] = pattern
    return bool(pattern.search(text))
