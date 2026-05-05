"""CLI入口：命令行接口"""

import argparse
import os
import sys

from agent.config import AgentConfig
from agent.logger import setup_logger
from governance.orchestrator import TaskOrchestrator
from governance.models import GovernanceConfig


def parse_args():
    parser = argparse.ArgumentParser(
        description="ReqDesign-Agent: 基于大语言模型的需求分析与系统设计智能体",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 生成完整设计结果
  python -m agent.main --task design --input requirements.md --output outputs/demo

  # 只生成需求分析结果
  python -m agent.main --task analyze --input requirements.md --output outputs/analyze

  # 治理模式
  python -m agent.main --task design --enable-governance --input requirements.md --output outputs/governed

  # Benchmark评估（--input为案例目录）
  python -m agent.main --benchmark --input benchmark/cases --output outputs/benchmark
        """,
    )
    parser.add_argument(
        "--task",
        choices=["analyze", "design"],
        default="design",
        help="任务类型: analyze(仅需求分析) 或 design(完整设计)",
    )
    parser.add_argument(
        "--input", "-i",
        required=True,
        help="输入需求文档路径（benchmark模式下为案例目录）",
    )
    parser.add_argument(
        "--output", "-o",
        default="outputs/",
        help="输出目录 (默认: outputs/)",
    )
    parser.add_argument(
        "--config", "-c",
        default="config.yaml",
        help="配置文件路径 (默认: config.yaml)",
    )
    parser.add_argument(
        "--model", "-m",
        help="覆盖配置中的模型名称",
    )
    parser.add_argument(
        "--provider", "-p",
        help="覆盖配置中的LLM provider",
    )
    parser.add_argument(
        "--max-retry",
        type=int,
        help="覆盖配置中的最大重试次数",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="日志级别 (默认: INFO)",
    )

    # 治理框架参数
    parser.add_argument(
        "--enable-governance",
        action="store_true",
        help="启用治理框架（阶段门控、追踪、修复控制等）",
    )
    parser.add_argument(
        "--mode",
        choices=["standard", "governed", "benchmark"],
        default="standard",
        help="运行模式: standard(默认), governed(治理模式), benchmark(基准评估)",
    )
    parser.add_argument(
        "--enable-trace",
        action="store_true",
        help="启用全链路追踪（需配合 --enable-governance）",
    )
    parser.add_argument(
        "--human-checkpoints",
        nargs="*",
        default=[],
        help="指定人工检查点阶段（如: requirement_analysis diagram_generation）",
    )
    parser.add_argument(
        "--benchmark",
        action="store_true",
        help="运行benchmark评估（--input应为案例目录，等价于 --mode benchmark）",
    )

    return parser.parse_args()


def main():
    args = parse_args()

    # 设置日志
    logger = setup_logger("reqdesign", args.log_level)
    logger.info("ReqDesign-Agent 启动")

    # 加载配置
    try:
        if os.path.exists(args.config):
            config = AgentConfig.load_from_yaml(args.config)
            logger.info(f"已加载配置: {args.config}")
        else:
            config = AgentConfig()
            logger.warning(f"配置文件不存在: {args.config}，使用默认配置")
    except Exception as e:
        logger.error(f"加载配置失败: {e}")
        sys.exit(1)

    # 命令行参数覆盖
    if args.model:
        config.llm.model = args.model
    if args.provider:
        config.llm.provider = args.provider
    if args.max_retry is not None:
        config.retry.max_retries = args.max_retry

    # 验证配置
    errors = config.validate()
    if errors:
        for err in errors:
            logger.error(f"配置错误: {err}")
        sys.exit(1)

    # 检查API密钥
    api_key = config.get_api_key()
    if not api_key:
        logger.error("未设置API密钥，请在配置文件中设置 api_key 或设置环境变量")
        sys.exit(1)

    # 判断运行模式
    use_governance = args.enable_governance or args.mode == "governed"
    use_benchmark = args.benchmark or args.mode == "benchmark"

    # 执行任务
    try:
        if use_benchmark:
            # Benchmark模式：--input应为案例目录
            if not os.path.isdir(args.input):
                logger.error(
                    f"Benchmark模式下 --input 必须为案例目录，"
                    f"当前: {args.input}"
                )
                sys.exit(1)

            from governance.evaluation_manager import EvaluationManager
            eval_mgr = EvaluationManager(config)
            result = eval_mgr.run_benchmark(
                args.input, output_dir=args.output
            )
            print(f"\nBenchmark完成！输出目录: {args.output}")

        elif use_governance:
            # 治理模式：从config._raw加载治理配置
            gov_config = GovernanceConfig.from_yaml_dict(config._raw)

            # 命令行覆盖
            if args.enable_trace:
                gov_config.trace_enabled = True
            if args.human_checkpoints:
                gov_config.human_checkpoints = args.human_checkpoints

            orchestrator = TaskOrchestrator(config, gov_config)

            # 检查输入文件
            if not os.path.exists(args.input):
                logger.error(f"输入文件不存在: {args.input}")
                sys.exit(1)

            if args.task == "analyze":
                result = orchestrator.run_analyze_task(args.input, args.output)
                logger.info("[Governed] 需求分析完成")
            elif args.task == "design":
                result = orchestrator.run_design_task(args.input, args.output)
                score = result.get("review", {}).get("overall_score", 0)
                logger.info(f"[Governed] 完整设计任务完成，综合得分: {score}")

            print(f"\n任务完成（治理模式）！输出目录: {args.output}")

        else:
            # 标准模式（使用TaskOrchestrator，不带治理配置）
            if not os.path.exists(args.input):
                logger.error(f"输入文件不存在: {args.input}")
                sys.exit(1)

            orchestrator = TaskOrchestrator(config)

            if args.task == "analyze":
                result = orchestrator.run_analyze_task(args.input, args.output)
                logger.info("需求分析完成")
            elif args.task == "design":
                result = orchestrator.run_design_task(args.input, args.output)
                score = result.get("review", {}).get("overall_score", 0)
                logger.info(f"完整设计任务完成，综合得分: {score}")

            print(f"\n任务完成！输出目录: {args.output}")

    except Exception as e:
        logger.error(f"任务执行失败: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
