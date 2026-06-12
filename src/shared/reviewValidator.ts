/**
 * Review Validator — deterministic gate checks before LLM review.
 *
 * Check items:
 * 1. ID 唯一性：entity/function/constraint/exception 的 canonicalId 和 displayId 是否唯一
 * 2. 引用完整性：design/test 中引用的 ID 是否都存在
 * 3. 自编 ID 检测：design/test 中是否出现请求中不存在的 C001/F001 等 ID
 * 4. 空步骤/空预期检测：test case 的 steps 和 expected_result 非空
 */

import { RequirementIndex } from "./requirementIndex.js";

export interface ReviewValidationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ReviewValidationResult {
  passed: boolean;
  checks: ReviewValidationCheck[];
}

export function validateReview(
  requirementJson: Record<string, unknown>,
  designText: string,
  testCasesText: string,
): ReviewValidationResult {
  const checks: ReviewValidationCheck[] = [];

  checks.push(_checkIdUniqueness(requirementJson));
  checks.push(_checkReferenceIntegrity(requirementJson, designText, testCasesText));
  checks.push(_checkSelfInventedIds(requirementJson, designText, testCasesText));
  checks.push(_checkEmptySteps(requirementJson, testCasesText));

  const passed = checks.every((c) => c.passed);

  return { passed, checks };
}

// ---------------------------------------------------------------------------
// Check 1: ID 唯一性
// ---------------------------------------------------------------------------

function _checkIdUniqueness(requirementJson: Record<string, unknown>): ReviewValidationCheck {
  const entities = asArray(requirementJson["entities"]);
  const functions = asArray(requirementJson["functions"]);
  const constraints = asArray(requirementJson["constraints"]);
  const exceptions = asArray(requirementJson["exceptions"]);

  const seenIds = new Map<string, string>(); // id -> field name
  const duplicates: string[] = [];

  for (const items of [
    { label: "entities", arr: entities, idField: "id", nameField: "canonicalName" },
    { label: "functions", arr: functions, idField: "id", nameField: "displayId" },
    { label: "functions", arr: functions, idField: "displayId", nameField: "name" },
    { label: "constraints", arr: constraints, idField: "id", nameField: "description" },
    { label: "constraints", arr: constraints, idField: "displayId", nameField: "description" },
    { label: "exceptions", arr: exceptions, idField: "id", nameField: "description" },
    { label: "exceptions", arr: exceptions, idField: "displayId", nameField: "description" },
  ]) {
    for (const item of items.arr) {
      const val = String(item[items.idField] ?? "").trim();
      if (!val) continue;
      const fullKey = `${items.label}.${items.idField}`;
      if (seenIds.has(val) && seenIds.get(val) !== fullKey) {
        // Only flag cross-category duplicates (e.g., same canonicalName on two entities)
        // But for displayId, duplicates within same category are also flagged
        if (items.idField === "displayId" || items.idField === "id") {
          duplicates.push(`${val}`);
        }
      }
      seenIds.set(val, fullKey);
    }
  }

  // Also check canonicalName uniqueness within entities
  const entityCanonicalNames = new Map<string, number>();
  for (const e of entities) {
    const cn = String(e["canonicalName"] ?? e["id"] ?? "").trim();
    if (!cn) continue;
    const count = (entityCanonicalNames.get(cn) ?? 0) + 1;
    entityCanonicalNames.set(cn, count);
  }
  for (const [cn, count] of entityCanonicalNames) {
    if (count > 1) {
      if (!duplicates.includes(cn)) duplicates.push(cn);
    }
  }

  const uniqueDups = [...new Set(duplicates)];
  if (uniqueDups.length > 0) {
    return {
      name: "ID 唯一性",
      passed: false,
      detail: `发现重复 ID: ${uniqueDups.join(", ")}`,
    };
  }

  return { name: "ID 唯一性", passed: true, detail: "所有 ID 唯一" };
}

