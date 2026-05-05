"""评分脚本：计算各项评价指标"""

import os
import sys
import re
import logging

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

logger = logging.getLogger("reqdesign")

# 中英文实体名称映射表，用于模糊匹配
ENTITY_NAME_MAP = {
    # 通用
    "用户": ["User", "Account", "Member"],
    "管理员": ["Admin", "Administrator", "Manager"],
    "学生": ["Student"],
    "教师": ["Teacher", "Instructor", "Professor"],
    "图书": ["Book"],
    "订单": ["Order"],
    "商品": ["Product", "Goods", "Item"],
    "课程": ["Course"],
    "成绩": ["Grade", "Score"],
    "选课记录": ["Enrollment", "CourseSelection", "Selection"],
    "员工": ["Employee", "Staff", "Worker", "用户"],
    "会议室": ["MeetingRoom", "Room"],
    "预约记录": ["Reservation", "Booking", "Appointment", "预约"],
    "设备": ["Equipment", "Device", "Facility"],
    "顾客": ["Customer", "Client"],
    "商家": ["Merchant", "Seller", "Shop"],
    "平台管理员": ["PlatformAdmin", "Admin"],
    "购物车": ["Cart", "ShoppingCart"],
    "支付": ["Payment", "Pay"],
    "退款": ["Refund"],
    "医院": ["Hospital"],
    "挂号": ["Registration"],
    "医生": ["Doctor"],
    "病人": ["Patient"],
    "患者": ["Patient", "病人"],
    "号源": ["Source", "NumberSource"],
    "就诊记录": ["VisitRecord", "MedicalRecord"],
    "预约": ["Appointment", "Reservation"],
    "科室": ["Department"],
    "排班": ["Schedule", "Duty"],
    "借阅记录": ["BorrowRecord", "LendingRecord", "Loan"],
    "学期": ["Semester", "Term"],
}


def _fuzzy_match_entity(entity_name: str, target: str) -> bool:
    """模糊匹配实体名称，支持中英文映射"""
    entity_name = str(entity_name) if entity_name else ""
    target = str(target) if target else ""
    if not entity_name or not target:
        return False
    # 直接匹配
    if entity_name in target:
        return True

    # 查找英文映射
    en_names = ENTITY_NAME_MAP.get(entity_name, [])
    for en_name in en_names:
        if en_name in target:
            return True

    # 反向查找：target中包含中文名，entity_name是英文
    for cn, en_list in ENTITY_NAME_MAP.items():
        if cn in target:
            for en_name in en_list:
                if en_name in entity_name or entity_name in en_name:
                    return True

    return False


def _edit_distance(s1: str, s2: str) -> int:
    """计算两个字符串的编辑距离"""
    if len(s1) < len(s2):
        return _edit_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)
    prev = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        curr = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = prev[j + 1] + 1
            deletions = curr[j] + 1
            substitutions = prev[j] + (c1 != c2)
            curr.append(min(insertions, deletions, substitutions))
        prev = curr
    return prev[-1]


# 功能名称同义词映射
FUNCTION_SYNONYMS = {
    "用户注册": ["注册", "用户注册与登录", "注册与登录"],
    "用户登录": ["登录", "用户注册与登录", "注册与登录", "登录系统"],
    "图书搜索": ["搜索图书", "图书查询", "查询图书", "检索"],
    "图书借阅": ["借阅图书", "借书", "借阅"],
    "图书归还": ["归还图书", "还书", "归还"],
    "借阅管理": ["借阅记录管理", "图书借阅管理"],
    "图书管理": ["图书信息管理", "图书维护"],
    "选课": ["课程选择", "选择课程"],
    "退课": ["退选", "取消选课"],
    "课程发布": ["发布课程", "创建课程"],
    "课程审核": ["审核课程"],
    "成绩录入": ["录入成绩", "成绩管理"],
    "课表查看": ["查看课表", "课表查询"],
    "订单管理": ["查看订单", "订单查看"],
    "订单取消": ["取消订单"],
    "退款申请": ["申请退款"],
    "退款处理": ["处理退款", "退款审核"],
    "购物车管理": ["管理购物车"],
    "下单支付": ["下单", "支付", "下单与支付"],
    "商品浏览": ["浏览商品", "查看商品"],
    "用户注册与登录": ["注册", "登录", "用户注册", "用户登录"],
    "预约申请": ["提交预约", "发起预约"],
    "预约审批": ["审批预约", "审核预约"],
    "取消预约": ["预约取消"],
    "预约查看": ["查看预约", "预约查询"],
    "会议室管理": ["管理会议室"],
    "设备管理": ["管理设备"],
    "患者注册": ["注册", "患者注册与登录"],
    "科室浏览": ["浏览科室", "查看科室"],
    "医生查询": ["查询医生", "查看医生"],
    "排班管理": ["管理排班", "医生排班"],
    "预约挂号": ["挂号预约", "挂号"],
    "就诊管理": ["管理就诊"],
    "就诊记录": ["查看就诊记录"],
    "会议室浏览": ["浏览会议室", "查看会议室"],
    "预约管理": ["管理预约"],
    "挂号管理": ["管理挂号"],
}


