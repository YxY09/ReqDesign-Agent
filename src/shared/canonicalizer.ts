/**
 * Canonicalize & Link 模块
 *
 * Analyze 阶段的 ID 只是局部临时句柄。
 * 全局 canonicalId 在 Merge 之后由本模块统一分配。
 * displayId (F001/C001/X001) 给人看，canonicalId 给程序用。
 */

import {
  displayIdFromRecord,
  formatDisplayId,
  nextDisplayIdCounter,
} from "./idPolicy.js";
import { simpleHash } from "./hash.js";

export interface CanonicalMaps {
  functionMap: Map<string, string>;    // oldId/name → canonicalId
  constraintMap: Map<string, string>;  // oldId → canonicalId
  exceptionMap: Map<string, string>;   // oldId → canonicalId
}

/**
 * 对 Function/Constraint/Exception 分配全局 ID
 * Entity 和 Actor 保持 Registry ID 不动
 */
export function canonicalizeAndLink(merged: Record<string, unknown>): CanonicalMaps {
  const maps: CanonicalMaps = {
    functionMap: new Map(),
    constraintMap: new Map(),
    exceptionMap: new Map(),
  };

  // 1. Functions: preserve source display IDs, assign FUN_UPPER_SNAKE IDs
  canonicalizeFunctions(merged, maps);

  // 2. Constraints: 分配 CON_UPPER_SNAKE 格式
  canonicalizeConstraints(merged, maps);

  // 3. Exceptions: 分配 EXC_UPPER_SNAKE 格式
  canonicalizeExceptions(merged, maps);

  // 4. 解析引用：constraint.related_functions 等
  resolveReferences(merged, maps);

  return maps;
}

function canonicalizeFunctions(
  merged: Record<string, unknown>,
  maps: CanonicalMaps,
): void {
  const functions = asArray(merged["functions"]);
  if (!functions.length) return;

  const usedIds = new Set<string>();
  const preferredDisplayIds = functions
    .map((fn) => displayIdFromRecord(fn, "F"))
    .filter((id): id is string => Boolean(id));
  const usedDisplayIds = new Set<string>();
  let counter = nextDisplayIdCounter(preferredDisplayIds, 1);

  for (const fn of functions) {
    const name = String(fn.name ?? "").trim();
    if (!name) continue;

    let canonicalId = nameToCanonicalId("FUN", name);
    if (usedIds.has(canonicalId)) {
      let suffix = 2;
      while (usedIds.has(`${canonicalId}_${suffix}`)) suffix++;
      canonicalId = `${canonicalId}_${suffix}`;
    }
    usedIds.add(canonicalId);
    const preferred = displayIdFromRecord(fn, "F");
    const displayId = preferred && !usedDisplayIds.has(preferred)
      ? preferred
      : formatDisplayId("F", counter++);
    usedDisplayIds.add(displayId);

    // 映射：旧 ID、name → canonicalId
    const oldId = String(fn.id ?? "").trim();
    if (oldId) maps.functionMap.set(oldId, canonicalId);
    maps.functionMap.set(name, canonicalId);
    maps.functionMap.set(displayId, canonicalId);

    fn.id = canonicalId;
    fn.displayId = displayId;
  }
}

function canonicalizeConstraints(
  merged: Record<string, unknown>,
  maps: CanonicalMaps,
): void {
  const constraints = asArray(merged["constraints"]);
  if (!constraints.length) return;

  const preferredDisplayIds = constraints
    .map((c) => displayIdFromRecord(c, "C"))
    .filter((id): id is string => Boolean(id));
  const usedDisplayIds = new Set<string>();
  let counter = nextDisplayIdCounter(preferredDisplayIds, 1);

  const usedIds = new Set<string>();

  for (const c of constraints) {
    // Already processed by new ConstraintCanonicalizer — populate map and skip
    if (c.canonicalId && typeof c.canonicalId === "string") {
      const cid = String(c.canonicalId);
      const existingId = String(c.id ?? "").trim();
      if (existingId) maps.constraintMap.set(existingId, cid);
      const displayId = displayIdFromRecord(c, "C");
      if (displayId) maps.constraintMap.set(displayId, cid);
      usedIds.add(cid);
      continue;
    }

    const text = String(c.description ?? c.text ?? "").trim();
    if (!text) continue;

    let canonicalId = textToCanonicalId("CON", text);
    if (usedIds.has(canonicalId)) {
      let suffix = 2;
      while (usedIds.has(`${canonicalId}_${suffix}`)) suffix++;
      canonicalId = `${canonicalId}_${suffix}`;
    }
    usedIds.add(canonicalId);
    const preferred = displayIdFromRecord(c, "C");
    const displayId = preferred && !usedDisplayIds.has(preferred)
      ? preferred
      : formatDisplayId("C", counter++);
    usedDisplayIds.add(displayId);

    const oldId = String(c.id ?? "").trim();
    if (oldId) maps.constraintMap.set(oldId, canonicalId);
    maps.constraintMap.set(displayId, canonicalId);

    c.id = canonicalId;
    c.displayId = displayId;
  }
}