// ---------------------------------------------------------------------------
// Check 2: 引用完整性
// ---------------------------------------------------------------------------

function _checkReferenceIntegrity(
  requirementJson: Record<string, unknown>,
  designText: string,
  testCasesText: string,
): ReviewValidationCheck {
  const requirementIndex = RequirementIndex.fromRequirementJson(requirementJson);
  const combinedText = designText + "\n" + testCasesText;

  const referenced = new Set<string>();
  for (const id of requirementIndex.extractIds(combinedText)) referenced.add(id);

  const undefinedRefs = requirementIndex.unknownReferences(referenced);

  if (undefinedRefs.length > 0) {
    return {
      name: "引用完整性",
      passed: false,
      detail: `引用了未定义的 ID: ${undefinedRefs.join(", ")}`,
    };
  }

  return { name: "引用完整性", passed: true, detail: "所有引用完整" };
}

// ---------------------------------------------------------------------------
// Check 3: 自编 ID 检测
// ---------------------------------------------------------------------------

function _checkSelfInventedIds(
  requirementJson: Record<string, unknown>,
  designText: string,
  testCasesText: string,
): ReviewValidationCheck {
  const requirementIndex = RequirementIndex.fromRequirementJson(requirementJson);
  const combinedText = designText + "\n" + testCasesText;

  const allRefs = new Set<string>();
  for (const id of requirementIndex.extractIds(combinedText)) allRefs.add(id);

  const invented = requirementIndex.unknownReferences(allRefs);

  if (invented.length > 0) {
    return {
      name: "自编 ID 检测",
      passed: false,
      detail: `检测到未在需求中定义的 ID: ${invented.join(", ")}`,
    };
  }

  return { name: "自编 ID 检测", passed: true, detail: "未检测到自编 ID" };
}

// ---------------------------------------------------------------------------
// Check 4: 空步骤/空预期检测
// ---------------------------------------------------------------------------

function _checkEmptySteps(
  _requirementJson: Record<string, unknown>,
  testCasesText: string,
): ReviewValidationCheck {
  if (!testCasesText.trim()) {
    return { name: "空步骤/空预期检测", passed: true, detail: "无测试用例文本" };
  }

  const issues: string[] = [];

  // Detect step/expected_result patterns with empty content
  // Pattern: "步骤：" followed by empty line or next section header
  // Pattern: "预期结果：" followed by empty line or next section header

  const lines = testCasesText.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check "步骤：" or "步骤:" pattern
    if (/^步骤[：:]/.test(line)) {
      const content = line.replace(/^步骤[：:]\s*/, "").trim();
      // If current line content is empty, check next line
      if (!content) {
        const nextLine = (lines[i + 1] ?? "").trim();
        // Empty if next line is empty, starts with ##, or is another label
        if (!nextLine || /^(##|步骤|预期|前置|测试|TC\d)/.test(nextLine)) {
          issues.push(`步骤 (行 ${i + 1})`);
        }
      }
    }

    // Check "预期结果：" or "预期结果:" pattern
    if (/^预期结果[：:]/.test(line)) {
      const content = line.replace(/^预期结果[：:]\s*/, "").trim();
      if (!content) {
        const nextLine = (lines[i + 1] ?? "").trim();
        if (!nextLine || /^(##|步骤|预期|前置|测试|TC\d)/.test(nextLine)) {
          issues.push(`预期结果 (行 ${i + 1})`);
        }
      }
    }
  }

  if (issues.length > 0) {
    return {
      name: "空步骤/空预期检测",
      passed: false,
      detail: `发现空步骤或空预期: ${issues.join(", ")}`,
    };
  }

  return { name: "空步骤/空预期检测", passed: true, detail: "步骤和预期结果均有内容" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asArray(val: unknown): Record<string, unknown>[] {
  if (!Array.isArray(val)) return [];
  return val as Record<string, unknown>[];
}
