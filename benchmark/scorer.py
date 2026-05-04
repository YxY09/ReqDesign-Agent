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
    # 直接匹配
    if entity_name in target:
        return True

    # 查找英文映射
    en_names = ENTITY_NAME_MAP.get(entity_name, [])
    for en_name in en_names:
        if en_name in target:
            return True

    # 反向查找：target是中文，entity_name是英文
    for cn, en_list in ENTITY_NAME_MAP.items():
        if cn in entity_name:
            for en_name in en_list:
                if en_name in target:
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
}


def _fuzzy_match_function(func_name: str, result_functions: list[str], result_text: str) -> bool:
    """模糊匹配功能名称"""
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

    # 5. 编辑距离匹配（允许少量字符差异）
    for rf in result_functions:
        if abs(len(func_name) - len(rf)) <= 2:
            dist = _edit_distance(func_name, rf)
            threshold = max(1, len(func_name) // 4)
            if dist <= threshold:
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
    total_points = 0
    covered_points = 0

    # 检查角色覆盖
    expected_actors = gold.get("expected_actors", [])
    result_actors = [a.get("name", "") for a in result.get("actors", [])]
    for actor in expected_actors:
        total_points += 1
        if any(actor in ra for ra in result_actors):
            covered_points += 1

    # 检查功能覆盖
    expected_functions = gold.get("expected_functions", [])
    result_functions = [f.get("name", "") for f in result.get("functions", [])]
    result_text = " ".join(result_functions)
    for func in expected_functions:
        total_points += 1
        if _fuzzy_match_function(func, result_functions, result_text):
            covered_points += 1

    # 检查实体覆盖
    expected_entities = gold.get("expected_entities", [])
    result_entities = [e.get("name", "") for e in result.get("entities", [])]
    for entity in expected_entities:
        total_points += 1
        if any(_fuzzy_match_entity(entity, res_ent) for res_ent in result_entities):
            covered_points += 1

    # 检查约束覆盖
    expected_constraints = gold.get("expected_constraints", [])
    result_constraints = [c.get("description", "") for c in result.get("constraints", [])]
    constraint_text = " ".join(result_constraints)
    for constraint in expected_constraints:
        total_points += 1
        # 部分匹配：拆分为多个关键词
        keywords = re.split(r'[，,、;；]', constraint)
        if any(kw in constraint_text for kw in keywords if len(kw) > 2):
            covered_points += 1

    # 检查异常流程覆盖
    expected_exceptions = gold.get("expected_exceptions", [])
    result_exceptions = [e.get("description", "") for e in result.get("exceptions", [])]
    exception_text = " ".join(result_exceptions)
    for exc in expected_exceptions:
        total_points += 1
        if exc in exception_text:
            covered_points += 1
        else:
            # 关键词匹配
            keywords = [kw for kw in re.split(r'[，,、;；的时]', exc) if len(kw) > 1]
            if len(keywords) >= 2 and all(kw in exception_text for kw in keywords):
                covered_points += 1

    if total_points == 0:
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
    from agent.mermaid_validator import MermaidValidator
    validator = MermaidValidator()

    total = len(diagrams)
    if total == 0:
        return 0.0

    passed = 0
    for name, content in diagrams.items():
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
    expected_entities = gold.get("expected_entities", [])
    result_entities = [e.get("name", "") for e in result.get("entities", [])]

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
    activity = diagrams.get("activity_diagram", "")
    if not activity:
        return 0.0

    score = 0

    # 检查是否有开始和结束节点
    has_start = any(kw in activity for kw in ["[开始]", "([开始])", "[*]", "([开始"])
    # 也识别以([开头的起始节点（如 ([患者发起预约])）
    if not has_start:
        has_start = bool(re.search(r"\(\[.{2,10}\]\)", activity[:200]))
    if has_start:
        score += 25

    has_end = any(kw in activity for kw in ["[结束]", "([结束])", "[*]", "([结束"])
    if not has_end:
        has_end = bool(re.search(r"\(\[.{2,10}\]\)", activity[-200:]))
    if has_end:
        score += 25

    # 检查是否有判断节点（菱形）
    if "{" in activity and "}" in activity:
        score += 25

    # 检查是否覆盖预期流程
    expected_processes = gold.get("expected_processes", [])
    if expected_processes:
        covered = sum(1 for p in expected_processes if any(kw in activity for kw in p.split("流程")))
        score += (covered / len(expected_processes)) * 25
    else:
        score += 25

    logger.info(f"流程完整性: {score:.1f}%")
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
    score = 100.0

    # 检查实体名是否在类图中出现
    entities = [e.get("name", "") for e in result.get("entities", [])]
    class_diagram = diagrams.get("class_diagram", "")

    for entity in entities:
        if entity and not _fuzzy_match_entity(entity, class_diagram):
            score -= 10
            logger.warning(f"一致性问题: 实体 '{entity}' 未在类图中出现")

    # 检查类图中的类名是否在活动图中出现
    # 提取类图中的类名
    class_names = re.findall(r"class\s+(\w+)", class_diagram)
    activity_diagram = diagrams.get("activity_diagram", "")

    # 不是所有类都需要在活动图中出现，但核心类应该出现
    if class_names and activity_diagram:
        core_classes = class_names[:3]  # 取前3个作为核心类
        for cls in core_classes:
            if cls not in activity_diagram:
                score -= 5

    score = max(0, score)
    logger.info(f"一致性: {score:.1f}%")
    return round(score, 1)


def compute_overall_score(
    requirement_coverage: float,
    diagram_syntax: float,
    entity_accuracy: float,
    process_completeness: float,
    consistency: float,
) -> float:
    """计算综合得分"""
    overall = (
        requirement_coverage * 0.40
        + diagram_syntax * 0.20
        + entity_accuracy * 0.20
        + process_completeness * 0.10
        + consistency * 0.10
    )
    logger.info(f"综合得分: {overall:.1f}")
    return round(overall, 1)
