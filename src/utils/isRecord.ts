/**
 * Type guard: check if a value is a plain object (not null, not array).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
