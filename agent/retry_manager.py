"""重试管理器"""

import logging
import time
from typing import Callable, Any

logger = logging.getLogger("reqdesign")


class RetryManager:
    """失败重试管理器：最多重试N次，保留失败日志"""

    def __init__(self, max_retries: int = 3):
        self.max_retries = max_retries
        self.history: list[dict] = []

    def retry(self, func: Callable, *args, **kwargs) -> Any:
        """
        执行函数，失败时重试

        Args:
            func: 要执行的函数
            *args, **kwargs: 函数参数

        Returns:
            函数返回值

        Raises:
            最后一次重试仍失败时抛出异常
        """
        max_attempts = max(1, self.max_retries)
        last_error = None
        for attempt in range(1, max_attempts + 1):
            try:
                logger.info(f"执行尝试 {attempt}/{self.max_retries}")
                result = func(*args, **kwargs)
                if attempt > 1:
                    logger.info(f"第 {attempt} 次尝试成功")
                return result
            except Exception as e:
                last_error = e
                record = {
                    "attempt": attempt,
                    "error": str(e),
                    "error_type": type(e).__name__,
                }
                self.history.append(record)
                logger.warning(f"第 {attempt} 次尝试失败: {e}")

                if attempt < self.max_retries:
                    wait_time = min(2 ** attempt, 10)
                    logger.info(f"等待 {wait_time} 秒后重试...")
                    time.sleep(wait_time)

        logger.error(f"所有 {self.max_retries} 次尝试均失败")
        raise last_error

    def get_history(self) -> list[dict]:
        """获取重试历史"""
        return self.history.copy()

    def clear_history(self):
        """清空重试历史"""
        self.history.clear()

    def has_failures(self) -> bool:
        """是否有失败记录"""
        return len(self.history) > 0
