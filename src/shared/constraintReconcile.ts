/**
 * constraintReconcile — make the pre-extracted constraint registry authoritative.
 *
 * The planner pre-extracts constraint *candidates* (ConstraintExtractor) with a
 * stable global numbering (C001…) and injects them into analyze prompts as
 * advisory hints. The analyze LLM is asked to echo them back but routinely
 * drops some (the #7 "analyze 丢约束" failure mode). This module provides the
 * deterministic detection half of the fix: given the authoritative candidate
 * registry and the final merged constraints, report which candidates are NOT
 * represented in the final analysis.
 *
 * Phase 1 (current): detection only — used to instrument/confirm the drops via
 * logs before any automatic re-add is enabled.
 * Phase 2 (later): the same matcher drives an authoritative re-add so that
 * `final constraints ⊇ extracted registry`.
 */

import type { ConstraintCandidate } from "./constraintCanonicalizer.js";

export interface DroppedConstraint {
  /** Stable registry ref by original candidate index (C001, C002, …). */
  constraintRef: string;
  description: string;
  sourceText: string;
}

/**
 * Normalize free text for robust containment comparison: lowercase, fold
 * whitespace/hyphens, strip punctuation but keep ASCII alphanumerics and CJK.
 * Mirrors the normalization in constraintExtractor.dropContainerConstraints so
 * detection and extraction agree on what "the same rule" looks like.
 */
export function normalizeConstraintText(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[-\s]+/g, " ")
    // Drop remaining punctuation (ASCII + CJK). CJK has no inter-word spaces, so
    // deletion is correct there; for ASCII the deletion can leave a double space
    // (e.g. "a > b" → "a  b"), which the final fold collapses.
    .replace(/[^a-z0-9 一-鿿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Minimum normalized length for a reliable containment match. */
const MIN_MATCH_LEN = 6;

/**
 * A candidate is "represented" in the final set when its normalized sourceText
 * (or description, as fallback) has a containment relationship — in either
 * direction — with some final constraint's normalized sourceText/description.
 * Bidirectional containment handles both rewording-into-a-broader-rule and
 * splitting-into-an-atomic-sub-rule. Strings shorter than MIN_MATCH_LEN must
 * match exactly to avoid trivial substring coincidences.
 */
function isRepresented(candNorm: string, finalNorms: string[]): boolean {
  for (const fin of finalNorms) {
    if (!fin) continue;
    if (candNorm.length < MIN_MATCH_LEN || fin.length < MIN_MATCH_LEN) {
      if (candNorm === fin) return true;
      continue;
    }
    if (fin.includes(candNorm) || candNorm.includes(fin)) return true;
  }
  return false;
}

/**
 * Return the authoritative candidates that are absent from the final merged
 * constraints. Deterministic and side-effect free.
 *
 * @param candidates  the authoritative pre-extracted registry (planner order;
 *                    index i → ref C{i+1}).
 * @param finalConstraints  the merged analysis constraints (objects with
 *                    source_text/sourceText and/or description).
 */
export function detectDroppedConstraints(
  candidates: ConstraintCandidate[] | undefined,
  finalConstraints: Array<Record<string, unknown>> | undefined,
): DroppedConstraint[] {
  if (!candidates || candidates.length === 0) return [];
  const finals = Array.isArray(finalConstraints) ? finalConstraints : [];

  const finalNorms: string[] = [];
  for (const c of finals) {
    if (!c || typeof c !== "object") continue;
    const src = String(c.source_text ?? c.sourceText ?? "");
    const desc = String(c.description ?? "");
    const srcNorm = normalizeConstraintText(src);
    const descNorm = normalizeConstraintText(desc);
    if (srcNorm) finalNorms.push(srcNorm);
    if (descNorm) finalNorms.push(descNorm);
  }

  const dropped: DroppedConstraint[] = [];
  candidates.forEach((cand, i) => {
    const candNorm = normalizeConstraintText(cand.sourceText ?? cand.description ?? "");
    if (candNorm.length < MIN_MATCH_LEN) return; // too short to judge reliably
    if (!isRepresented(candNorm, finalNorms)) {
      dropped.push({
        constraintRef: `C${String(i + 1).padStart(3, "0")}`,
        description: cand.description ?? "",
        sourceText: cand.sourceText ?? "",
      });
    }
  });
  return dropped;
}

/** Concise one-line + per-item summary for logging. */
export function formatDroppedConstraints(
  dropped: DroppedConstraint[],
  total: number,
): string[] {
  if (dropped.length === 0) return [];
  const lines = [
    `约束注册表诊断：${dropped.length}/${total} 条预提取约束未出现在最终分析中（疑似被 analyze 丢弃）：${dropped.map((d) => d.constraintRef).join(", ")}`,
  ];
  for (const d of dropped) {
    const txt = (d.sourceText || d.description).slice(0, 80);
    lines.push(`  丢弃 ${d.constraintRef}: ${txt}`);
  }
  return lines;
}
