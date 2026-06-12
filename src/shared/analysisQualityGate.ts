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

function deriveReifiedEntityName(rawName: string): string {
  const cleaned = rawName.replace(/流程|过程|记录/g, "").trim();
  if (/^[A-Z][A-Za-z0-9]*$/.test(cleaned)) return cleaned;
  if (/^[A-Z][A-Za-z0-9]*$/.test(rawName)) return rawName;
  return "";
}

function looksLikeReifiableProcessName(name: string): boolean {
  return /Registration|Register|Investigation|Investigate|Prosecution|Prosecute|Submission|Submit|Approval|Approve|Enrollment|Enroll|Selection|Reservation|Booking|Borrowing|Borrow|Return|Payment|Refund|Transfer|Visit|Access|Session|Login|Filing|Application|Assignment|Review|Inspection/i.test(name) ||
    /注册|登记|立案|报案|调查|侦查|起诉|提交|审批|选课|选修|预约|借阅|归还|支付|退款|访问|会话|登录|申请|分配|审核|检查/.test(name);
}

function spacePascalCase(text: string): string {
  return String(text ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

function collectReificationEvidence(text: string): string[] {
  const normalized = spacePascalCase(text);
  const evidence: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["has_identifier", /编号|号码|单号|流水|唯一标识|\bid\b|identifier|number|token/i],
    ["has_timestamp", /时间|日期|学期|期限|时长|timestamp|date|semester|duration|\bip\b/i],
    ["has_status", /状态|进度|通过|关闭|完成|status|state|passed|closed|resolved|complete/i],
    ["has_result", /结果|成绩|分数|判决|刑期|result|outcome|score|grade|judgment|sentence/i],
    ["has_report_or_evidence", /报告|证据|证据链|结论|材料|庭审|report|evidence|conclusion|charge|court/i],
    ["is_referenced_later", /后续|引用|关联|前提|追踪|follow|referenced|subsequent|prerequisite|track/i],
  ];
  for (const [label, re] of checks) {
    if (re.test(normalized)) evidence.push(label);
  }
  return evidence;
}

function hasEnoughReificationEvidence(name: string, evidence: string[]): boolean {
  if (evidence.length >= 2) return true;
  if (evidence.length === 0) return false;
  return /Registration|Investigation|Prosecution|Submission|Approval|Enrollment|Reservation|Payment|Visit|Access|Session|Application/i.test(name) ||
    /注册|登记|立案|调查|侦查|起诉|提交|审批|选课|选修|预约|支付|访问|会话|申请/.test(name);
}

function processText(process: Rec, sourceText: string): string {
  const fields: string[] = [];
  for (const key of ["name", "description", "id"]) {
    const value = String(process[key] ?? "").trim();
    if (value) fields.push(value);
  }
  for (const key of ["steps", "actors"]) {
    const value = process[key];
    if (Array.isArray(value)) fields.push(...value.map((item) => String(item)));
  }
  return `${fields.join(" ")}\n${sourceText}`;
}

function missingRelationshipEntities(analysis: Rec, sourceText: string): string[] {
  const processes = arrVal(analysis, "business_processes");
  const entities = arrVal(analysis, "entities");
  if (processes.length === 0 || entities.length === 0) return [];

  const entityNames = new Set(
    entities.map((entity) => String(entity.name ?? "").trim().toLowerCase()).filter(Boolean),
  );
  const reifiedSourceNames = new Set(
    entities.map((entity) => {
      const reifies = typeof entity.reifies === "object" && entity.reifies !== null
        ? entity.reifies as Rec
        : {};
      return String(reifies.sourceName ?? "").trim().toLowerCase();
    }).filter(Boolean),
  );

  const missing: string[] = [];
  for (const process of processes) {
    const rawName = String(process.name ?? process.id ?? "").trim();
    const entityName = deriveReifiedEntityName(rawName);
    if (!entityName || !looksLikeReifiableProcessName(rawName)) continue;
    const evidence = collectReificationEvidence(processText(process, sourceText));
    if (!hasEnoughReificationEvidence(rawName, evidence)) continue;
    if (entityNames.has(entityName.toLowerCase())) continue;
    if (reifiedSourceNames.has(rawName.toLowerCase())) continue;
    missing.push(`${rawName} -> ${entityName} (${evidence.join(",")})`);
  }
  return missing;
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

  // 5. ID format check (per-type prefixes)
  {
    const typePatterns: { key: string; pattern: RegExp }[] = [
      { key: "entities",    pattern: /^E_[A-Za-z0-9_]+$/ },
      { key: "actors",      pattern: /^A_[A-Za-z0-9_]+$/ },
      { key: "functions",   pattern: /^FUN_[A-Za-z0-9_]+$/ },
      { key: "constraints",  pattern: /^CON_[A-Za-z0-9_]+$/ },
      { key: "exceptions",  pattern: /^EXC_[A-Za-z0-9_]+$/ },
    ];
    const allInvalid: string[] = [];
    let totalWithId = 0;
    for (const { key, pattern } of typePatterns) {
      const items = arrVal(analysis, key);
      const itemsWithId = items.filter((item) => typeof item.id === "string" && item.id.trim().length > 0);
      totalWithId += itemsWithId.length;
      for (const item of itemsWithId) {
        if (!pattern.test(String(item.id))) {
          allInvalid.push(String(item.id));
        }
      }
    }
    const passed = totalWithId === 0 || allInvalid.length === 0;
    const invalidExamples = allInvalid.slice(0, 5);
    checks.push({
      name: "id_format",
      passed,
      detail: passed
        ? `All ${totalWithId} IDs valid`
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

  // 7. Relationship entity coverage
  {
    const missing = missingRelationshipEntities(analysis, sourceText ?? "");
    const passed = missing.length === 0;
    checks.push({
      name: "relationship_entity_coverage",
      passed,
      detail: passed
        ? "No missing reified relationship/process entities detected"
        : `Missing reified entities: ${missing.slice(0, 5).join("; ")}`,
    });
  }

  // 8. source_ref coverage (only when sourceText provided)
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

  // 9. No unverified constraints
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
