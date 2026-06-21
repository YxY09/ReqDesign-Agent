/**
 * TestQualityValidator — 程序化测试用例质量检查器。
 *
 * 检测模板化测试、缺失输入、模糊预期结果、错误目标、目标/内容不匹配等问题。
 */

import {
  evaluateTargetAlignment,
  collectConstraintSourceTexts,
  TARGET_ALIGNMENT_WARN_ONLY,
} from "../shared/testAlignment.js";

export interface QualityIssue {
  testId: string;
  issue: "template_like" | "missing_input" | "vague_expected" | "too_few_steps" | "wrong_target" | "target_content_alignment" | "canonical_only_target" | "fabricated_canonical_id";
  severity: "reject" | "warning";
  detail: string;
}

/**
 * 对测试用例列表执行全量质量校验，返回所有问题。
 */
export function validateTestCases(
  cases: Array<Record<string, unknown>>,
  analysis: Record<string, unknown>,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const knownIds = collectKnownIds(analysis);
  const constraintTexts = collectConstraintSourceTexts(analysis);

  for (const tc of cases) {
    const testId = String(tc.id ?? "unknown").trim();

    // Check 1: template-like
    if (isTemplateLike(tc)) {
      issues.push({
        testId,
        issue: "template_like",
        severity: "reject",
        detail: `测试用例 ${testId} 检测到模板化表述或步骤过少`,
      });
    }

    // Check 2: missing input / too few steps
    if (!Array.isArray(tc.steps) || tc.steps.length === 0) {
      issues.push({
        testId,
        issue: "too_few_steps",
        severity: "reject",
        detail: `测试用例 ${testId} 步骤数组为空或缺失`,
      });
    } else if (hasMissingInput(tc)) {
      issues.push({
        testId,
        issue: "missing_input",
        severity: "warning",
        detail: `测试用例 ${testId} 缺少具体输入数据`,
      });
    }

    // Check 3: vague expected result
    if (hasVagueExpected(tc)) {
      issues.push({
        testId,
        issue: "vague_expected",
        severity: "warning",
        detail: `测试用例 ${testId} 预期结果模糊`,
      });
    }

    // Check 4: wrong target (unknown IDs)
    if (hasWrongTarget(tc, knownIds)) {
      issues.push({
        testId,
        issue: "wrong_target",
        severity: "reject",
        detail: `测试用例 ${testId} 目标引用了未知 ID`,
      });
    }

    // Check 4b: canonical-only target (CON_/FUN_/EXC_ with no displayId C/F/X)
    // — a fabricated/hallucinated target that points at a bare canonicalId
    // instead of the human-facing displayId. The displayId is the contract;
    // canonical-only targets indicate the LLM invented a constraint.
    if (hasCanonicalOnlyTarget(tc)) {
      issues.push({
        testId,
        issue: "canonical_only_target",
        severity: "reject",
        detail: `测试用例 ${testId} 目标仅使用 canonicalId (CON_/FUN_/EXC_) 而未携带 displayId，疑似指向编造约束`,
      });
    }

    // Check 4c: fabricated canonical id (any CON_/FUN_/EXC_ token in
    // target/steps/expected_result that is NOT in the analysis's real
    // canonical id set). The LLM in pure_keepass invented hash tokens like
    // CON_FUNC_E3K31F00 and treated them as product code names — they get
    // through hasCanonicalOnlyTarget because the LLM paired them with a real
    // displayId like "C002 | CON_FUNC_E3K31F00". This check rejects any test
    // whose body references a hash that the analysis never produced.
    const fabricated = collectFabricatedCanonicalIds(tc, knownIds);
    if (fabricated.length > 0) {
      issues.push({
        testId,
        issue: "fabricated_canonical_id",
        severity: "reject",
        detail: `测试用例 ${testId} 引用了 analysis 中不存在的 canonicalId: ${fabricated.join(", ")}`,
      });
    }

    // Check 5: target-content alignment (valid ID, fabricated content)
    const alignment = evaluateTargetAlignment({
      target: String(tc.target ?? ""),
      content: [
        tc.title,
        ...(Array.isArray(tc.steps) ? tc.steps.map(String) : []),
        tc.expected_result ?? "",
      ].map((v) => String(v ?? "")).join(" "),
      constraintTexts,
    });
    if (alignment.misaligned && !alignment.allIdsUnknown) {
      issues.push({
        testId,
        issue: "target_content_alignment",
        // Warn-only by default until the overlap threshold is calibrated on
        // a real corpus; flip TARGET_ALIGNMENT_WARN_ONLY to hard-reject.
        severity: TARGET_ALIGNMENT_WARN_ONLY ? "warning" : "reject",
        detail: `测试用例 ${testId} 目标约束 ${alignment.matchedId ?? ""} 的内容与步骤/预期结果无重叠（overlap=${alignment.overlap.toFixed(2)}），疑似编造不相关规则`,
      });
    }
  }

  // Sort: reject first, then warning
  issues.sort((a, _b) => (a.severity === "reject" ? -1 : 1));
  return issues;
}

/**
 * 检测模板化测试用例。
 */