def _fuzzy_match_function(func_name: str, result_functions: list[str], result_text: str) -> bool:
    """模糊匹配功能名称"""
    func_name = str(func_name) if func_name else ""
    if not func_name:
        return False
    # 1. 直接子串匹配
    if func_name in result_text:
        return True

    # 2. 关键词拆分匹配
    keywords = [kw for kw in re.split(r'[与和及、]', func_name) if len(kw) > 1]
    if len(keywords) >= 2 and all(kw in result_text for kw in keywords):
        return True

    # 3. 同义词匹配
    synonyms = FUNCTION_SYNONYMS.get(func_name, [])
    for syn in synonyms:
        if syn in result_text:
            return True
        # 也检查同义词是否在结果函数名中
        for rf in result_functions:
            if syn in rf or rf in syn:
                return True

    # 4. 对每个结果函数名做同义词反向匹配
    for rf in result_functions:
        rf_synonyms = FUNCTION_SYNONYMS.get(rf, [])
        if func_name in rf_synonyms:
            return True

    # 5. 编辑距离匹配（仅对较长字符串，避免短字符串误匹配）
    if len(func_name) >= 6:
        for rf in result_functions:
            if abs(len(func_name) - len(rf)) <= 2:
                dist = _edit_distance(func_name, rf)
                threshold = max(1, len(func_name) // 4)
                if dist <= threshold:
                    return True

    return False


def _match_constraint_or_exception(expected: str, target_text: str) -> bool:
    """匹配约束或异常：多级关键词匹配"""
    if not expected:
        return False
    # 1. 直接子串匹配
    if expected in target_text:
        return True

    # 2. 按分隔符和结构词拆分关键词（保留"不"等否定词在关键词中）
    keywords = re.split(r'[，,、;；（）()\s的时了后]', expected)
    keywords = [kw for kw in keywords if len(kw) >= 2]

    if not keywords:
        # 回退：按字符级别提取2-gram
        keywords = [expected[i:i+2] for i in range(len(expected)-1)]

    if not keywords:
        return False

    # 3. 全部关键词匹配
    if all(kw in target_text for kw in keywords):
        return True

    # 4. 多数关键词匹配（>=70%）
    matched = sum(1 for kw in keywords if kw in target_text)
    if len(keywords) >= 2 and matched / len(keywords) >= 0.7:
        return True

    # 5. 数字/量词匹配（如"30分钟"、"7天"、"6门"）
    numbers_in_expected = re.findall(r'\d+\s*[分天时月秒门]', expected)
    if numbers_in_expected and any(n in target_text for n in numbers_in_expected):
        return True

    # 6. 核心名词匹配（提取2-4字的名词片段）
    core_nouns = re.findall(r'[一-鿿]{2,4}', expected)
    core_nouns = [n for n in core_nouns if n not in ("系统", "时应", "提示", "后不")]
    if len(core_nouns) >= 2:
        noun_matched = sum(1 for n in core_nouns if n in target_text)
        if noun_matched / len(core_nouns) >= 0.5:
            return True

    return False


def score_requirement_coverage(result: dict, gold: dict) -> float:
    """
    计算需求覆盖率

    Args:
        result: 智能体输出的需求分析结果
        gold: 人工标注的gold label

    Returns:
        0-100的得分
    """
    if not result or not gold:
        return 0.0

    total_points = 0
    covered_points = 0

    # 检查角色覆盖
    expected_actors = gold.get("expected_actors", [])
    result_actors = [a.get("name", "") if isinstance(a, dict) else str(a) for a in (result.get("actors") or [])]
    for actor in expected_actors:
        total_points += 1
        if any(_fuzzy_match_entity(actor, ra) for ra in result_actors):
            covered_points += 1

    # 检查功能覆盖
    expected_functions = gold.get("expected_functions", [])
    result_functions = [f.get("name", "") if isinstance(f, dict) else str(f) for f in (result.get("functions") or [])]
    result_text = " ".join(result_functions)
    for func in expected_functions:
        total_points += 1
        if _fuzzy_match_function(func, result_functions, result_text):
            covered_points += 1

    # 检查实体覆盖
    expected_entities = gold.get("expected_entities", [])
    result_entities = [e.get("name", "") if isinstance(e, dict) else str(e) for e in (result.get("entities") or [])]
    for entity in expected_entities:
        total_points += 1
        if any(_fuzzy_match_entity(entity, res_ent) for res_ent in result_entities):
            covered_points += 1

    # 检查约束覆盖
    expected_constraints = gold.get("expected_constraints", [])
    result_constraints = [c.get("description", "") if isinstance(c, dict) else str(c) for c in (result.get("constraints") or [])]
    constraint_text = " ".join(result_constraints)
    for constraint in expected_constraints:
        total_points += 1
        if _match_constraint_or_exception(constraint, constraint_text):
            covered_points += 1

    # 检查异常流程覆盖
    expected_exceptions = gold.get("expected_exceptions", [])
    result_exceptions = [e.get("description", "") if isinstance(e, dict) else str(e) for e in (result.get("exceptions") or [])]
    exception_text = " ".join(result_exceptions)
    for exc in expected_exceptions:
        total_points += 1
        if _match_constraint_or_exception(exc, exception_text):
            covered_points += 1

    if total_points == 0:
        logger.warning("需求覆盖率: gold label无预期项，返回100（空标注）")
        return 100.0

    score = (covered_points / total_points) * 100
    logger.info(f"需求覆盖率: {covered_points}/{total_points} = {score:.1f}%")
    return round(score, 1)


def score_diagram_syntax(diagrams: dict) -> float:
    """
    计算图语法通过率

    Args:
        diagrams: {"class_diagram": "...", "activity_diagram": "...", "state_diagram": "..."}

    Returns:
        0-100的得分
    """
    if not diagrams:
        return 0.0

    from agent.mermaid_validator import MermaidValidator
    validator = MermaidValidator()

    total = len(diagrams)
    if total == 0:
        return 0.0

    passed = 0
    for name, content in diagrams.items():
        if not content or not isinstance(content, str):
            logger.warning(f"图语法校验跳过 [{name}]: 内容为空或非字符串")
            continue
        is_valid, msg = validator.validate(content, name)
        if is_valid:
            passed += 1
        else:
            logger.warning(f"图语法校验失败 [{name}]: {msg}")

    score = (passed / total) * 100
    logger.info(f"图语法通过率: {passed}/{total} = {score:.1f}%")
    return round(score, 1)


def score_entity_accuracy(result: dict, gold: dict) -> float:
    """
    计算实体识别准确率

    Args:
        result: 需求分析结果
        gold: gold label

    Returns:
        0-100的得分
    """
    if not result or not gold:
        return 0.0

    expected_entities = gold.get("expected_entities", [])
    result_entities = [e.get("name", "") if isinstance(e, dict) else str(e) for e in (result.get("entities") or [])]

    if not expected_entities:
        return 100.0

    correct = 0
    for entity in expected_entities:
        if any(_fuzzy_match_entity(entity, res_ent) for res_ent in result_entities):
            correct += 1

    score = (correct / len(expected_entities)) * 100
    logger.info(f"实体识别准确率: {correct}/{len(expected_entities)} = {score:.1f}%")
    return round(score, 1)


def score_process_completeness(diagrams: dict, gold: dict) -> float:
    """
    计算流程完整性（活动图是否覆盖主流程和异常流程）

    Args:
        diagrams: 图文件内容
        gold: gold label

    Returns:
        0-100的得分
    """
    if not diagrams:
        return 0.0
    if not gold:
        gold = {}

    activity = diagrams.get("activity_diagram", "")
    if not activity:
        return 0.0

    score = 0

    # 检查是否有开始和结束节点
    start_keywords = ["[开始]", "([开始])", "[*]", "([开始", "开始"]
    end_keywords = ["[结束]", "([结束])", "[*]", "([结束", "结束"]
    has_start = any(kw in activity for kw in start_keywords)
    has_end = any(kw in activity for kw in end_keywords)
    if has_start:
        score += 25
    if has_end:
        score += 25

    # 检查是否有判断节点（菱形语法：节点ID后跟{条件文本}）
    if re.search(r'\w+\s*\{[^}]+\}', activity):
        score += 25

    # 检查是否覆盖预期流程
    expected_processes = gold.get("expected_processes", [])
    if expected_processes:
        def _process_covered(proc_name: str, text: str) -> bool:
            keywords = [kw for kw in proc_name.split("流程") if kw.strip()]
            if not keywords:
                return proc_name in text
            return any(kw in text for kw in keywords)
        covered = sum(1 for p in expected_processes if _process_covered(p, activity))
        score += (covered / len(expected_processes)) * 25
    else:
        score += 25

    logger.info(f"流程完整性: {score:.1f}%")
    return round(score, 1)


def score_state_diagram(diagrams: dict, gold: dict) -> float:
    """
    计算状态图完整性（是否有开始/结束状态、转换、关键实体状态覆盖）

    Args:
        diagrams: 图文件内容
        gold: gold label

    Returns:
        0-100的得分
    """
    if not diagrams:
        return 0.0
    if not gold:
        gold = {}

    state = diagrams.get("state_diagram", "")
    if not state:
        return 0.0

    score = 0

    # 检查是否有 [*] 开始/结束标记（Mermaid stateDiagram-v2 标准）
    if "[*]" in state:
        score += 30
    # 也检查中文标记
    elif any(kw in state for kw in ["开始", "Start", "start"]):
        score += 30

    # 检查是否有状态转换箭头 (-->)
    if "-->" in state:
        score += 20

    # 检查状态数量（至少3个状态才算有意义）
    # 匹配带引号的状态名: state "Order Pending" as OP
    quoted_states = set(re.findall(r'state\s+"([^"]+)"', state))
    # 匹配不带引号的状态名: state Pending（排除带引号的）
    unquoted_states = set(re.findall(r'state\s+(?!"[\s])(\S+)', state))
    state_names = list(quoted_states | unquoted_states)
    # 匹配箭头两端的状态: A --> B
    arrow_states = re.findall(r'(\S+)\s*-->', state)
    arrow_states += re.findall(r'-->\s*(\S+)', state)
    all_states = set(state_names + arrow_states)
    # 排除 [*] 等特殊标记
    all_states = {s for s in all_states if s != "*" and len(s) > 1}
    if len(all_states) >= 3:
        score += 25
    elif len(all_states) >= 2:
        score += 15

    # 检查是否覆盖预期流程中的关键实体状态
    expected_processes = gold.get("expected_processes", [])
    if expected_processes:
        covered = 0
        for proc in expected_processes:
            keywords = [kw for kw in proc.split("流程") if kw.strip()]
            if not keywords:
                keywords = [proc]
            if any(kw in state for kw in keywords):
                covered += 1
        score += (covered / len(expected_processes)) * 25
    else:
        score += 25

    score = min(100, score)
    logger.info(f"状态图完整性: {score:.1f}%")
    return round(score, 1)


def score_consistency(result: dict, diagrams: dict) -> float:
    """
    计算一致性（类图、活动图、状态图之间是否矛盾）

    Args:
        result: 需求分析结果
        diagrams: 图文件内容

    Returns:
        0-100的得分
    """
    if not result:
        return 0.0
    if not diagrams:
        diagrams = {}

    score = 100.0

    # 检查实体名是否在类图中出现
    entities = [e.get("name", "") if isinstance(e, dict) else str(e) for e in (result.get("entities") or [])]
    class_diagram = diagrams.get("class_diagram", "")

    for entity in entities:
        if entity and not _fuzzy_match_entity(entity, class_diagram):
            score -= 10
            logger.warning(f"一致性问题: 实体 '{entity}' 未在类图中出现")

    # 检查核心实体对应的类是否在活动图和状态图中出现
    activity_diagram = diagrams.get("activity_diagram", "")
    state_diagram = diagrams.get("state_diagram", "")

    # 用需求中的实体名作为核心类（而非盲取前3个）
    if entities:
        core_classes = [e for e in entities if e][:3]
        if activity_diagram:
            for cls in core_classes:
                if not _fuzzy_match_entity(cls, activity_diagram):
                    score -= 5
        if state_diagram:
            for cls in core_classes:
                if not _fuzzy_match_entity(cls, state_diagram):
                    score -= 3

    score = max(0, score)
    logger.info(f"一致性: {score:.1f}%")
    return round(score, 1)


def compute_overall_score(
    requirement_coverage: float,
    diagram_syntax: float,
    entity_accuracy: float,
    process_completeness: float,
    consistency: float,
    state_diagram: float = 0.0,
) -> float:
    """计算综合得分"""
    overall = (
        requirement_coverage * 0.35
        + diagram_syntax * 0.20
        + entity_accuracy * 0.20
        + process_completeness * 0.10
        + state_diagram * 0.05
        + consistency * 0.10
    )
    logger.info(f"综合得分: {overall:.1f}")
    return round(overall, 1)


def compute_run_summary(results: list[dict]) -> dict:
    """计算多案例运行的汇总统计（供BenchmarkRunner和EvaluationManager共用）"""
    success = [r for r in results if r.get("status") == "success"]
    if not success:
        return {"passed": 0, "failed": 0, "error": len(results), "avg_scores": {}}

    passed = sum(1 for r in success if r.get("passed", False))
    failed = len(success) - passed
    error = len(results) - len(success)
    avg_scores = {}
    for metric in [
        "requirement_coverage", "diagram_syntax",
        "entity_accuracy", "process_completeness",
        "state_diagram", "consistency", "overall"
    ]:
        values = [(r.get("scores") or {}).get(metric, 0) for r in success]
        avg_scores[metric] = round(
            sum(values) / len(values), 1
        ) if values else 0

    return {
        "passed": passed,
        "failed": len(success) - passed,
        "error": len(results) - len(success),
        "avg_scores": avg_scores,
    }
