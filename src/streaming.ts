/**
 * 流式输出工具 — 将 LLM 响应逐 token 打印到终端。
 *
 * 用异步友好的 TypeScript API 镜像 Python 的 `streaming.py` 模块。
 *
 * @module streaming
 */

import process from "node:process";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** {@link makeStreamPrinter} 返回的回调对。 */
export interface StreamPrinter {
  /** 对每个到来的文本块调用。 */
  onChunk(text: string): void;
  /** 流结束时调用一次。 */
  done(): void;
}

// ---------------------------------------------------------------------------
// 流式打印机
// ---------------------------------------------------------------------------

/**
 * 创建一个流式打印机，将文本块写入 `stdout` 并带有标签前缀
 *（类似于 Claude Code 的输出风格）。
 *
 * 首次调用 `onChunk` 时输出 `tag` 前缀。后续调用直接追加文本。
 * 如果至少打印了一个块，`done()` 会输出一个最终换行符。
 *
 * @param tag - 流式文本前显示的标签（如 `"[PlanningTool]"`）。
 * @returns 带有 `onChunk` 和 `done` 回调的 {@link StreamPrinter}。
 */
export function makeStreamPrinter(tag: string): StreamPrinter {
  let printed = false;

  const onChunk = (text: string): void => {
    if (!printed) {
      process.stdout.write(`  ${tag} `);
      printed = true;
    }
    try {
      process.stdout.write(text);
    } catch {
      // 忽略编码错误（如 Windows GBK 控制台上的 emoji）
    }
  };

  const done = (): void => {
    if (printed) {
      process.stdout.write("\n");
    }
  };

  return { onChunk, done };
}


