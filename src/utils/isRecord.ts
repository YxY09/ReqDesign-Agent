/**
 * 类型守卫：检查值是否为纯对象（不为 null，不为数组）。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
