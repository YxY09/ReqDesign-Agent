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
        if func in result_text:
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
        # 部分匹配
        keywords = constraint.split("，")
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
    if "[开始]" in activity or "([开始])" in activity or "[*]" in activity:
        score += 25
    if "[结束]" in activity or "([结束])" in activity or "[*]" in activity:
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
