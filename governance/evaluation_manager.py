"""效果评估管理器"""

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from agent.config import AgentConfig
from benchmark.run_benchmark import BenchmarkRunner
from benchmark.scorer import compute_run_summary

logger = logging.getLogger("reqdesign")


class EvaluationManager:
    """管理benchmark运行、评分对比、趋势分析"""

    def __init__(self, config: AgentConfig):
        self.config = config
        self.history: list[dict] = []

    def run_benchmark(self, cases_dir: str = "benchmark/cases",
                      gold_dir: str = "benchmark/gold_labels",
                      output_dir: str = "benchmark/results",
                      runs: int = 1) -> dict:
        """
        运行benchmark评估

        Args:
            cases_dir: 案例目录
            gold_dir: 标注目录
            output_dir: 结果输出目录
            runs: 运行次数（多次运行取平均，消除LLM随机性）

        Returns:
            评估报告
        """
        logger.info(f"开始benchmark评估，运行{runs}次")

        if runs < 1:
            raise ValueError("runs must be >= 1")

        all_reports = []
        for i in range(runs):
            if runs > 1:
                logger.info(f"第 {i+1}/{runs} 次运行")
                run_output = os.path.join(output_dir, f"run_{i+1}")
            else:
                run_output = output_dir

            runner = BenchmarkRunner(
                self.config, cases_dir, gold_dir, run_output
            )
            report = runner.run_all()
            all_reports.append(report)

        # 合并多次运行结果
        if runs > 1:
            merged = self._merge_runs(all_reports, output_dir)
        else:
            merged = all_reports[0]

        # 记录历史
        self.history.append({
            "timestamp": datetime.now().isoformat(),
            "runs": runs,
            "summary": merged.get("summary", {}),
        })

        return merged

    def _merge_runs(self, reports: list[dict],
                    output_dir: str) -> dict:
        """合并多次运行结果"""
        if not reports:
            return {}

        # 按案例名聚合
        case_scores: dict[str, list[dict]] = {}
        for report in reports:
            for result in report.get("results", []):
                name = result.get("case_name", "")
                if name not in case_scores:
                    case_scores[name] = []
                if result.get("status") == "success":
                    case_scores[name].append(result.get("scores", {}))

        # 计算每个案例的平均分
        avg_results = []
        for case_name, score_list in case_scores.items():
            if not score_list:
                avg_results.append({
                    "case_name": case_name,
                    "status": "error",
                    "scores": {m: 0.0 for m in [
                        "requirement_coverage", "diagram_syntax",
                        "entity_accuracy", "process_completeness",
                        "state_diagram", "consistency", "overall"
                    ]},
                    "passed": False,
                    "runs": 0,
                })
                continue

            avg_scores = {}
            metrics = [
                "requirement_coverage", "diagram_syntax",
                "entity_accuracy", "process_completeness",
                "state_diagram", "consistency", "overall"
            ]
            for metric in metrics:
                values = [s.get(metric, 0) for s in score_list]
                avg_scores[metric] = round(
                    sum(values) / len(values), 1
                ) if values else 0

            passed = avg_scores.get("overall", 0) >= 80
            avg_results.append({
                "case_name": case_name,
                "status": "success",
                "scores": avg_scores,
                "passed": passed,
                "runs": len(score_list),
            })

        # 汇总
        summary = self._compute_summary(avg_results)

        merged = {
            "run_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "total_runs": len(reports),
            "total_cases": len(avg_results),
            "results": avg_results,
            "summary": summary,
        }

        # 保存合并结果
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        report_path = os.path.join(output_dir, "benchmark_report.json")
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)

        return merged

    def _compute_summary(self, results: list[dict]) -> dict:
        """计算汇总（委托给scorer.compute_run_summary）"""
        return compute_run_summary(results)
