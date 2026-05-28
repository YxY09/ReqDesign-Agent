/**
 * Analysis Quality Gate — deterministic quality checks for analysis results.
 * Zero LLM calls. Runs after normalization and source-ref verification.
 * Result attaches as `__qualityGate` on the merged analysis without blocking flow.
 */

export interface QualityCheckResult {
  passed: boolean;
  score: number; // 0-1
  checks: { name: string; passed: boolean; detail: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

/** Normalize text for matching: lowercase + normalize quotes + strip whitespace. */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    // Normalize Unicode quotes/apostrophes to ASCII equivalents
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F\u00AB\u00BB]/g, '"')
    .replace(/\s+/g, "")
    .trim();
}

function arrVal(analysis: Rec, key: string): Rec[] {
  const raw = analysis[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is Rec => typeof item === "object" && item !== null && !Array.isArray(item));
}

// ---------------------------------------------------------------------------
// Main check function
// ---------------------------------------------------------------------------

/**
 * Run deterministic quality checks on an analysis result.
 *
 * Checks:
 *  1. Required fields non-empty (actors, functions, entities ≥ 1)
 *  2. Entity attribute coverage (≥ 80% have ≥ 1 attribute)
 *  3. Function description coverage (≥ 80% have description)
 *  4. Constraints non-empty (≥ 1 constraint or exception)
 *  5. ID format (E/F/C/X prefix + digits)
 *  6. Cross-reference integrity (relationship targets exist)
 *  7. source_ref coverage (≥ 30% constraints have source_text, when sourceText available)
 *  8. No unverified constraints (source_text found in source)
 */
export function checkAnalysisQuality(
  analysis: Rec,
  sourceText?: string,
): QualityCheckResult {
  const checks: { name: string; passed: boolean; detail: string }[] = [];

  // 1. Required fields non-empty
  {
    const actors = arrVal(analysis, "actors");
    const functions = arrVal(analysis, "functions");
    const entities = arrVal(analysis, "entities");
    const passed = actors.length >= 1 && functions.length >= 1 && entities.length >= 1;
    checks.push({
      name: "required_fields_non_empty",
      passed,
      detail: passed
        ? `actors=${actors.length}, functions=${functions.length}, entities=${entities.length}`
        : `Missing: actors=${actors.length}, functions=${functions.length}, entities=${entities.length}`,
    });
  }

  // 2. Entity attribute coverage
  {
    const entities = arrVal(analysis, "entities");
    const withAttrs = entities.filter(
      (e) => Array.isArray(e.attributes) && e.attributes.length >= 1,
    );
    const ratio = entities.length > 0 ? withAttrs.length / entities.length : 0;
    const passed = entities.length === 0 || ratio >= 0.8;
    checks.push({
      name: "entity_attribute_coverage",
      passed,
      detail: `${withAttrs.length}/${entities.length} entities have attributes (${(ratio * 100).toFixed(0)}%)`,
    });
  }

  // 3. Function description coverage
  {
    const functions = arrVal(analysis, "functions");
    const withDesc = functions.filter(
      (f) => typeof f.description === "string" && f.description.trim().length > 0,
    );
    const ratio = functions.length > 0 ? withDesc.length / functions.length : 0;
    const passed = functions.length === 0 || ratio >= 0.8;
    checks.push({
      name: "function_description_coverage",
      passed,
      detail: `${withDesc.length}/${functions.length} functions have description (${(ratio * 100).toFixed(0)}%)`,
    });
  }

  // 4. Constraints non-empty
  {
    const constraints = arrVal(analysis, "constraints");
    const exceptions = arrVal(analysis, "exceptions");
    const passed = constraints.length + exceptions.length >= 1;
    checks.push({
      name: "constraints_non_empty",
      passed,
      detail: `${constraints.length} constraints, ${exceptions.length} exceptions`,
    });
  }

  // 5. ID format check
  {
    const idPattern = /^[EFCX][A-Za-z0-9_]+$/;
    const allItems = [
      ...arrVal(analysis, "entities"),
      ...arrVal(analysis, "functions"),
      ...arrVal(analysis, "constraints"),
      ...arrVal(analysis, "exceptions"),
    ];
    const itemsWithId = allItems.filter((item) => typeof item.id === "string" && item.id.trim().length > 0);
    const validIds = itemsWithId.filter((item) => idPattern.test(String(item.id)));
    const passed = itemsWithId.length === 0 || validIds.length === itemsWithId.length;
    const invalidExamples = itemsWithId
      .filter((item) => !idPattern.test(String(item.id)))
      .map((item) => String(item.id))
      .slice(0, 3);
    checks.push({
      name: "id_format",
      passed,
      detail: passed
        ? `All ${itemsWithId.length} IDs valid`
        : `${invalidExamples.length} invalid IDs: ${invalidExamples.join(", ")}`,
    });
  }

  // 6. Cross-reference integrity
  {
    const entities = arrVal(analysis, "entities");
    const entityNames = new Set(entities.map((e) => String(e.name ?? "").trim()));
    const entityIds = new Set(entities.map((e) => String(e.id ?? e.entityRef ?? "").trim()));
    let brokenCount = 0;
    for (const entity of entities) {
      const rels = Array.isArray(entity.relationships) ? entity.relationships as Rec[] : [];
      for (const rel of rels) {
        const target = String(rel.target ?? "").trim();
        if (target && !entityNames.has(target) && !entityIds.has(target)) {
          brokenCount++;
        }
      }
    }
    const passed = brokenCount === 0;
    checks.push({
      name: "cross_reference_integrity",
      passed,
      detail: passed
        ? "All relationship targets resolve"
        : `${brokenCount} broken relationship target(s)`,
    });
  }

  // 7. source_ref coverage (only when sourceText provided)
  {
    const constraints = arrVal(analysis, "constraints");
    if (!sourceText || sourceText.trim().length === 0) {
      checks.push({
        name: "source_ref_coverage",
        passed: true,
        detail: "No source text provided, check skipped",
      });
    } else {
      const withSourceText = constraints.filter(
        (c) => typeof c.source_text === "string" && c.source_text.trim().length > 0,
      );
      const ratio = constraints.length > 0 ? withSourceText.length / constraints.length : 0;
      const passed = constraints.length === 0 || ratio >= 0.3;
      checks.push({
        name: "source_ref_coverage",
        passed,
        detail: `${withSourceText.length}/${constraints.length} constraints have source_text (${(ratio * 100).toFixed(0)}%)`,
      });
    }
  }

  // 8. No unverified constraints
  {
    let unverifiedCount = 0;
    if (sourceText && sourceText.trim().length > 0) {
      const normalizedSource = normalizeForMatch(sourceText);
      for (const listKey of ["constraints", "exceptions"] as const) {
        const items = arrVal(analysis, listKey);
        for (const item of items) {
          const st = String(item.source_text ?? "").trim();
          if (!st) continue;
          const normalized = normalizeForMatch(st);
          if (!normalizedSource.includes(normalized)) {
            unverifiedCount++;
          }
        }
      }
    }
    const passed = unverifiedCount === 0;
    checks.push({
      name: "no_unverified_constraints",
      passed,
      detail: passed
        ? "All source_text references verified"
        : `${unverifiedCount} unverified source_text reference(s)`,
    });
  }

  const passedCount = checks.filter((c) => c.passed).length;
  const totalCount = checks.length;
  const score = totalCount > 0 ? passedCount / totalCount : 0;

  return {
    passed: score >= 0.7,
    score,
    checks,
  };
}
