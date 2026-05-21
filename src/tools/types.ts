/**
 * 标准化工具类型定义 — 各工具层共享。
 */

/** 工具的标准化错误结果 */
export interface ToolError {
  code: string;
  message: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}

/** 工具可声明的能力 */
export interface ToolCapabilities {
  readonly requiresLlm: boolean;
  readonly supportedTaskTypes: string[];
}

/** 工厂函数：创建带有 ToolError 扩展字段的 Error */
export function createToolError(
  code: string,
  message: string,
  options: { recoverable?: boolean; details?: Record<string, unknown> } = {}
): Error & ToolError {
  const error = Object.assign(new Error(message), {
    code,
    recoverable: options.recoverable ?? true,
    details: options.details ?? undefined,
  });
  return error as Error & ToolError;
}

/** 类型守卫：检查值是否为 ToolError */
export function isToolError(error: unknown): error is Error & ToolError {
  return (
    error instanceof Error &&
    typeof (error as Record<string, unknown>).code === "string" &&
    typeof (error as Record<string, unknown>).recoverable === "boolean"
  );
}
