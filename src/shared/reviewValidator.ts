/**
 * Review Validator — deterministic gate checks before LLM review.
 *
 * Check items:
 * 1. ID 唯一性：entity/function/constraint/exception 的 canonicalId 和 displayId 是否唯一
 * 2. 引用完整性：design/test 中引用的 ID 是否都存在
 * 3. 覆盖率：function/constraint/exception 在 design/test 中的覆盖率
 * 4. 自编 ID 检测：design/test 中是否出现请求中不存在的 C001/F001 等 ID
 * 5. 约束设计覆盖：每个 constraintId 至少被 design 引用一次
 * 6. 约束测试覆盖：每个 constraintId 至少被 test 引用一次
 * 7. 空步骤/空预期检测：test case 的 steps 和 expected_result 非空
 */

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
  checks.push(_checkCoverage(requirementJson, designText, testCasesText));
  checks.push(_checkSelfInventedIds(requirementJson, designText, testCasesText));
  checks.push(_checkConstraintDesignCoverage(requirementJson, designText));
  checks.push(_checkConstraintTestCoverage(requirementJson, testCasesText));
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
  const definedIds = _collectDefinedIds(requirementJson);
  const combinedText = designText + "\n" + testCasesText;

  const referenced = new Set<string>();
  // F001, F999 patterns
  for (const m of combinedText.match(/\bF\d{3,4}\b/g) ?? []) referenced.add(m);
  // C001, C999 patterns
  for (const m of combinedText.match(/\bC\d{3,4}\b/g) ?? []) referenced.add(m);
  // X001, X999 patterns
  for (const m of combinedText.match(/\bX\d{3,4}\b/g) ?? []) referenced.add(m);
  // FUN_xxx patterns
  for (const m of combinedText.match(/\bFUN_[A-Za-z0-9_]+/g) ?? []) referenced.add(m);
  // CON_xxx patterns
  for (const m of combinedText.match(/\bCON_[A-Za-z0-9_]+/g) ?? []) referenced.add(m);
  // EXC_xxx patterns
  for (const m of combinedText.match(/\bEXC_[A-Za-z0-9_]+/g) ?? []) referenced.add(m);

  const undefinedRefs = [...referenced].filter((ref) => !definedIds.has(ref)).sort();

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
// Check 3: 覆盖率
// ---------------------------------------------------------------------------

function _checkCoverage(
  requirementJson: Record<string, unknown>,
  designText: string,
  testCasesText: string,
): ReviewValidationCheck {
  const functions = asArray(requirementJson["functions"]);
  const constraints = asArray(requirementJson["constraints"]);
  const exceptions = asArray(requirementJson["exceptions"]);

  const combinedText = designText + "\n" + testCasesText;

  const referenced = new Set<string>();
  for (const m of combinedText.match(/\bF\d{3,4}\b/g) ?? []) referenced.add(m);
  for (const m of combinedText.match(/\bFUN_[A-Za-z0-9_]+/g) ?? []) referenced.add(m);
  for (const m of combinedText.match(/\bC\d{3,4}\b/g) ?? []) referenced.add(m);
  for (const m of combinedText.match(/\bCON_[A-Za-z0-9_]+/g) ?? []) referenced.add(m);
  for (const m of combinedText.match(/\bX\d{3,4}\b/g) ?? []) referenced.add(m);
  for (const m of combinedText.match(/\bEXC_[A-Za-z0-9_]+/g) ?? []) referenced.add(m);

  const coveredFunctions = functions.filter((f) => {
    const id = String(f["id"] ?? "");
    const displayId = String(f["displayId"] ?? "");
    return referenced.has(id) || referenced.has(displayId);
  }).length;

  const coveredConstraints = constraints.filter((c) => {
    const id = String(c["id"] ?? "");
    const displayId = String(c["displayId"] ?? "");
    return referenced.has(id) || referenced.has(displayId);
  }).length;

  const coveredExceptions = exceptions.filter((e) => {
    const id = String(e["id"] ?? "");
    const displayId = String(e["displayId"] ?? "");
    return referenced.has(id) || referenced.has(displayId);
  }).length;

  const totalFn = functions.length;
  const totalCt = constraints.length;
  const totalEx = exceptions.length;

  const covered = coveredFunctions + coveredConstraints + coveredExceptions;
  const total = totalFn + totalCt + totalEx;

  const fnPct = totalFn > 0 ? Math.round((coveredFunctions / totalFn) * 100) : 100;
  const ctPct = totalCt > 0 ? Math.round((coveredConstraints / totalCt) * 100) : 100;
  const exPct = totalEx > 0 ? Math.round((coveredExceptions / totalEx) * 100) : 100;

  const detail = `功能覆盖: ${fnPct}% (${coveredFunctions}/${totalFn}), 约束覆盖: ${ctPct}% (${coveredConstraints}/${totalCt}), 异常覆盖: ${exPct}% (${coveredExceptions}/${totalEx})`;

  if (covered < total) {
    return {
      name: "覆盖率",
      passed: false,
      detail,
    };
  }

  return { name: "覆盖率", passed: true, detail };
}