export function isTemplateLike(tc: Record<string, unknown>): boolean {
  const segments = [
    tc.title,
    ...(Array.isArray(tc.steps) ? tc.steps.map(String) : []),
    tc.expected_result ?? "",
  ]
    .map((v) => String(v ?? ""))
    .flatMap((v) => v.split(/[。！？!?；;\n\r]+/))
    .map((v) => v.trim())
    .filter(Boolean);

  return (
    segments.some((text) =>
      /违反\s*(C|CON_|约束)/i.test(text) ||
      /检查.*是否满足/.test(text) ||
      // 仅匹配紧凑的空泛模板（"尝试满足约束"/"尝试验证约束"）。限定 尝试→约束
      // 的字距，避免误杀含具体动作/数据的真实步骤，例如
      // "尝试提交第二条违反唯一性约束的记录"（尝试与约束相距较远）。
      /尝试.{0,4}约束/.test(text),
    ) ||
    (Array.isArray(tc.steps) ? tc.steps.length : 0) < 2
  );
}

/**
 * 检测缺失具体输入。
 */
function hasMissingInput(tc: Record<string, unknown>): boolean {
  const steps = Array.isArray(tc.steps) ? tc.steps.map(String) : [];
  if (steps.length === 0) return true;

  // If no step contains specific data patterns (numbers, quoted values, etc.)
  const text = steps.join(" ");
  const hasSpecificData =
    /\d+/.test(text) ||           // contains numbers
    /["'][^"']+["']/.test(text) || // contains quoted values
    /输入|填写|设置|选择/.test(text); // contains action verbs with data

  return !hasSpecificData;
}

/**
 * 检测模糊预期结果。
 */
function hasVagueExpected(tc: Record<string, unknown>): boolean {
  const expected = String(tc.expected_result ?? "").trim();
  if (!expected) return true;

  const vaguePatterns = [
    /正常/,
    /成功$/,
    /符合预期/,
    /无误/,
    /正确$/,
    /通过$/,
    /^.{1,4}$/,  // too short (≤4 chars)
  ];

  return vaguePatterns.some((p) => p.test(expected));
}

/**
 * 检测错误目标引用。
 */
function hasWrongTarget(
  tc: Record<string, unknown>,
  knownIds: Set<string>,
): boolean {
  const target = String(tc.target ?? "").trim();
  if (!target) return false; // empty target handled elsewhere

  // Extract all IDs from the target
  const idPattern = /\b(?:F\d{3,4}|C\d{3,4}|[EX]\d{3,4}|FUN_[A-Za-z0-9_]+|CON_[A-Za-z0-9_]+|EXC_[A-Za-z0-9_]+)\b/g;
  const matches = target.match(idPattern);
  if (!matches || matches.length === 0) return false;

  // If ALL referenced IDs are unknown, it's wrong
  return matches.every((id) => !knownIds.has(id));
}

/**
 * 检测目标仅使用 canonicalId（CON_/FUN_/EXC_）而未携带 displayId（C/F/X\d{3}）。
 * 这种目标指向一个裸 canonicalId，通常意味着 LLM 凭空编造了一个约束/
 * 功能/异常，而不是引用真实的、带 displayId 的需求项。
 */
function hasCanonicalOnlyTarget(tc: Record<string, unknown>): boolean {
  const target = String(tc.target ?? "").trim();
  if (!target) return false;

  const canonicalPattern = /\b(?:FUN_[A-Za-z0-9_]+|CON_[A-Za-z0-9_]+|EXC_[A-Za-z0-9_]+)\b/g;
  const displayPattern = /\b(?:F\d{3,4}|C\d{3,4}|[EX]\d{3,4})\b/g;

  const canonicalMatches = target.match(canonicalPattern);
  const displayMatches = target.match(displayPattern);

  // Has at least one canonicalId but no displayId at all
  return (canonicalMatches !== null && canonicalMatches.length > 0)
    && (displayMatches === null || displayMatches.length === 0);
}

/**
 * Collect canonicalId-shaped tokens (CON_/FUN_/EXC_ followed by alnum chars)
 * appearing anywhere in `tc.target`, `tc.steps`, or `tc.expected_result`
 * that are NOT in the analysis's real canonicalId set.
 *
 * The hospital_mgmt / pure_keepass failure mode: the LLM saw real displayIds
 * (C001, F001) and then invented its own hash-like product codes
 * ("CON_FUNC_E3K31F00", "CON_FUNC_KDB_K28M") and folded them into the test
 * body as if they were canonical references. Since the displayId is real,
 * hasWrongTarget and hasCanonicalOnlyTarget both let the test through. This
 * function is the deterministic anchor: any CON_/FUN_/EXC_ token must
 * exactly match a value the analysis really emitted.
 */
export function collectFabricatedCanonicalIds(
  tc: Record<string, unknown>,
  knownIds: Set<string>,
): string[] {
  const haystack = [
    tc.target,
    ...(Array.isArray(tc.steps) ? tc.steps.map(String) : []),
    tc.expected_result,
  ]
    .map((v) => String(v ?? ""))
    .join(" ");
  if (!haystack) return [];

  const canonicalRe = /\b(?:FUN|CON|EXC)_[A-Z0-9][A-Za-z0-9_]{3,}\b/g;
  const found = haystack.match(canonicalRe);
  if (!found) return [];

  const fabricated = [...new Set(found.filter((token) => !knownIds.has(token)))];
  return fabricated;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectKnownIds(analysis: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const kind of ["functions", "constraints", "exceptions"]) {
    const items = analysis[kind];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const displayId = String(rec.displayId ?? "").trim();
      const id = String(rec.id ?? "").trim();
      if (displayId) ids.add(displayId);
      if (id) ids.add(id);
    }
  }
  return ids;
}
