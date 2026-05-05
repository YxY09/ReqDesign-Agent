"""审查与修复智能体：检查输出质量并进行自动修复"""

import json
import logging

from agent.llm_client import LLMClient
from agent.mermaid_validator import MermaidValidator
from agent.prompt_loader import load_prompt
from agent.retry_manager import RetryManager

logger = logging.getLogger("reqdesign")


class ReviewAgent:
    """审查Agent：检查需求覆盖、图语法、模型一致性 + 自动修复"""

    def __init__(self, llm_client: LLMClient, max_retries: int = 3):
        self.llm = llm_client
        self.mermaid_validator = MermaidValidator()
        self.retry_manager = RetryManager(max_retries)
        self.prompt_template = load_prompt(
            "review.md",
            "请审查以下设计产物：\n\n{requirement_json}\n\n{design_text}",
        )

    def validate_mermaid_syntax(self, diagrams: dict) -> list[dict]:
        """校验所有Mermaid图的语法"""
        diagrams = diagrams or {}
        results = []
        for name, content in diagrams.items():
            is_valid, msg = self.mermaid_validator.validate(content, name)
            results.append({
                "diagram": name,
                "valid": is_valid,
                "message": msg,
            })
            if not is_valid:
                logger.warning(f"Mermaid语法错误 [{name}]: {msg}")
        return results

    def review(
        self,
        requirement_json: dict,
        design_text: str,
        diagrams: dict,
    ) -> dict:
        """
        审查所有设计产物

        Args:
            requirement_json: 需求分析结果
            design_text: 系统设计说明
            diagrams: {"class_diagram": "...", "activity_diagram": "...", "state_diagram": "..."}

        Returns:
            审查结果dict
        """
        diagrams = diagrams or {}
        if not requirement_json:
            requirement_json = {}
        design_text = design_text or ""
        logger.info("开始审查设计产物...")

        # 1. 先做Mermaid语法校验
        syntax_results = self.validate_mermaid_syntax(diagrams)
        syntax_pass = all(r["valid"] for r in syntax_results)

        # 2. 调用LLM进行语义审查
        requirement_summary = json.dumps(requirement_json, ensure_ascii=False, indent=2)
        prompt = self.prompt_template.replace("{requirement_json}", requirement_summary)
        prompt = prompt.replace("{design_text}", design_text)
        prompt = prompt.replace("{class_diagram}", diagrams.get("class_diagram", ""))
        prompt = prompt.replace("{activity_diagram}", diagrams.get("activity_diagram", ""))
        prompt = prompt.replace("{state_diagram}", diagrams.get("state_diagram", ""))

        system_msg = "你是一个资深的软件质量审查专家。只输出JSON格式的审查结果。"

        try:
            llm_review = self.llm.generate_json(prompt, system=system_msg)
        except Exception as e:
            logger.error(f"LLM审查失败: {e}", exc_info=True)
            llm_review = {
                "overall_score": 0,
                "overall_pass": False,
                "checks": [],
                "repair_actions": [],
            }

        # 3. 合并语法校验结果
        llm_review["syntax_check"] = syntax_results
        if not syntax_pass:
            llm_review["syntax_check"] = syntax_results
            # 降低整体分数
            if "overall_score" in llm_review:
                try:
                    llm_review["overall_score"] = max(0, float(llm_review["overall_score"]) - 20)
                except (TypeError, ValueError):
                    llm_review["overall_score"] = 0
            llm_review["overall_pass"] = False

        logger.info(f"审查完成，总分: {llm_review.get('overall_score', 0)}，通过: {llm_review.get('overall_pass', False)}")
        return llm_review

    def repair_diagram(self, diagram_name: str, diagram_content: str, error_info: str) -> str:
        """修复有语法错误的Mermaid图"""
        logger.info(f"尝试修复 {diagram_name}...")

        prompt = f"""请修复以下Mermaid图的语法错误。

## 原始代码
```mermaid
{diagram_content}
```

## 错误信息
{error_info}

## 要求
1. 只输出修复后的Mermaid代码
2. 不要改变图的业务含义
3. 确保语法正确，可以正常渲染
4. 不要输出任何解释文字"""

        system_msg = "你是一个Mermaid语法修复专家。只输出修复后的Mermaid代码，不要输出其他内容。"

        def do_repair():
            raw = self.llm.generate_text(prompt, system=system_msg)
            from agent.diagram_generator import DiagramGenerator
            return DiagramGenerator._extract_mermaid(raw, diagram_name)

        try:
            repaired = self.retry_manager.retry(do_repair)
            # 验证修复结果
            is_valid, msg = self.mermaid_validator.validate(repaired, diagram_name)
            if is_valid:
                logger.info(f"{diagram_name} 修复成功")
            else:
                logger.warning(f"{diagram_name} 修复后仍有问题: {msg}")
            return repaired
        except Exception as e:
            logger.error(f"{diagram_name} 修复失败: {e}", exc_info=True)
            return diagram_content  # 返回原始内容

    def review_and_repair(
        self,
        requirement_json: dict,
        design_text: str,
        diagrams: dict,
        max_repair_rounds: int = 2,
    ) -> tuple[dict, dict]:
        """
        审查并自动修复，支持多轮修复验证

        Returns:
            (review_result, repaired_diagrams)
        """
        diagrams = diagrams or {}
        # 审查
        review_result = self.review(requirement_json, design_text, diagrams)

        # 对语法有问题的图进行修复
        repaired = dict(diagrams)
        syntax_checks = review_result.get("syntax_check") or []

        diagrams_to_fix = [c for c in syntax_checks if not c["valid"]]
        if not diagrams_to_fix:
            return review_result, repaired

        for round_num in range(1, max_repair_rounds + 1):
            logger.info(f"修复轮次 {round_num}/{max_repair_rounds}")
            still_broken = []

            for check in diagrams_to_fix:
                name = check["diagram"]
                # 跳过空图表（生成失败的），浪费LLM调用
                if name in repaired and not repaired[name].strip():
                    logger.warning(f"{name} 内容为空，跳过修复")
                    still_broken.append(check)
                    continue
                if name in repaired:
                    repaired[name] = self.repair_diagram(
                        name, repaired[name], check["message"]
                    )
                    # 重新验证修复结果
                    is_valid, msg = self.mermaid_validator.validate(repaired[name], name)
                    if not is_valid:
                        still_broken.append({"diagram": name, "valid": False, "message": msg})
                        logger.warning(f"修复轮次 {round_num}: {name} 仍有语法问题: {msg}")
                    else:
                        logger.info(f"修复轮次 {round_num}: {name} 修复成功")

            if not still_broken:
                logger.info(f"所有图修复完成，共 {round_num} 轮")
                break
            diagrams_to_fix = still_broken

        # 更新审查结果中的语法检查
        final_syntax = self.validate_mermaid_syntax(repaired)
        review_result["syntax_check"] = final_syntax
        if all(r["valid"] for r in final_syntax):
            logger.info("修复后所有图语法校验通过")
        else:
            logger.warning("修复后仍有图语法校验未通过")

        return review_result, repaired

    def generate_report(self, review_result: dict) -> str:
        """生成可读的审查报告（Markdown格式）"""
        lines = ["# 设计审查报告\n"]

        score = review_result.get("overall_score", 0)
        passed = review_result.get("overall_pass", False)
        status = "通过" if passed else "未通过"
        lines.append(f"## 总评\n")
        lines.append(f"- 综合得分: **{score}**")
        lines.append(f"- 审查结果: **{status}**\n")

        # 各维度检查
        checks = review_result.get("checks", [])
        if checks:
            lines.append("## 各维度评分\n")
            lines.append("| 维度 | 得分 | 状态 | 问题 |")
            lines.append("|------|------|------|------|")
            for check in checks:
                dim = check.get("dimension", "")
                s = check.get("score", 0)
                p = "通过" if check.get("pass", False) else "未通过"
                issues = "; ".join(check.get("issues", [])) or "无"
                lines.append(f"| {dim} | {s} | {p} | {issues} |")
            lines.append("")

        # 语法检查
        syntax = review_result.get("syntax_check", [])
        if syntax:
            lines.append("## Mermaid语法检查\n")
            for s in syntax:
                status = "通过" if s["valid"] else "失败"
                lines.append(f"- **{s['diagram']}**: [{status}] {s['message']}")
            lines.append("")

        # 修复建议
        repairs = review_result.get("repair_actions", [])
        if repairs:
            lines.append("## 修复建议\n")
            for r in repairs:
                lines.append(f"- **{r.get('target', '')}** ({r.get('priority', '')}): {r.get('action', '')}")
            lines.append("")

        return "\n".join(lines)