// ---------------------------------------------------------------------------
// Check 4: 自编 ID 检测
// ---------------------------------------------------------------------------

function _checkSelfInventedIds(
  requirementJson: Record<string, unknown>,
  designText: string,
  testCasesText: string,
): ReviewValidationCheck {
  const definedIds = _collectDefinedIds(requirementJson);
  const combinedText = designText + "\n" + testCasesText;

  // Find all F001-C999-X001 patterns
  const allRefs = new Set<string>();
  for (const m of combinedText.match(/\b[FCX]\d{3,4}\b/g) ?? []) allRefs.add(m);
  for (const m of combinedText.match(/\b(FUN|CON|EXC)_[A-Za-z0-9_]+/g) ?? []) allRefs.add(m);

  const invented = [...allRefs].filter((ref) => !definedIds.has(ref)).sort();

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
// Check 5: 约束设计覆盖
// ---------------------------------------------------------------------------

function _checkConstraintDesignCoverage(
  requirementJson: Record<string, unknown>,
  designText: string,
): ReviewValidationCheck {
  const constraints = asArray(requirementJson["constraints"]);
  if (constraints.length === 0) {
    return { name: "约束设计覆盖", passed: true, detail: "无约束需要覆盖" };
  }

  const uncovered: string[] = [];
  for (const c of constraints) {
    const displayId = String(c["displayId"] ?? "");
    if (displayId && !designText.includes(displayId)) {
      uncovered.push(displayId);
    }
  }

  if (uncovered.length > 0) {
    return {
      name: "约束设计覆盖",
      passed: false,
      detail: `设计文档未覆盖的约束: ${uncovered.join(", ")}`,
    };
  }

  return {
    name: "约束设计覆盖",
    passed: true,
    detail: `所有 ${constraints.length} 个约束在设计文档中覆盖`,
  };
}

// ---------------------------------------------------------------------------
// Check 6: 约束测试覆盖
// ---------------------------------------------------------------------------

function _checkConstraintTestCoverage(
  requirementJson: Record<string, unknown>,
  testCasesText: string,
): ReviewValidationCheck {
  const constraints = asArray(requirementJson["constraints"]);
  if (constraints.length === 0) {
    return { name: "约束测试覆盖", passed: true, detail: "无约束需要覆盖" };
  }

  const uncovered: string[] = [];
  for (const c of constraints) {
    const displayId = String(c["displayId"] ?? "");
    if (displayId && !testCasesText.includes(displayId)) {
      uncovered.push(displayId);
    }
  }

  if (uncovered.length > 0) {
    return {
      name: "约束测试覆盖",
      passed: false,
      detail: `测试用例未覆盖的约束: ${uncovered.join(", ")}`,
    };
  }

  return {
    name: "约束测试覆盖",
    passed: true,
    detail: `所有 ${constraints.length} 个约束在测试用例中覆盖`,
  };
}

// ---------------------------------------------------------------------------
// Check 7: 空步骤/空预期检测
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

function _collectDefinedIds(requirementJson: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();

  const functions = asArray(requirementJson["functions"]);
  const constraints = asArray(requirementJson["constraints"]);
  const exceptions = asArray(requirementJson["exceptions"]);
  const entities = asArray(requirementJson["entities"]);

  for (const f of functions) {
    const id = String(f["id"] ?? "").trim();
    const displayId = String(f["displayId"] ?? "").trim();
    if (id) ids.add(id);
    if (displayId) ids.add(displayId);
  }
  for (const c of constraints) {
    const id = String(c["id"] ?? "").trim();
    const displayId = String(c["displayId"] ?? "").trim();
    if (id) ids.add(id);
    if (displayId) ids.add(displayId);
  }
  for (const e of exceptions) {
    const id = String(e["id"] ?? "").trim();
    const displayId = String(e["displayId"] ?? "").trim();
    if (id) ids.add(id);
    if (displayId) ids.add(displayId);
  }
  for (const ent of entities) {
    const id = String(ent["id"] ?? "").trim();
    if (id) ids.add(id);
  }

  return ids;
}
