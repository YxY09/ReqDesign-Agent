export type DisplayIdPrefix = "F" | "C" | "X";

export function isDisplayId(value: unknown, prefix?: DisplayIdPrefix): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  const pattern = prefix
    ? new RegExp(`^${prefix}\\d{3,4}$`)
    : /^(?:F|C|X)\d{3,4}$/;
  return pattern.test(text);
}

export function displayIdFromRecord(
  record: object | null | undefined,
  prefix: DisplayIdPrefix,
): string {
  if (!record) return "";
  const obj = record as Record<string, unknown>;
  for (const key of ["displayId", "id"]) {
    const value = String(obj[key] ?? "").trim();
    if (isDisplayId(value, prefix)) return value;
  }
  return "";
}

export function nextDisplayIdCounter(displayIds: string[], fallback = 1): number {
  const nums = displayIds
    .map((id) => Number.parseInt(id.slice(1), 10))
    .filter((n) => Number.isFinite(n));
  return nums.length > 0 ? Math.max(...nums) + 1 : fallback;
}

export function formatDisplayId(prefix: DisplayIdPrefix, counter: number): string {
  return `${prefix}${String(counter).padStart(3, "0")}`;
}
