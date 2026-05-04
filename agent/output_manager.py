"""输出管理模块：创建目录、写入文件、生成汇总报告"""

import json
import logging
import os
import re
from datetime import datetime

logger = logging.getLogger("reqdesign")

# 安全文件名白名单：只允许字母、数字、中文、下划线、连字符、点
_SAFE_NAME_RE = re.compile(r'^[\w一-鿿\-\.]+$')


def _sanitize_filename(name: str) -> str:
    """清理文件名，防止路径穿越"""
    # 移除路径分隔符
    name = name.replace("/", "_").replace("\\", "_")
    # 移除 ..
    name = name.replace("..", "_")
    # 如果不匹配白名单，强制清理
    if not _SAFE_NAME_RE.match(name):
        name = re.sub(r'[^\w一-鿿\-\.]', '_', name)
    return name


class OutputManager:
    """输出管理器：负责将各阶段结果写入文件"""

    def __init__(self, output_dir: str):
        self.output_dir = os.path.abspath(output_dir)
        os.makedirs(self.output_dir, exist_ok=True)
        logger.info(f"输出目录: {self.output_dir}")

    def _write_file(self, filename: str, content: str):
        """写入文本文件"""
        safe_name = _sanitize_filename(filename)
        path = os.path.join(self.output_dir, safe_name)
        # 二次校验：确保路径在输出目录内
        if not os.path.abspath(path).startswith(self.output_dir):
            logger.error(f"路径穿越拒绝: {filename}")
            raise ValueError(f"不安全的文件名: {filename}")
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            logger.debug(f"已写入: {path}")
        except (OSError, IOError) as e:
            logger.error(f"写入文件失败 {path}: {e}")
            raise

    def _write_json(self, filename: str, data: dict):
        """写入JSON文件"""
        safe_name = _sanitize_filename(filename)
        path = os.path.join(self.output_dir, safe_name)
        if not os.path.abspath(path).startswith(self.output_dir):
            logger.error(f"路径穿越拒绝: {filename}")
            raise ValueError(f"不安全的文件名: {filename}")
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            logger.debug(f"已写入: {path}")
        except (OSError, IOError) as e:
            logger.error(f"写入JSON文件失败 {path}: {e}")
            raise

    def save_requirement_analysis(self, requirement_json: dict, requirement_text: str = ""):
        """保存需求分析结果"""
        self._write_json("requirement_analysis.json", requirement_json)

        # 生成可读的Markdown版本
        md = self._generate_requirement_md(requirement_json)
        self._write_file("requirement_analysis.md", md)
        logger.info("需求分析结果已保存")

    def save_system_design(self, design_text: str):
        """保存系统设计说明"""
        self._write_file("system_design.md", design_text)
        logger.info("系统设计说明已保存")

    def save_diagrams(self, diagrams: dict):
        """保存Mermaid图文件"""
        for name, content in diagrams.items():
            self._write_file(f"{name}.mmd", content)
        logger.info(f"已保存 {len(diagrams)} 个图文件")

    def save_test_cases(self, test_cases: str):
        """保存测试用例"""
        self._write_file("test_cases.md", test_cases)
        logger.info("测试用例已保存")

    def save_review_report(self, review_report: str, review_result: dict = None):
        """保存审查报告"""
        self._write_file("review_report.md", review_report)
        if review_result:
            self._write_json("review_result.json", review_result)
        logger.info("审查报告已保存")

    def save_all(
        self,
        requirement_json: dict,
        requirement_text: str,
        design_text: str,
        diagrams: dict,
        test_cases: str,
        review_report: str,
        review_result: dict = None,
    ):
        """保存所有输出文件"""
        self.save_requirement_analysis(requirement_json, requirement_text)
        self.save_system_design(design_text)
        self.save_diagrams(diagrams)
        self.save_test_cases(test_cases)
        self.save_review_report(review_report, review_result)

        # 生成汇总报告
        self._generate_summary(requirement_json, review_result)
        logger.info(f"所有输出已保存到: {self.output_dir}")

    def _generate_requirement_md(self, req: dict) -> str:
        """生成需求分析的Markdown格式"""
        lines = ["# 需求分析说明\n"]

        if "project_name" in req:
            lines.append(f"## 项目名称\n{req['project_name']}\n")
        if "project_overview" in req:
            lines.append(f"## 项目概述\n{req['project_overview']}\n")

        # 角色
        actors = req.get("actors", [])
        if actors:
            lines.append("## 角色\n")
            lines.append("| 角色名称 | 描述 |")
            lines.append("|----------|------|")
            for a in actors:
                lines.append(f"| {a.get('name', '')} | {a.get('description', '')} |")
            lines.append("")

        # 功能
        functions = req.get("functions", [])
        if functions:
            lines.append("## 功能需求\n")
            lines.append("| 编号 | 名称 | 描述 | 相关角色 | 优先级 |")
            lines.append("|------|------|------|----------|--------|")
            for f in functions:
                actors_str = ", ".join(f.get("related_actors", []))
                lines.append(f"| {f.get('id', '')} | {f.get('name', '')} | {f.get('description', '')} | {actors_str} | {f.get('priority', '')} |")
            lines.append("")

        # 实体
        entities = req.get("entities", [])
        if entities:
            lines.append("## 核心实体\n")
            for e in entities:
                attrs = ", ".join(e.get("attributes", []))
                lines.append(f"### {e.get('name', '')}\n{e.get('description', '')}\n属性: {attrs}\n")

        # 约束
        constraints = req.get("constraints", [])
        if constraints:
            lines.append("## 业务约束\n")
            for c in constraints:
                lines.append(f"- **{c.get('id', '')}**: {c.get('description', '')}")
            lines.append("")

        # 异常流程
        exceptions = req.get("exceptions", [])
        if exceptions:
            lines.append("## 异常流程\n")
            for e in exceptions:
                lines.append(f"- **{e.get('id', '')}**: {e.get('description', '')} (触发: {e.get('trigger', '')}, 处理: {e.get('handling', '')})")
            lines.append("")

        # 非功能需求
        nfr = req.get("non_functional_requirements", [])
        if nfr:
            lines.append("## 非功能需求\n")
            for n in nfr:
                lines.append(f"- **{n.get('category', '')}**: {n.get('description', '')}")
            lines.append("")

        # 业务流程
        processes = req.get("business_processes", [])
        if processes:
            lines.append("## 业务流程\n")
            for p in processes:
                lines.append(f"### {p.get('name', '')}\n")
                lines.append(f"参与角色: {', '.join(p.get('actors', []))}\n")
                for i, step in enumerate(p.get("steps", []), 1):
                    lines.append(f"{i}. {step}")
                lines.append("")

        return "\n".join(lines)

    def _generate_summary(self, req: dict, review_result: dict = None):
        """生成汇总报告"""
        lines = ["# 设计任务汇总报告\n"]
        lines.append(f"生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

        # 需求统计
        lines.append("## 需求统计\n")
        lines.append(f"- 角色数: {len(req.get('actors', []))}")
        lines.append(f"- 功能数: {len(req.get('functions', []))}")
        lines.append(f"- 实体数: {len(req.get('entities', []))}")
        lines.append(f"- 约束数: {len(req.get('constraints', []))}")
        lines.append(f"- 异常流程数: {len(req.get('exceptions', []))}")
        lines.append("")

        # 审查结果
        if review_result:
            score = review_result.get("overall_score", 0)
            passed = review_result.get("overall_pass", False)
            lines.append("## 审查结果\n")
            lines.append(f"- 综合得分: {score}")
            lines.append(f"- 审查通过: {'是' if passed else '否'}")

            checks = review_result.get("checks", [])
            if checks:
                lines.append("\n### 各维度得分\n")
                for c in checks:
                    lines.append(f"- {c.get('dimension', '')}: {c.get('score', 0)}")
            lines.append("")

        # 输出文件列表
        lines.append("## 输出文件\n")
        for f in sorted(os.listdir(self.output_dir)):
            path = os.path.join(self.output_dir, f)
            if os.path.isfile(path):
                size = os.path.getsize(path)
                lines.append(f"- `{f}` ({size} bytes)")
        lines.append("")

        self._write_file("summary_report.md", "\n".join(lines))
