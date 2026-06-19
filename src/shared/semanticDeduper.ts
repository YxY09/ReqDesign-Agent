/**
 * Semantic Deduper — Generic deduplication with multi-layer matching.
 *
 * Architecture:
 *   1. Candidate pair generation (deterministic) — O(n²) comparison
 *   2. Deterministic merge rules (high confidence, no LLM)
 *
 * Deterministic merge layers:
 *   - same_source (score 1.0): normalized sourceText identical
 *   - normalized_text (score 1.0): normalized description identical
 *   - sourceText containment + keyword overlap ≥ 0.8 (score 1.0)
 *   - glossary_equiv (score 0.75): hit same glossary equivalence group with ≥2 terms
 *   - token_overlap (score = Jaccard, emitted when ≥ 0.6): word token similarity
 *
 * Deterministic merges are applied for score ≥ 0.8 (Union-Find).
 * Glossary_equiv at 0.75 is below the deterministic threshold, so it is used
 * as a candidate signal but does not merge by itself.
 *
 * NOTE (CJK tokenization limitation): The tokenize() function splits on whitespace
 * and removes punctuation. For CJK-only text (e.g. "审计数据不可修改"), the entire
 * string becomes a single token because CJK characters don't use spaces as word
 * boundaries. This means Jaccard similarity is always 0 or 1 for CJK-only text —
 * either the strings are identical or they share nothing. This is why glossary
 * matching is important for CJK deduplication, but must be conservative (≥2 term
 * requirement) to avoid false positives from short terms like "权限".
 */

import { jaccardSimilarity as jaccard } from "./testAlignment.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DedupConfig<T> {
  items: T[];
  getId: (item: T, index: number) => string;
  getText: (item: T) => string;
  getSourceText?: (item: T) => string;
  normalize?: (text: string) => string;
  glossary?: string[][];
}

export interface DedupCandidate {
  aId: string;
  bId: string;
  reason: "same_source" | "normalized_text" | "glossary_equiv" | "token_overlap";
  score: number;
}

export interface DedupResult<T> {
  kept: T[];
  merged: Array<{ survivors: T[]; absorbed: T[]; reason: string }>;
}

// ---------------------------------------------------------------------------
// Default glossary — bilingual equivalence groups
// ---------------------------------------------------------------------------

export const DEFAULT_GLOSSARY: string[][] = [
  ["ssl", "https", "secure transmission", "安全传输", "通信协议", "encrypted"],
  ["audit trail", "审计跟踪", "不可修改", "不可更改", "immutable", "unalterable"],
  ["unauthorized", "无权限", "未授权", "access denied", "access attempt", "权限"],
  ["ui customization", "interface customization", "界面定制", "用户界面自定义", "可定制"],
  ["lazy loading", "懒加载", "incremental loading", "渐进式加载"],
  ["context help", "上下文帮助", "help module", "在线帮助"],
  ["error message", "错误信息", "meaningful error", "actionable error", "有意义的错误"],
  ["persistent default", "持久化默认值", "saved preferences"],
  // Medical / hospital domain equivalence groups
  ["registration", "挂号", "预约挂号", "限号", "appointment"],
  ["prescription", "处方", "开药", "药品", "medication", "drug"],
  ["insurance", "医保", "保险", "退费", "refund", "billing"],
  ["doctor", "医生", "医师", "physician"],
  ["patient", "患者", "病人", "就诊人"],
  ["inventory", "库存", "入库", "出库", "stock"],
  ["schedule", "排班", "班次", "值班", "shift", "roster"],
  ["role based", "基于角色", "role specific", "角色特定"],
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall", "should",
  "may", "might", "must", "can", "could", "to", "of", "in", "for", "on", "with",
  "at", "by", "from", "as", "into", "through", "during", "before", "after",
  "above", "below", "between", "out", "off", "over", "under", "again", "further",
  "then", "once", "not", "no", "nor", "only", "own", "same", "so", "than", "too",
  "very", "and", "but", "or", "if", "any", "all", "each", "every", "both", "few",
  "more", "most", "other", "some", "such", "that", "this", "these", "those",
  "it", "its", "their", "they", "them", "we", "us", "our", "you", "your",
  "he", "him", "his", "she", "her", "which", "what", "when", "where", "who",
  "whom", "how", "why",
]);

