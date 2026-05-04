"""CLI入口：命令行接口"""

import argparse
import os
import sys

from agent.config import AgentConfig
from agent.logger import setup_logger
from agent.workflow_controller import WorkflowController


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

  # 指定配置文件和模型
  python -m agent.main --task design --input requirements.md --output outputs/demo --config config.yaml --model deepseek
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
        help="输入需求文档路径",
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

    # 检查输入文件
    if not os.path.exists(args.input):
        logger.error(f"输入文件不存在: {args.input}")
        sys.exit(1)

    # 检查API密钥
    api_key = config.get_api_key()
    if not api_key:
        logger.error("未设置API密钥，请在配置文件中设置 api_key 或设置环境变量")
        sys.exit(1)

    # 执行任务
    try:
        controller = WorkflowController(config)

        if args.task == "analyze":
            result = controller.run_analyze_task(args.input, args.output)
            logger.info("需求分析完成")
        elif args.task == "design":
            result = controller.run_design_task(args.input, args.output)
            score = result.get("review", {}).get("overall_score", 0)
            logger.info(f"完整设计任务完成，综合得分: {score}")

        print(f"\n任务完成！输出目录: {args.output}")

    except Exception as e:
        logger.error(f"任务执行失败: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
