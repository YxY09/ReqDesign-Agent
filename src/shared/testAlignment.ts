/**
 * Target-content alignment helper — detects test cases whose target ID is
 * valid but whose steps/expected_result verify a *different* rule than the
 * one the constraint actually states (a "hallucinated" test).
 *
 * Used by both the generation-time TestQualityValidator and the pre-review
 * ReviewValidator gate so the two agree on the algorithm.
 *
 * Algorithm:
 *   1. Resolve each target constraint ID to its source_text.
 *   2. Tokenize both the constraint source_text and the test content
 *      (title + steps + expected_result) into domain content terms:
 *        - CJK character bigrams (e.g. 挂号 -> 挂号, 号约) so Chinese rules
 *          are comparable without a word segmenter.
 *        - English word tokens (stop words removed).
 *   3. Compute Jaccard similarity. When a known constraint ID is referenced
 *      but the overlap is 0 (no shared content term at all), the test is
 *      considered misaligned.
 */

const ALIGNMENT_STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall", "should",
  "may", "might", "must", "can", "could", "to", "of", "in", "for", "on", "with",
  "at", "by", "from", "as", "and", "or", "if", "any", "all", "each", "test",
  "step", "result", "expected", "case", "system", "user", "input", "check",
  "verify", "ensure", "when", "then", "that", "this", "it", "its", "their",
  "should", "must", "value", "data", "field",
]);

/** Minimum overlap (Jaccard) below which an otherwise-referenced test is rejected. */
const TARGET_ALIGNMENT_REJECT_THRESHOLD = 0;

/**
 * Whether the target_content_alignment check hard-rejects (false) or only
 * warns (true). Defaults to warn-only so the threshold can be calibrated on
 * real corpora before flipping. Flip to `false` once calibration confirms no
 * false positives.
 *
 * TODO(decision-gate): before flipping this to `false`, gather a calibration
 * corpus and confirm the Jaccard reject threshold (TARGET_ALIGNMENT_REJECT_
 * THRESHOLD) produces no false positives on legitimate low-overlap tests.
 * Record the flip decision + date + evidence here. Do NOT flip immediately.
 */
export const TARGET_ALIGNMENT_WARN_ONLY = true;

/** Jaccard similarity between two sets. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  const unionSize = new Set([...a, ...b]).size;
  return unionSize > 0 ? inter / unionSize : 0;
}

/**
 * Tokenize text into domain content terms:
 *   - CJK character bigrams (consecutive CJK chars → overlapping pairs)
 *   - ASCII word tokens (lowercased, stop words removed, length > 1)
 *
 * CJK is handled explicitly because the shared semanticDeduper.tokenize()
 * collapses an unsegmented CJK string into one token, which makes Jaccard
 * useless for Chinese constraint text.
 */
export function extractContentTerms(text: string): Set<string> {
  const terms = new Set<string>();
  if (!text) return terms;

  // CJK bigrams over each maximal CJK run. Bigrams (not single chars) are
  // the signal: an incidental shared single character like 天 is too weak to
  // indicate content alignment, so runs of length 1 contribute nothing.
  const cjkRuns = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) {
      terms.add(run.slice(i, i + 2));
    }
  }

  // ASCII word tokens.
  const asciiTokens = text.toLowerCase().match(/[a-z][a-z0-9_]{1,}/g) ?? [];
  for (const tok of asciiTokens) {
    if (!ALIGNMENT_STOP_WORDS.has(tok)) terms.add(tok);
  }

  return terms;
}

/**
 * Build a map of constraint displayId/canonicalId -> source_text from the
 * analysis constraints array. Falls back to `description` when source_text
 * is absent.
 */
export function collectConstraintSourceTexts(
  analysis: Record<string, unknown>,
): Map<string, string> {
  const map = new Map<string, string>();
  const constraints = analysis["constraints"];
  if (!Array.isArray(constraints)) return map;
  for (const con of constraints) {
    if (typeof con !== "object" || con === null) continue;
    const rec = con as Record<string, unknown>;
    const text = [
      rec.source_text,
      rec.sourceText,
      rec.description,
      rec.canonicalRuleEn,
    ].map((value) => String(value ?? "").trim()).filter(Boolean).join(" ");
    if (!text) continue;
    const displayId = String(rec.displayId ?? "").trim();
    const id = String(rec.id ?? "").trim();
    if (displayId) map.set(displayId, text);
    if (id) map.set(id, text);
  }
  return map;
}

export interface TargetAlignmentInput {
  /** Raw target string of the test case (e.g. "C001 挂号约束"). */
  target: string;
  /** Concatenated test content: title + steps + expected_result. */
  content: string;
  /** Map of constraint ID -> source_text (from collectConstraintSourceTexts). */
  constraintTexts: Map<string, string>;
}

export interface TargetAlignmentResult {
  /** Whether the test is considered misaligned with its target constraint. */
  misaligned: boolean;
  /** Jaccard overlap between the test content and the resolved constraint text. */
  overlap: number;
  /** The constraint ID that was matched, if any. */
  matchedId: string | null;
  /** Whether the referenced IDs are all unknown (no constraint text found). */
  allIdsUnknown: boolean;
}

const TARGET_ID_RE = /\b(?:C\d{3,4}|CON_[A-Za-z0-9_]+)\b/g;

/**
 * Evaluate target-content alignment for a single test case.
 *
 * - If the target references no constraint IDs, returns misaligned=false
 *   (nothing to align against; handled by other checks).
 * - If every referenced ID is unknown, returns allIdsUnknown=true and
 *   misaligned=false (the existing wrong_target check handles unknown IDs).
 * - Otherwise picks the constraint with the highest overlap; if that overlap
 *   is <= TARGET_ALIGNMENT_REJECT_THRESHOLD (default 0 — i.e. zero shared
 *   content terms), the test is misaligned.
 */
export function evaluateTargetAlignment(
  input: TargetAlignmentInput,
): TargetAlignmentResult {
  const targetStr = String(input.target ?? "").trim();
  const ids = targetStr.match(TARGET_ID_RE) ?? [];

  if (ids.length === 0) {
    return { misaligned: false, overlap: 1, matchedId: null, allIdsUnknown: false };
  }

  const contentTerms = extractContentTerms(String(input.content ?? ""));

  let bestId: string | null = null;
  let bestOverlap = 0;
  let knownCount = 0;
  let firstKnownId: string | null = null;
  for (const id of ids) {
    const src = input.constraintTexts.get(id);
    if (!src) continue;
    knownCount++;
    if (!firstKnownId) firstKnownId = id;
    const constraintTerms = extractContentTerms(src);
    const sim = jaccardSimilarity(constraintTerms, contentTerms);
    if (sim > bestOverlap) {
      bestOverlap = sim;
      bestId = id;
    }
  }

  const allIdsUnknown = knownCount === 0;
  // Unknown-ID targets are the wrong_target check's responsibility, not ours.
  if (allIdsUnknown) {
    return { misaligned: false, overlap: 0, matchedId: null, allIdsUnknown: true };
  }

  // When overlap is 0 there is no "best" match; report the first known id so
  // the issue message can name the constraint the test claims to target.
  const matchedId = bestId ?? firstKnownId;
  const misaligned = bestOverlap <= TARGET_ALIGNMENT_REJECT_THRESHOLD;
  return { misaligned, overlap: bestOverlap, matchedId, allIdsUnknown: false };
}