class UnionFind {
  private parent: Map<string, string> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p !== x) {
      const root = this.find(p);
      this.parent.set(x, root);
    }
    return this.parent.get(x)!;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Find glossary group indices and matched terms for a text. */
function findGlossaryHits(text: string, glossary: string[][]): Map<number, Set<string>> {
  const lowerText = text.toLowerCase();
  const hits = new Map<number, Set<string>>();
  for (let i = 0; i < glossary.length; i++) {
    const matched = new Set<string>();
    for (const term of glossary[i]) {
      if (lowerText.includes(term.toLowerCase())) {
        matched.add(term.toLowerCase());
      }
    }
    if (matched.size > 0) {
      hits.set(i, matched);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/** Default normalizer: lowercase, strip punctuation, collapse whitespace. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokenize text into meaningful word tokens (stop words removed). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// ---------------------------------------------------------------------------
// Candidate pair generation
// ---------------------------------------------------------------------------

/**
 * Find duplicate candidate pairs among items using deterministic rules.
 * Only emits pairs with score ≥ 0.4.
 */
export function findDuplicateCandidates<T>(config: DedupConfig<T>): DedupCandidate[] {
  const {
    items,
    getId,
    getText,
    getSourceText,
    normalize = normalizeText,
    glossary = DEFAULT_GLOSSARY,
  } = config;

  const candidates: DedupCandidate[] = [];
  const n = items.length;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = items[i];
      const b = items[j];

      const aId = getId(a, i);
      const bId = getId(b, j);

      const aText = getText(a);
      const bText = getText(b);
      const aSource = getSourceText ? getSourceText(a) : "";
      const bSource = getSourceText ? getSourceText(b) : "";

      let bestScore = 0;
      let bestReason: DedupCandidate["reason"] = "token_overlap";

      // Rule 1: same_source — normalized sourceText identical
      if (aSource && bSource) {
        const normASource = normalize(aSource);
        const normBSource = normalize(bSource);
        if (normASource && normBSource && normASource === normBSource) {
          bestScore = 1.0;
          bestReason = "same_source";
        }
      }

      // Rule 2: normalized_text — normalized description identical
      if (bestScore < 1.0) {
        const normAText = normalize(aText);
        const normBText = normalize(bText);
        if (normAText && normBText && normAText === normBText) {
          bestScore = 1.0;
          bestReason = "normalized_text";
        }
      }

      // Rule 3: sourceText containment + keyword overlap ≥ 0.8
      if (bestScore < 1.0 && aSource && bSource) {
        const normASource = normalize(aSource);
        const normBSource = normalize(bSource);
        if (normASource && normBSource) {
          const contained =
            normASource.includes(normBSource) || normBSource.includes(normASource);
          if (contained) {
            const aTokens = new Set(tokenize(aText || aSource));
            const bTokens = new Set(tokenize(bText || bSource));
            const sim = jaccard(aTokens, bTokens);
            if (sim >= 0.8) {
              bestScore = 1.0;
              bestReason = "same_source";
            }
          }
        }
      }

      // Rule 4: glossary equivalence — both texts hit same glossary group
      // Requires ≥2 unique matched terms across both texts in a shared group
      // to prevent false positives from short CJK terms like "权限".
      // Score is 0.75 (below deterministic threshold of 0.8), so glossary hits
      // require confirmation from another layer (token overlap or LLM).
      if (bestScore < 0.75) {
        const combinedA = aText || aSource;
        const combinedB = bText || bSource;
        if (combinedA && combinedB) {
          const aHits = findGlossaryHits(combinedA, glossary);
          const bHits = findGlossaryHits(combinedB, glossary);
          let hasMultiTermMatch = false;
          for (const [groupIdx, aTerms] of aHits) {
            const bTerms = bHits.get(groupIdx);
            if (bTerms) {
              // Count unique terms matched across both texts
              const allTerms = new Set([...aTerms, ...bTerms]);
              if (allTerms.size >= 2) {
                hasMultiTermMatch = true;
                break;
              }
            }
          }
          if (hasMultiTermMatch) {
            bestScore = 0.75;
            bestReason = "glossary_equiv";
          }
        }
      }

      // Rule 5: token overlap — Jaccard similarity on word tokens
      if (bestScore < 0.6) {
        const combinedA = aText || aSource;
        const combinedB = bText || bSource;
        if (combinedA && combinedB) {
          const aTokens = new Set(tokenize(combinedA));
          const bTokens = new Set(tokenize(combinedB));
          const sim = jaccard(aTokens, bTokens);
          if (sim >= 0.6) {
            bestScore = sim;
            bestReason = "token_overlap";
          }
        }
      }

      // Only emit if score ≥ 0.4
      if (bestScore >= 0.4) {
        candidates.push({ aId, bId, reason: bestReason, score: bestScore });
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Deterministic merge
// ---------------------------------------------------------------------------

/**
 * Apply deterministic merges for candidate pairs with score ≥ 0.8.
 * Uses Union-Find for transitive grouping (A≈B, B≈C → A,B,C merged).
 */
export function applyDeterministicMerges<T>(
  items: T[],
  candidates: DedupCandidate[],
  config: DedupConfig<T>,
): DedupResult<T> {
  const { getId, getText } = config;

  if (items.length === 0) return { kept: [], merged: [] };
  if (items.length === 1) return { kept: [items[0]], merged: [] };

  const rawIds = items.map((item, index) => getId(item, index));
  const internalKeys = rawIds.map((id, index) => `${id}\u0000${index}`);
  const rawIdToKeys = new Map<string, string[]>();
  for (let i = 0; i < rawIds.length; i++) {
    const keys = rawIdToKeys.get(rawIds[i]) ?? [];
    keys.push(internalKeys[i]);
    rawIdToKeys.set(rawIds[i], keys);
  }

  const uniqueKeyForRawId = (id: string): string | undefined => {
    const keys = rawIdToKeys.get(id);
    return keys?.length === 1 ? keys[0] : undefined;
  };

  // Build internal ID → index map. Raw item IDs can collide across generation
  // groups, so never key merge state directly by getId().
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    idToIdx.set(internalKeys[i], i);
  }

  // Union-Find for high-confidence merges (score >= 0.8)
  const uf = new UnionFind();

  for (const c of candidates) {
    if (c.score < 0.8) continue;
    const aKey = uniqueKeyForRawId(c.aId);
    const bKey = uniqueKeyForRawId(c.bId);
    if (!aKey || !bKey) continue;
    uf.union(aKey, bKey);
  }

  // Collect groups: root → [ids]
  const groupMap = new Map<string, string[]>();
  for (let i = 0; i < items.length; i++) {
    const id = internalKeys[i];
    const root = uf.find(id);
    let group = groupMap.get(root);
    if (!group) {
      group = [];
      groupMap.set(root, group);
    }
    group.push(id);
  }

  // Find best reason for each merged group
  const groupReasons = new Map<string, string>();
  for (const c of candidates) {
    if (c.score >= 0.8) {
      const aKey = uniqueKeyForRawId(c.aId);
      const bKey = uniqueKeyForRawId(c.bId);
      if (!aKey || !bKey) continue;
      const root = uf.find(aKey);
      if (!groupReasons.has(root)) {
        groupReasons.set(root, c.reason);
      }
    }
  }

  const kept: T[] = [];
  const merged: Array<{ survivors: T[]; absorbed: T[]; reason: string }> = [];

  for (const ids of groupMap.values()) {
    if (ids.length === 1) {
      const idx = idToIdx.get(ids[0])!;
      kept.push(items[idx]);
    } else {
      // Sort by text length descending (longest = best survivor)
      const indices = ids.map((id) => idToIdx.get(id)!);
      indices.sort((a, b) => getText(items[b]).length - getText(items[a]).length);

      const survivorIdx = indices[0];
      const absorbedIndices = indices.slice(1);

      const root = uf.find(ids[0]);
      const reason = groupReasons.get(root) ?? "deterministic_merge";

      merged.push({
        survivors: [items[survivorIdx]],
        absorbed: absorbedIndices.map((idx) => items[idx]),
        reason,
      });
    }
  }

  return { kept, merged };
}

