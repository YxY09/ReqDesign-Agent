"""日志配置模块"""

import os
import logging
from datetime import datetime


MAX_LOG_FILES = 20


def _cleanup_old_logs(log_dir: str, max_files: int):
    """清理旧日志文件，保留最近的max_files个"""
    try:
        files = sorted(
            [f for f in os.listdir(log_dir) if f.startswith("reqdesign_") and f.endswith(".log")],
        )
    except OSError:
        logging.getLogger("reqdesign").warning("旧日志目录访问失败，跳过清理")
        return
    while len(files) > max_files:
        oldest = files.pop(0)
        try:
            os.remove(os.path.join(log_dir, oldest))
        except OSError:
            logging.getLogger("reqdesign").warning(f"删除旧日志失败: {oldest}")


def setup_logger(
    name: str = "reqdesign",
    level: str = "INFO",
    log_dir: str = "logs/",
) -> logging.Logger:
    """创建统一日志器，同时输出到控制台和文件"""
    logger = logging.getLogger(name)
    if logger.handlers:
        logger.handlers.clear()

    logger.setLevel(getattr(logging, level.upper(), logging.INFO))

    formatter = logging.Formatter(
        "[%(asctime)s] %(levelname)s %(name)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # 控制台输出
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    # 文件输出
    os.makedirs(log_dir, exist_ok=True)
    _cleanup_old_logs(log_dir, MAX_LOG_FILES)
    date_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = os.path.join(log_dir, f"reqdesign_{date_str}.log")
    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    return logger
