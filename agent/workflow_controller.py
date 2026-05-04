"""工作流控制器：编排所有Agent，实现完整流水线"""

import logging
import json

from agent.config import AgentConfig
from agent.llm_client import LLMClient
from agent.input_loader import InputLoader
from agent.requirement_analyzer import RequirementAnalyzer
from agent.design_planner import DesignPlanner
from agent.diagram_generator import DiagramGenerator
from agent.test_case_generator import TestCaseGenerator
from agent.review_agent import ReviewAgent
from agent.output_manager import OutputManager

logger = logging.getLogger("reqdesign")


class WorkflowController:
    """工作流控制器：控制完整任务流，从输入到输出"""

    def __init__(self, config: AgentConfig):
        self.config = config
        self.llm = LLMClient(config)
        self.input_loader = InputLoader()
        self.requirement_analyzer = RequirementAnalyzer(self.llm)
        self.design_planner = DesignPlanner(self.llm)
        self.diagram_generator = DiagramGenerator(self.llm)
        self.test_case_generator = TestCaseGenerator(self.llm)
        self.review_agent = ReviewAgent(self.llm, max_retries=config.retry.max_retries)

    def run_analyze_task(self, input_path: str, output_dir: str) -> dict:
        """
        运行需求分析任务

        Args:
            input_path: 输入需求文档路径
            output_dir: 输出目录

        Returns:
            {"requirement_analysis": {...}}
        """
        logger.info(f"=== 开始需求分析任务 ===")
        logger.info(f"输入: {input_path}")
        logger.info(f"输出: {output_dir}")

        # 1. 读取输入
        requirement_text = self.input_loader.load(input_path)

        # 2. 需求分析
        req_json = self.requirement_analyzer.analyze(requirement_text)
        warnings = self.requirement_analyzer.validate_result(req_json)

        # 3. 保存输出
        output_mgr = OutputManager(output_dir)
        output_mgr.save_requirement_analysis(req_json, requirement_text)

        logger.info(f"=== 需求分析任务完成 ===")
        return {"requirement_analysis": req_json}

    def run_design_task(self, input_path: str, output_dir: str) -> dict:
        """
        运行完整设计任务（需求分析 → 设计 → 图生成 → 测试用例 → 审查）

        Args:
            input_path: 输入需求文档路径
            output_dir: 输出目录

        Returns:
            所有阶段的输出结果
        """
        logger.info(f"=== 开始完整设计任务 ===")
        logger.info(f"输入: {input_path}")
        logger.info(f"输出: {output_dir}")

        results = {}

        # 1. 读取输入
        logger.info("[1/6] 读取需求文档...")
        requirement_text = self.input_loader.load(input_path)

        # 2. 需求分析
        logger.info("[2/6] 需求分析...")
        req_json = self.requirement_analyzer.analyze(requirement_text)
        self.requirement_analyzer.validate_result(req_json)
        results["requirement_analysis"] = req_json

        # 3. 设计规划
        logger.info("[3/6] 设计规划...")
        design_text = self.design_planner.generate_design(req_json)
        self.design_planner.validate_design(design_text, req_json)
        results["system_design"] = design_text

        # 4. 图模型生成
        logger.info("[4/6] 图模型生成...")
        diagrams = self.diagram_generator.generate_all(req_json, design_text)
        results["diagrams"] = diagrams

        # 5. 测试用例生成
        logger.info("[5/6] 测试用例生成...")
        test_cases = self.test_case_generator.generate(req_json, design_text)
        self.test_case_generator.validate_test_cases(test_cases, req_json)
        results["test_cases"] = test_cases

        # 6. 审查与修复
        logger.info("[6/6] 审查与修复...")
        review_result, repaired_diagrams = self.review_agent.review_and_repair(
            req_json, design_text, diagrams
        )
        # 使用修复后的图
        results["diagrams"] = repaired_diagrams
        results["review"] = review_result

        # 生成审查报告
        review_report = self.review_agent.generate_report(review_result)
        results["review_report"] = review_report

        # 保存所有输出
        logger.info("保存输出文件...")
        output_mgr = OutputManager(output_dir)
        output_mgr.save_all(
            requirement_json=req_json,
            requirement_text=requirement_text,
            design_text=design_text,
            diagrams=repaired_diagrams,
            test_cases=test_cases,
            review_report=review_report,
            review_result=review_result,
        )

        score = review_result.get("overall_score", 0)
        passed = review_result.get("overall_pass", False)
        logger.info(f"=== 完整设计任务完成 === 综合得分: {score}, 通过: {passed}")

        return results