function canonicalizeExceptions(
  merged: Record<string, unknown>,
  maps: CanonicalMaps,
): void {
  const exceptions = asArray(merged["exceptions"]);
  if (!exceptions.length) return;

  const usedIds = new Set<string>();
  const preferredDisplayIds = exceptions
    .map((x) => displayIdFromRecord(x, "X"))
    .filter((id): id is string => Boolean(id));
  const usedDisplayIds = new Set<string>();
  let counter = nextDisplayIdCounter(preferredDisplayIds, 1);

  for (const x of exceptions) {
    const text = String(x.description ?? x.text ?? "").trim();
    if (!text) continue;

    let canonicalId = textToCanonicalId("EXC", text);
    if (usedIds.has(canonicalId)) {
      let suffix = 2;
      while (usedIds.has(`${canonicalId}_${suffix}`)) suffix++;
      canonicalId = `${canonicalId}_${suffix}`;
    }
    usedIds.add(canonicalId);
    const preferred = displayIdFromRecord(x, "X");
    const displayId = preferred && !usedDisplayIds.has(preferred)
      ? preferred
      : formatDisplayId("X", counter++);
    usedDisplayIds.add(displayId);

    const oldId = String(x.id ?? "").trim();
    if (oldId) maps.exceptionMap.set(oldId, canonicalId);
    maps.exceptionMap.set(displayId, canonicalId);

    x.id = canonicalId;
    x.displayId = displayId;
  }
}

/**
 * 解析所有引用：把旧 ID 替换为 canonicalId
 */
function resolveReferences(
  merged: Record<string, unknown>,
  maps: CanonicalMaps,
): void {
  // 1. Constraint 的 related_functions
  const constraints = asArray(merged["constraints"]);
  for (const c of constraints) {
    const related = c.related_functions;
    if (Array.isArray(related)) {
      c.related_functions = related.map((ref: unknown) => {
        const str = String(ref);
        return maps.functionMap.get(str) ?? str;
      });
    }
  }

  // 2. Exception 的 related_functions / related_constraints
  const exceptions = asArray(merged["exceptions"]);
  for (const x of exceptions) {
    const relatedFn = x.related_functions;
    if (Array.isArray(relatedFn)) {
      x.related_functions = relatedFn.map((ref: unknown) => {
        const str = String(ref);
        return maps.functionMap.get(str) ?? str;
      });
    }
    const relatedCon = x.related_constraints;
    if (Array.isArray(relatedCon)) {
      x.related_constraints = relatedCon.map((ref: unknown) => {
        const str = String(ref);
        return maps.constraintMap.get(str) ?? str;
      });
    }
  }

  // 3. NFR 的 related_constraints
  const nfrs = asArray(merged["non_functional_requirements"]);
  for (const nfr of nfrs) {
    const relatedCon = nfr.related_constraints;
    if (Array.isArray(relatedCon)) {
      nfr.related_constraints = relatedCon.map((ref: unknown) => {
        const str = String(ref);
        return maps.constraintMap.get(str) ?? str;
      });
    }
  }
}

// --- 工具函数 ---

function asArray(val: unknown): Record<string, unknown>[] {
  if (!Array.isArray(val)) return [];
  return val as Record<string, unknown>[];
}


/**
 * 用 name 生成 canonicalId
 * "SearchCase" → "FUN_SEARCH_CASE"
 * "RegisterComplaint" → "FUN_REGISTER_COMPLAINT"
 */
function nameToCanonicalId(prefix: string, name: string): string {
  // PascalCase → UPPER_SNAKE_CASE
  const snake = name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();
  return `${prefix}_${snake}`;
}

/**
 * 用描述文本生成 canonicalId
 * 取前几个关键词，避免过长
 * "审计跟踪数据不可修改或删除" → "CON_<hash>"
 * "Search response time should be under 8 seconds" → "CON_SEARCH_RESPONSE_TIME"
 */
function textToCanonicalId(prefix: string, text: string): string {
  // 如果是英文：提取关键名词，生成 UPPER_SNAKE
  if (/^[A-Za-z]/.test(text)) {
    const keyWords = extractEnglishKeyWords(text);
    if (keyWords.length > 0) {
      return `${prefix}_${keyWords.join("_")}`;
    }
  }
  // 如果是中文或无关键词：用文本的 hash 前 8 位
  const hash = simpleHash(text);
  return `${prefix}_${hash}`;
}

function extractEnglishKeyWords(text: string): string[] {
  // 取英文描述中的关键名词，去掉常见停用词
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will",
    "would", "could", "should", "may", "might", "must", "shall",
    "can", "need", "to", "of", "in", "for", "on", "with", "at",
    "by", "from", "as", "into", "through", "during", "before",
    "after", "above", "below", "between", "out", "off", "over",
    "under", "again", "further", "then", "once", "not", "no",
    "nor", "only", "own", "same", "so", "than", "too", "very",
    "and", "but", "or", "if", "any", "all", "each", "every",
    "both", "few", "more", "most", "other", "some", "such",
    "that", "this", "these", "those", "it", "its", "their",
    "they", "them", "we", "us", "our", "you", "your", "he",
    "him", "his", "she", "her", "which", "what", "when",
    "where", "who", "whom", "how", "why",
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  // 取前 4 个关键词，转为大写
  return words.slice(0, 4).map((w) => w.toUpperCase());
}
