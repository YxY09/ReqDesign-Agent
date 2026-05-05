"""基准测试运行器：批量运行案例并统计指标"""

import argparse
import json
import os
import sys
import logging
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.config import AgentConfig
from agent.logger import setup_logger
from governance.orchestrator import TaskOrchestrator
from benchmark.scorer import (
    score_requirement_coverage,
    score_diagram_syntax,
    score_entity_accuracy,
    score_process_completeness,
    score_state_diagram,
    score_consistency,
    compute_overall_score,
    compute_run_summary,
)


class BenchmarkRunner:
    """基准测试运行器"""

    def __init__(self, config: AgentConfig, cases_dir: str, gold_dir: str, output_dir: str):
        self.config = config
        self.cases_dir = cases_dir
        self.gold_dir = gold_dir
        self.output_dir = output_dir
        self.logger = logging.getLogger("reqdesign")

    def find_cases(self) -> list[dict]:
        """查找所有测试案例"""
        if not os.path.isdir(self.cases_dir):
            raise FileNotFoundError(f"案例目录不存在: {self.cases_dir}")
        if not os.path.isdir(self.gold_dir):
            raise FileNotFoundError(f"标注目录不存在: {self.gold_dir}")
        cases = []
        for f in sorted(os.listdir(self.cases_dir)):
            if f.endswith(".md"):
                case_path = os.path.join(self.cases_dir, f)
                case_name = f.replace(".md", "")
                gold_path = os.path.join(self.gold_dir, f"{case_name}.json")

                if os.path.exists(gold_path):
                    cases.append({
                        "name": case_name,
                        "case_path": case_path,
                        "gold_path": gold_path,
                    })
                else:
                    self.logger.warning(f"案例 {case_name} 缺少gold label文件")

        self.logger.info(f"找到 {len(cases)} 个测试案例")
        return cases

    def run_case(self, case: dict) -> dict:
        """运行单个案例"""
        self.logger.info(f"{'='*50}")
        self.logger.info(f"运行案例: {case['name']}")
        self.logger.info(f"{'='*50}")

        case_output_dir = os.path.join(self.output_dir, case["name"])

        # 加载gold label
        try:
            with open(case["gold_path"], "r", encoding="utf-8") as f:
                gold = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            self.logger.error(f"案例 {case['name']} gold label加载失败: {e}")
            return {
                "case_name": case["name"],
                "status": "error",
                "error": f"gold label加载失败: {e}",
                "scores": {},
            }

        # 运行智能体（使用TaskOrchestrator）
        orchestrator = TaskOrchestrator(self.config)
        try:
            result = orchestrator.run_design_task(case["case_path"], case_output_dir)
        except Exception as e:
            self.logger.error(f"案例 {case['name']} 运行失败: {e}", exc_info=True)
            return {
                "case_name": case["name"],
                "status": "error",
                "error": str(e),
                "scores": {},
            }

        # 提取结果
        req_result = result.get("requirement_analysis", {})
        diagrams = result.get("diagrams", {})

        # 计算各项得分（评分异常不阻塞整个批次）
        try:
            scores = {}
            scores["requirement_coverage"] = score_requirement_coverage(req_result, gold)
            scores["diagram_syntax"] = score_diagram_syntax(diagrams)
            scores["entity_accuracy"] = score_entity_accuracy(req_result, gold)
            scores["process_completeness"] = score_process_completeness(diagrams, gold)
            scores["state_diagram"] = score_state_diagram(diagrams, gold)
            scores["consistency"] = score_consistency(req_result, diagrams)
            scores["overall"] = compute_overall_score(
                requirement_coverage=scores["requirement_coverage"],
                diagram_syntax=scores["diagram_syntax"],
                entity_accuracy=scores["entity_accuracy"],
                process_completeness=scores["process_completeness"],
                consistency=scores["consistency"],
                state_diagram=scores["state_diagram"],
            )
        except Exception as e:
            self.logger.error(f"案例 {case['name']} 评分失败: {e}", exc_info=True)
            return {
                "case_name": case["name"],
                "status": "scoring_error",
                "error": str(e),
                "scores": {},
            }

        passed = scores["overall"] >= 80
        self.logger.info(f"案例 {case['name']} 得分: {scores['overall']}, {'通过' if passed else '未通过'}")

        return {
            "case_name": case["name"],
            "status": "success",
            "scores": scores,
            "passed": passed,
        }

    def run_all(self) -> dict:
        """运行所有案例"""
        cases = self.find_cases()
        if not cases:
            self.logger.error("未找到测试案例")
            return {
                "run_time": "",
                "total_cases": 0,
                "results": [],
                "summary": {"passed": 0, "failed": 0, "error": 0, "avg_scores": {}},
            }

        results = []
        for case in cases:
            result = self.run_case(case)
            results.append(result)

        # 汇总统计
        summary = self._compute_summary(results)

        # 保存结果
        report = {
            "run_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "total_cases": len(cases),
            "results": results,
            "summary": summary,
        }

        report_path = os.path.join(self.output_dir, "benchmark_report.json")
        os.makedirs(self.output_dir, exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)

        # 生成Markdown报告
        md_report = self._generate_md_report(report)
        md_path = os.path.join(self.output_dir, "benchmark_report.md")
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(md_report)

        self.logger.info(f"基准测试完成，结果保存到: {self.output_dir}")
        return report

    def _compute_summary(self, results: list[dict]) -> dict:
        """计算汇总统计（委托给scorer.compute_run_summary）"""
        return compute_run_summary(results)

    def _generate_md_report(self, report: dict) -> str:
        """生成Markdown格式的报告"""
        lines = ["# 基准测试报告\n"]
        lines.append(f"运行时间: {report['run_time']}\n")
        lines.append(f"总案例数: {report['total_cases']}\n")

        summary = report.get("summary", {})
        lines.append(f"## 汇总\n")
        lines.append(f"- 通过: {summary.get('passed', 0)}")
        lines.append(f"- 未通过: {summary.get('failed', 0)}")
        lines.append(f"- 错误: {summary.get('error', 0)}")

        avg = summary.get("avg_scores", {})
        if avg:
            lines.append(f"\n## 平均得分\n")
            lines.append("| 指标 | 得分 |")
            lines.append("|------|------|")
            lines.append(f"| 需求覆盖率 | {avg.get('requirement_coverage', 0)} |")
            lines.append(f"| 图语法通过率 | {avg.get('diagram_syntax', 0)} |")
            lines.append(f"| 实体识别准确率 | {avg.get('entity_accuracy', 0)} |")
            lines.append(f"| 流程完整性 | {avg.get('process_completeness', 0)} |")
            lines.append(f"| 状态图完整性 | {avg.get('state_diagram', 0)} |")
            lines.append(f"| 一致性 | {avg.get('consistency', 0)} |")
            lines.append(f"| **综合得分** | **{avg.get('overall', 0)}** |")

        lines.append(f"\n## 各案例详情\n")
        lines.append("| 案例 | 状态 | 需求覆盖 | 图语法 | 实体准确 | 流程完整 | 状态图 | 一致性 | 综合 | 通过 |")
        lines.append("|------|------|----------|--------|----------|----------|--------|--------|------|------|")

        for r in report.get("results", []):
            name = r["case_name"]
            status = r["status"]
            if status == "success":
                s = r["scores"]
                passed = "是" if r.get("passed") else "否"
                lines.append(f"| {name} | {status} | {s.get('requirement_coverage', 0)} | {s.get('diagram_syntax', 0)} | {s.get('entity_accuracy', 0)} | {s.get('process_completeness', 0)} | {s.get('state_diagram', 0)} | {s.get('consistency', 0)} | {s.get('overall', 0)} | {passed} |")
            else:
                lines.append(f"| {name} | {status} | - | - | - | - | - | - | - | - |")

        lines.append("")
        return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="运行基准测试")
    parser.add_argument("--cases", default="benchmark/cases", help="案例目录")
    parser.add_argument("--gold", default="benchmark/gold_labels", help="Gold label目录")
    parser.add_argument("--output", default="benchmark/results", help="结果输出目录")
    parser.add_argument("--config", default="config.yaml", help="配置文件")
    parser.add_argument("--model", help="覆盖模型名称")
    parser.add_argument("--provider", help="覆盖provider")
    parser.add_argument("--log-level", default="INFO", help="日志级别")
    args = parser.parse_args()

    setup_logger("reqdesign", args.log_level)

    # 加载配置
    if os.path.exists(args.config):
        config = AgentConfig.load_from_yaml(args.config)
    else:
        config = AgentConfig()

    if args.model:
        config.llm.model = args.model
    if args.provider:
        config.llm.provider = args.provider

    # 运行基准测试
    runner = BenchmarkRunner(config, args.cases, args.gold, args.output)
    report = runner.run_all()

    # 打印汇总
    summary = report.get("summary", {})
    print(f"\n{'='*50}")
    print(f"基准测试完成")
    print(f"通过: {summary.get('passed', 0)}/{report['total_cases']}")
    print(f"平均综合得分: {summary.get('avg_scores', {}).get('overall', 0)}")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
