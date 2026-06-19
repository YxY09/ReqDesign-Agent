/**
 * Benchmark v2 — Phase 2 Gold Obligation contract.
 *
 * A `GoldContract` is a hand-curated set of `GoldObligation` records for a
 * single case. Each obligation pins down ONE verifiable thing the generated
 * design + tests MUST evidence — drawn verbatim from the source requirement
 * (so the judge matches by semantic content, not by generated ID).
 *
 * This module owns ONLY the type definitions + a strict structural validator +
 * a disk loader. The evidence-based judge that scores artifacts against these
 * obligations lives in {@link ./qualityJudge.ts}.
 *
 * ID convention (deliberately decoupled from the generated coverage matrix):
 *   - "C-NNN"  → constraint   (source business constraints)
 *   - "F-NNN"  → functional   (source functional requirements)
 *   - "X-NNN"  → exception    (source exception / failure flows)
 *
 * @module benchmark/goldObligation
 */

import { existsSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Obligation category. Maps onto the source requirement's three buckets. */
type ObligationType = "constraint" | "functional" | "exception";

/** Severity used for reporting weighting (not score capping). */
type ObligationSeverity = "major" | "minor";

/**
 * One verifiable obligation extracted from the source requirement.
 *
 *   - `source_span`               verbatim excerpt of the original requirement
 *                                 (any language) — the single source of truth
 *                                 the judge quotes against.
 *   - `expected_design_evidence`  concrete points the DESIGN must express for
 *                                 this obligation to count as covered (trigger
 *                                 conditions, handling rules, field names...).
 *   - `expected_test_evidence`    concrete points the TESTS must express
 *                                 (assertable target + checkable outcome).
 *   - `anti_patterns`             common failure modes that look like coverage
 *                                 but are not (ID-only trace, paraphrase
 *                                 without rule, hallucinated assertion...).
 */
export interface GoldObligation {
  id: string;
  type: ObligationType;
  severity: ObligationSeverity;
  source_span: string;
  expected_design_evidence: string[];
  expected_test_evidence: string[];
  anti_patterns: string[];
}

/**
 * Per-case gold contract. `source_language` / `canonical_language` record the
 * languages involved so the judge prompt can instruct verbatim-quote matching
 * across them.
 */
export interface GoldContract {
  case_id: string;
  source_language: string;
  canonical_language: string;
  obligations: GoldObligation[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_TYPES: readonly ObligationType[] = ["constraint", "functional", "exception"];
const VALID_SEVERITY: readonly ObligationSeverity[] = ["major", "minor"];

/** Structural validation error. */
export class GoldContractError extends Error {}

/**
 * Strict structural validator. Returns `true` if `value` is a well-formed
 * {@link GoldContract}, otherwise throws {@link GoldContractError} with a
 * precise message. Used both by the loader and by tests.
 *
 * Deliberately strict: a malformed/placeholder contract (e.g. the Phase-1
 * `{}` gold-label stub) must NOT silently enable the judge — callers use this
 * to decide whether to judge at all.
 */
export function validateGoldContract(value: unknown): value is GoldContract {
  if (!value || typeof value !== "object") {
    throw new GoldContractError("gold contract is not an object");
  }
  const c = value as Record<string, unknown>;

  if (typeof c.case_id !== "string" || !c.case_id.trim()) {
    throw new GoldContractError("gold contract missing string 'case_id'");
  }
  if (typeof c.source_language !== "string" || !c.source_language.trim()) {
    throw new GoldContractError("gold contract missing string 'source_language'");
  }
  if (typeof c.canonical_language !== "string" || !c.canonical_language.trim()) {
    throw new GoldContractError("gold contract missing string 'canonical_language'");
  }
  if (!Array.isArray(c.obligations) || c.obligations.length === 0) {
    throw new GoldContractError("gold contract must have a non-empty 'obligations' array");
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < c.obligations.length; i++) {
    const o = c.obligations[i];
    const label = `obligation[${i}]`;
    if (!o || typeof o !== "object") {
      throw new GoldContractError(`${label} is not an object`);
    }
    const rec = o as Record<string, unknown>;

    if (typeof rec.id !== "string" || !rec.id.trim()) {
      throw new GoldContractError(`${label} missing string 'id'`);
    }
    if (seenIds.has(rec.id)) {
      throw new GoldContractError(`${label} duplicate obligation id '${rec.id}'`);
    }
    seenIds.add(rec.id);

    if (!VALID_TYPES.includes(rec.type as ObligationType)) {
      throw new GoldContractError(
        `${label} ('${rec.id}') type must be one of ${VALID_TYPES.join("/")}, got: ${String(rec.type)}`,
      );
    }
    if (!VALID_SEVERITY.includes(rec.severity as ObligationSeverity)) {
      throw new GoldContractError(
        `${label} ('${rec.id}') severity must be one of ${VALID_SEVERITY.join("/")}, got: ${String(rec.severity)}`,
      );
    }
    if (typeof rec.source_span !== "string" || !rec.source_span.trim()) {
      throw new GoldContractError(`${label} ('${rec.id}') missing non-empty 'source_span'`);
    }
    if (!isNonEmptyStringArray(rec.expected_design_evidence)) {
      throw new GoldContractError(
        `${label} ('${rec.id}') 'expected_design_evidence' must be a non-empty string[]`,
      );
    }
    if (!isStringArray(rec.expected_test_evidence)) {
      throw new GoldContractError(
        `${label} ('${rec.id}') 'expected_test_evidence' must be a string[]`,
      );
    }
    if (!isStringArray(rec.anti_patterns)) {
      throw new GoldContractError(`${label} ('${rec.id}') 'anti_patterns' must be a string[]`);
    }
  }
  return true;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isNonEmptyStringArray(v: unknown): v is string[] {
  return isStringArray(v) && v.length > 0;
}

// ---------------------------------------------------------------------------
// Disk loader
// ---------------------------------------------------------------------------

/**
 * Load + validate a {@link GoldContract} from `path`.
 *
 * Returns `null` when the file is absent OR malformed — callers treat null as
 * "no Phase-2 gold available for this case, skip the judge" (preserves the
 * Phase-1 placeholder behavior for cases without a hand-curated contract).
 */
export function loadGoldContract(path: string): GoldContract | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  try {
    validateGoldContract(parsed);
  } catch {
    return null;
  }
  return parsed as GoldContract;
}
