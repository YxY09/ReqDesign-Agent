/**
 * Benchmark v2 — Layer 0 Sanity Gate.
 *
 * Deterministic, language-agnostic structural checks that run BEFORE any
 * judge / gold / mutant logic. A run that fails this gate is marked
 * `status === "invalid"` and gets no quality score (the four sub-scores stay
 * null). This is purely about "did the pipeline produce a well-formed,
 * internally-consistent artifact set" — nothing semantic.
 *
 * The check list (per the v2 design):
 *   1. required artifacts present (requirement.json + the three diagrams)
 *   2. requirement.json is parseable JSON with expected top-level shape
 *   3. every diagram is parseable Mermaid (delegates to MermaidValidator)
 *   4. no dangling class references in the class diagram
 *   5. no hallucinated/unknown ids referenced by relations
 *   6. no duplicate coverage (duplicate class / node / state ids)
 *
 * This module intentionally re-implements a couple of small helpers
 * (`readNames`, `normalize`) locally rather than importing them from the legacy
 * `scorer.ts`, per the Phase-1 constraint that legacy files stay untouched.
 *
 * @module benchmark/sanityGate
 */

import { MermaidValidator } from "../generators/mermaid.js";
import type { SanityResult } from "./resultStore.js";

// ---------------------------------------------------------------------------
// Local copies of scorer helpers (legacy scorer.ts must stay untouched)
// ---------------------------------------------------------------------------

/** Pull display names from a heterogeneous list (strings or {name|description}). */
function readNames(items: unknown, preferred = "name"): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        return String(rec[preferred] ?? rec.name ?? rec.description ?? "");
      }
      return String(item ?? "");
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Lowercase + drop punctuation/space, keep alphanumerics and CJK. Deterministic only. */
function normalize(text: string): string {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * Inputs to the sanity gate. Designed to match what the v2 runner extracts from
 * the runtime's `run()` return value plus the on-disk artifact directory, so
 * the gate can run against either live state or persisted files.
 */
export interface SanityGateInput {
  /** Parsed `requirement.json` (may be `{}` if the file was missing/unparseable). */
  requirement: Record<string, unknown>;
  /** Diagram id → Mermaid source. Keys are e.g. `class_diagram`. */
  diagrams: Record<string, string>;
  /**
   * Names of artifact files that must exist on disk. The gate does not read
   * disk itself; the caller passes the list of *present* files and the gate
   * reports any required name that is absent. Defaults to the canonical set.
   */
  presentArtifacts?: string[];
}

/**
 * Canonical set of artifact categories a valid run must have produced.
 *
 * These are *category* names (matching the OutputManager sub-dirs), not raw
 * filenames: the v2 runner scans the per-run output dir and reports which
 * categories are present. A run missing any of these is incomplete at Layer 0
 * and must be marked invalid (no quality score).
 *
 *   - requirement : requirement/analysis.json (the structured analysis)
 *   - design      : design/system_design.md (the system design doc)
 *   - diagrams    : diagrams/ with at least one non-empty *.mmd
 *   - tests       : tests/test_cases.{md,json} (generated test cases)
 */
const REQUIRED_ARTIFACTS = ["requirement", "design", "diagrams", "tests"] as const;

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Run the Layer-0 sanity gate. Pure & synchronous: no LLM, no disk writes.
 * Returns `{ passed, errors }`; never throws (malformed inputs become errors).
 */
export function runSanityGate(input: SanityGateInput): SanityResult {
  const errors: string[] = [];
  const validator = new MermaidValidator();

  // 1. Required artifacts present.
  const present = new Set(input.presentArtifacts ?? REQUIRED_ARTIFACTS);
  for (const required of REQUIRED_ARTIFACTS) {
    if (!present.has(required)) {
      errors.push(`missing required artifact: ${required}`);
    }
  }

  // 2. requirement.json top-level shape. We only assert it parsed to an object;
  //    deeper schema validation belongs to Phase-2 quality scoring.
  if (!input.requirement || typeof input.requirement !== "object") {
    errors.push("requirement.json is not a JSON object");
  }

  // 3-6. Diagram checks. At least one non-empty diagram is REQUIRED — an
  //      empty diagram set means the pipeline produced no structural view at
  //      all, which is a Layer-0 completeness failure (not a Phase-2 quality
  //      gap). Any present diagram must additionally validate as Mermaid and
  //      have no dangling / duplicate ids (those are structural lies).
  const diagrams = input.diagrams ?? {};
  const diagramEntries = Object.entries(diagrams).filter(
    ([, src]) => typeof src === "string" && src.trim().length > 0,
  );
  if (diagramEntries.length === 0) {
    errors.push(
      "no non-empty diagram provided (require at least one of class/activity/state diagram)",
    );
  }

  for (const [name, src] of diagramEntries) {
    const result = validator.validate(src, name);
    if (!result.valid) {
      // The validator already folds dangling-class / duplicate-id / hallucinated
      // reference detection into its messages (see _checkClassDiagramSemantics
      // etc.), so we surface its message verbatim.
      errors.push(`diagram '${name}' invalid: ${result.message}`);
    }
  }

  // Cross-artifact: entities declared in requirement.json must appear in the
  // class diagram (no "phantom" entity that exists only in prose). This is a
  // structural truth check, not semantic coverage.
  const classDiagram = String(diagrams.class_diagram ?? "");
  if (classDiagram.trim()) {
    const entities = readNames(input.requirement?.entities);
    for (const entity of entities) {
      const present2 = normalizedIncludes(classDiagram, entity);
      if (!present2) {
        errors.push(`dangling entity: '${entity}' declared but absent from class_diagram`);
      }
    }
  }

  return { passed: errors.length === 0, errors };
}

/** Case-insensitive, punctuation-insensitive substring test (deterministic). */
function normalizedIncludes(haystack: string, needle: string): boolean {
  const n = normalize(needle);
  return n.length > 0 && normalize(haystack).includes(n);
}
