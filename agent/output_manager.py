"""输出管理模块：创建目录、写入文件、生成汇总报告"""

import json
import logging
import os
import re
import tempfile
from datetime import datetime
from typing import Optional

logger = logging.getLogger("reqdesign")

# 安全文件名白名单：只允许字母、数字、中文、下划线、连字符、点
_SAFE_NAME_RE = re.compile(r'^[\w一-鿿\-\.]+$')


def _sanitize_filename(name: str) -> str:
    """清理文件名，防止路径穿越"""
    if not name or not name.strip():
        raise ValueError("文件名不能为空")
    # 移除路径分隔符
    name = name.replace("/", "_").replace("\\", "_")
    # 移除 ..
    name = name.replace("..", "_")
    # 如果不匹配白名单，强制清理
    if not _SAFE_NAME_RE.match(name):
        name = re.sub(r'[^\w一-鿿\-\.]', '_', name)
    # 限制文件名长度（留空间给扩展名）
    if len(name) > 200:
        name = name[:200]
    return name


class OutputManager:
    """输出管理器：负责将各阶段结果写入文件"""

    def __init__(self, output_dir: str):
        self.output_dir = os.path.realpath(output_dir)
        os.makedirs(self.output_dir, exist_ok=True)
        logger.info(f"输出目录: {self.output_dir}")

    def _write_file(self, filename: str, content: str):
        """写入文本文件"""
        safe_name = _sanitize_filename(filename)
        path = os.path.join(self.output_dir, safe_name)
        # 二次校验：确保路径在输出目录内（使用realpath防止符号链接逃逸）
        real_path = os.path.realpath(path)
        prefix = self.output_dir.rstrip(os.sep) + os.sep
        if real_path != self.output_dir and not real_path.startswith(prefix):
            logger.error(f"路径穿越拒绝: {filename}")
            raise ValueError(f"不安全的文件名: {filename}")
        try:
            # 原子写入：先写临时文件，再rename（防止崩溃导致文件损坏）
            fd, tmp_path = tempfile.mkstemp(dir=self.output_dir, suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(content)
                os.replace(tmp_path, path)
            except BaseException:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
            logger.debug(f"已写入: {path}")
        except (OSError, IOError) as e:
            logger.error(f"写入文件失败 {path}: {e}")
            raise

    def _write_json(self, filename: str, data: dict):
        """写入JSON文件"""
        safe_name = _sanitize_filename(filename)
        path = os.path.join(self.output_dir, safe_name)
        real_path = os.path.realpath(path)
        prefix = self.output_dir.rstrip(os.sep) + os.sep
        if real_path != self.output_dir and not real_path.startswith(prefix):
            logger.error(f"路径穿越拒绝: {filename}")
            raise ValueError(f"不安全的文件名: {filename}")
        try:
            fd, tmp_path = tempfile.mkstemp(dir=self.output_dir, suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                os.replace(tmp_path, path)
            except BaseException:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
            logger.debug(f"已写入: {path}")
        except (OSError, IOError) as e:
            logger.error(f"写入JSON文件失败 {path}: {e}")
            raise

    def save_requirement_analysis(self, requirement_json: dict, requirement_text: str = ""):
        """保存需求分析结果"""
        if not requirement_json:
            requirement_json = {}
        self._write_json("requirement_analysis.json", requirement_json)

        # 生成可读的Markdown版本
        md = self._generate_requirement_md(requirement_json)
        self._write_file("requirement_analysis.md", md)
        logger.info("需求分析结果已保存")

    def save_system_design(self, design_text: str):
        """保存系统设计说明"""
        self._write_file("system_design.md", design_text or "")
        logger.info("系统设计说明已保存")

    def save_diagrams(self, diagrams: dict):
        """保存Mermaid图文件"""
        if not diagrams:
            diagrams = {}
        for name, content in diagrams.items():
            self._write_file(f"{name}.mmd", content or "")
        logger.info(f"已保存 {len(diagrams)} 个图文件")

    def save_test_cases(self, test_cases: str):
        """保存测试用例"""
        self._write_file("test_cases.md", test_cases or "")
        logger.info("测试用例已保存")

    def save_review_report(self, review_report: str, review_result: Optional[dict] = None):
        """保存审查报告"""
        self._write_file("review_report.md", review_report or "")
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
        review_result: Optional[dict] = None,
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

    @staticmethod
    def _escape_md_cell(text: str) -> str:
        """转义Markdown表格单元格中的特殊字符"""
        if not text:
            return ""
        return str(text).replace("|", "\\|").replace("\n", " ")

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
                if isinstance(a, dict):
                    name = self._escape_md_cell(a.get('name', ''))
                    desc = self._escape_md_cell(a.get('description', ''))
                else:
                    name = self._escape_md_cell(str(a))
                    desc = ""
                lines.append(f"| {name} | {desc} |")
            lines.append("")

        # 功能
        functions = req.get("functions", [])
        if functions:
            lines.append("## 功能需求\n")
            lines.append("| 编号 | 名称 | 描述 | 相关角色 | 优先级 |")
            lines.append("|------|------|------|----------|--------|")
            for f in functions:
                if isinstance(f, dict):
                    actors_str = self._escape_md_cell(", ".join(str(x) for x in f.get("related_actors", [])))
                    fid = self._escape_md_cell(f.get('id', ''))
                    fname = self._escape_md_cell(f.get('name', ''))
                    fdesc = self._escape_md_cell(f.get('description', ''))
                    fpriority = self._escape_md_cell(f.get('priority', ''))
                else:
                    actors_str = ""
                    fid = ""
                    fname = self._escape_md_cell(str(f))
                    fdesc = ""
                    fpriority = ""
                lines.append(f"| {fid} | {fname} | {fdesc} | {actors_str} | {fpriority} |")
            lines.append("")

        # 实体
        entities = req.get("entities", [])
        if entities:
            lines.append("## 核心实体\n")
            for e in entities:
                if isinstance(e, dict):
                    attrs = self._escape_md_cell(", ".join(str(x) for x in e.get("attributes", [])))
                    ename = self._escape_md_cell(e.get('name', ''))
                    edesc = self._escape_md_cell(e.get('description', ''))
                else:
                    attrs = ""
                    ename = self._escape_md_cell(str(e))
                    edesc = ""
                lines.append(f"### {ename}\n{edesc}\n属性: {attrs}\n")

        # 约束
        constraints = req.get("constraints", [])
        if constraints:
            lines.append("## 业务约束\n")
            for c in constraints:
                if isinstance(c, dict):
                    lines.append(f"- **{self._escape_md_cell(c.get('id', ''))}**: {self._escape_md_cell(c.get('description', ''))}")
                else:
                    lines.append(f"- {self._escape_md_cell(str(c))}")
            lines.append("")

        # 异常流程
        exceptions = req.get("exceptions", [])
        if exceptions:
            lines.append("## 异常流程\n")
            for e in exceptions:
                if isinstance(e, dict):
                    lines.append(f"- **{self._escape_md_cell(e.get('id', ''))}**: {self._escape_md_cell(e.get('description', ''))} (触发: {self._escape_md_cell(e.get('trigger', ''))}, 处理: {self._escape_md_cell(e.get('handling', ''))})")
                else:
                    lines.append(f"- {self._escape_md_cell(str(e))}")
            lines.append("")

        # 非功能需求
        nfr = req.get("non_functional_requirements", [])
        if nfr:
            lines.append("## 非功能需求\n")
            for n in nfr:
                if isinstance(n, dict):
                    lines.append(f"- **{self._escape_md_cell(n.get('category', ''))}**: {self._escape_md_cell(n.get('description', ''))}")
                else:
                    lines.append(f"- {self._escape_md_cell(str(n))}")
            lines.append("")

        # 业务流程
        processes = req.get("business_processes", [])
        if processes:
            lines.append("## 业务流程\n")
            for p in processes:
                if isinstance(p, dict):
                    lines.append(f"### {self._escape_md_cell(p.get('name', ''))}\n")
                    lines.append(f"参与角色: {self._escape_md_cell(', '.join(str(x) for x in p.get('actors', [])))}\n")
                    for i, step in enumerate(p.get("steps", []), 1):
                        lines.append(f"{i}. {self._escape_md_cell(str(step))}")
                else:
                    lines.append(f"- {self._escape_md_cell(str(p))}")
                lines.append("")

        return "\n".join(lines)

    def _generate_summary(self, req: dict, review_result: Optional[dict] = None):
        """生成汇总报告"""
        if not req:
            req = {}
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
        try:
            for f in sorted(os.listdir(self.output_dir)):
                path = os.path.join(self.output_dir, f)
                if os.path.isfile(path):
                    try:
                        size = os.path.getsize(path)
                    except OSError:
                        size = 0
                    lines.append(f"- `{f}` ({size} bytes)")
        except OSError as e:
            lines.append(f"- （无法列出文件: {e}）")
        lines.append("")

        self._write_file("summary_report.md", "\n".join(lines))
