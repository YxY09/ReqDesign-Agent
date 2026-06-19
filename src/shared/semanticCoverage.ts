const DEFAULT_STOP_WORDS = new Set([
  "系统",
  "需要",
  "进行",
  "支持",
  "处理",
  "管理",
  "校验",
  "验证",
  "记录",
  "数据",
  "信息",
  "功能",
  "用户",
  "业务",
  "流程",
  "约束",
  "异常",
  "设计",
  "实现",
  "必须",
  "the",
  "and",
  "for",
  "with",
  "must",
  "should",
  "system",
  "user",
  "data",
  "process",
]);

export type SemanticCoverageState = "covered" | "missing" | "drifted";

export function tokenContains(text: string, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (/^[A-Za-z][A-Za-z0-9_]+$/.test(trimmed)) {
    return new RegExp(`\\b${escapeRx(trimmed)}\\b`).test(text);
  }
  return text.includes(trimmed);
}

export function semanticItemId(item: Record<string, unknown>): string {
  return String(item.displayId ?? item.id ?? item.constraintRef ?? item.exceptionRef ?? "").trim();
}

function semanticItemSource(
  item: Record<string, unknown>,
  fields: string[],
): string {
  return fields
    .map((field) => String(item[field] ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

export function semanticCoverageState(
  text: string,
  item: Record<string, unknown>,
  fields: string[],
): SemanticCoverageState {
  const windows = semanticWindowsForItem(text, item);
  if (windows.length === 0) return "missing";
  const source = semanticItemSource(item, fields);
  if (!source) return "covered";
  return windows.some((window) => semanticMatch(window, source)) ? "covered" : "drifted";
}

function semanticWindowsForItem(text: string, item: Record<string, unknown>): string[] {
  const ids = [
    String(item.displayId ?? item.constraintRef ?? item.exceptionRef ?? "").trim(),
    String(item.id ?? item.constraintRef ?? item.exceptionRef ?? "").trim(),
  ].filter(Boolean);
  if (ids.length === 0) return [];

  const lines = text.split(/\r?\n/);
  const windows: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!ids.some((id) => tokenContains(lines[i], id))) continue;
    windows.push(lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 3)).join("\n"));
  }
  return windows;
}

function semanticMatch(window: string, source: string): boolean {
  const terms = semanticTerms(source);
  if (terms.length === 0) return true;
  const normalizedWindow = normalizeSemanticText(window);
  const matched = terms.filter((term) => normalizedWindow.includes(normalizeSemanticText(term)));
  const required = terms.length <= 2 ? 1 : Math.min(3, Math.ceil(terms.length * 0.25));
  return matched.length >= required;
}

export function semanticTerms(text: string): string[] {
  const raw = String(text ?? "")
    .replace(/\b(?:F\d{3,4}|C\d{3,4}|[EX]\d{3,4}|FUN_[A-Za-z0-9_]+|CON_[A-Za-z0-9_]+|EXC_[A-Za-z0-9_]+)\b/g, " ");
  const terms = new Set<string>();

  for (const match of raw.matchAll(/[A-Za-z][A-Za-z0-9_]{2,}|\d+(?:\.\d+)?%?/g)) {
    const term = match[0].toLowerCase();
    if (!DEFAULT_STOP_WORDS.has(term)) terms.add(term);
  }

  for (const match of raw.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const phrase = match[0];
    if (phrase.length <= 4 && !DEFAULT_STOP_WORDS.has(phrase)) terms.add(phrase);
    for (let i = 0; i < phrase.length - 1; i++) {
      const gram = phrase.slice(i, i + 2);
      if (!DEFAULT_STOP_WORDS.has(gram)) terms.add(gram);
    }
  }

  return [...terms];
}

function normalizeSemanticText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s`'"“”‘’（）()【】\[\]{}<>:：,，.。;；、|/\\_-]+/g, "");
}

function escapeRx(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
