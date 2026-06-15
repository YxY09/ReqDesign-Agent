import { semanticCoverageState } from "./semanticCoverage.js";

/**
 * Coverage Validator - 程序化检查覆盖率
 *
 * 检查项：
 * 1. Function test coverage：每个 function 至少被一个 test case 引用
 * 2. Constraint verification coverage：每个 constraint 至少被一个 test case 引用
 * 3. Exception test coverage：每个 exception 至少被一个 test case 引用
 * 4. Constraint design coverage：每个 constraint 至少在设计文档中被引用
 * 5. Invalid reference detection：test/design 引用了不存在的 ID
 * 6. Self-invented ID detection：test/design 自己编的 ID
 */

export interface CoverageReport {
  functionCoverage: { total: number; covered: number; uncovered: Array<{ id: string; displayId: string; name: string }> };
  constraintTestCoverage: { total: number; covered: number; uncovered: Array<{ id: string; displayId: string; description: string }> };
  constraintDesignCoverage: { total: number; covered: number; uncovered: Array<{ id: string; displayId: string; description: string }> };
  exceptionCoverage: { total: number; covered: number; uncovered: Array<{ id: string; displayId: string; description: string }> };
  invalidReferences: string[];
  overall: number; // 0-100
}

export function validateCoverage(
  requirementJson: Record<string, unknown>,
  designText: string,
  testCasesText: string,
): CoverageReport {
  const functions = asArray(requirementJson["functions"]);
  const constraints = asArray(requirementJson["constraints"]);
  const exceptions = asArray(requirementJson["exceptions"]);

  // Build defined ID sets
  const definedFunctionIds = new Set<string>();
  const definedConstraintIds = new Set<string>();
  const definedExceptionIds = new Set<string>();

  for (const f of functions) {
    const id = String(f.id ?? "");
    const displayId = String(f.displayId ?? "");
    if (id) definedFunctionIds.add(id);
    if (displayId) definedFunctionIds.add(displayId);
  }
  for (const c of constraints) {
    const id = String(c.id ?? "");
    const displayId = String(c.displayId ?? "");
    if (id) definedConstraintIds.add(id);
    if (displayId) definedConstraintIds.add(displayId);
  }
  for (const e of exceptions) {
    const id = String(e.id ?? "");
    const displayId = String(e.displayId ?? "");
    if (id) definedExceptionIds.add(id);
    if (displayId) definedExceptionIds.add(displayId);
  }

  // Extract referenced IDs from test cases text
  const testFunctionRefs = new Set<string>();
  const testConstraintRefs = new Set<string>();
  const testExceptionRefs = new Set<string>();

  for (const m of testCasesText.match(/\bF\d{3}\b/g) ?? []) testFunctionRefs.add(m);
  for (const m of testCasesText.match(/\bFUN_[A-Za-z0-9_]+/g) ?? []) testFunctionRefs.add(m);
  for (const m of testCasesText.match(/\bC\d{3}\b/g) ?? []) testConstraintRefs.add(m);
  for (const m of testCasesText.match(/\bCON_[A-Za-z0-9_]+/g) ?? []) testConstraintRefs.add(m);
  for (const m of testCasesText.match(/\bX\d{3}\b/g) ?? []) testExceptionRefs.add(m);
  for (const m of testCasesText.match(/\bEXC_[A-Za-z0-9_]+/g) ?? []) testExceptionRefs.add(m);

  // Extract referenced IDs from design text
  const designConstraintRefs = new Set<string>();
  for (const m of designText.match(/\bC\d{3}\b/g) ?? []) designConstraintRefs.add(m);
  for (const m of designText.match(/\bCON_[A-Za-z0-9_]+/g) ?? []) designConstraintRefs.add(m);

  // Check function coverage
  const uncoveredFunctions = functions.filter(f => {
    const id = String(f.id ?? "");
    const displayId = String(f.displayId ?? "");
    return !testFunctionRefs.has(id) && !testFunctionRefs.has(displayId);
  }).map(f => ({
    id: String(f.id ?? ""),
    displayId: String(f.displayId ?? ""),
    name: String(f.name ?? ""),
  }));

  // Check constraint test coverage
  const uncoveredConstraintsTest = constraints.filter(c => {
    const id = String(c.id ?? "");
    const displayId = String(c.displayId ?? "");
    return !testConstraintRefs.has(id) && !testConstraintRefs.has(displayId);
  }).map(c => ({
    id: String(c.id ?? ""),
    displayId: String(c.displayId ?? ""),
    description: String(c.description ?? c.text ?? ""),
  }));

  // Check constraint design coverage
  const uncoveredConstraintsDesign = constraints.filter(c => {
    const id = String(c.id ?? "");
    const displayId = String(c.displayId ?? "");
    if (!designConstraintRefs.has(id) && !designConstraintRefs.has(displayId)) return true;
    return semanticCoverageState(
      designText,
      c,
      ["description", "text", "source_text", "sourceText"],
    ) !== "covered";
  }).map(c => ({
    id: String(c.id ?? ""),
    displayId: String(c.displayId ?? ""),
    description: String(c.description ?? c.text ?? ""),
  }));

  // Check exception coverage
  const uncoveredExceptions = exceptions.filter(e => {
    const id = String(e.id ?? "");
    const displayId = String(e.displayId ?? "");
    return !testExceptionRefs.has(id) && !testExceptionRefs.has(displayId);
  }).map(e => ({
    id: String(e.id ?? ""),
    displayId: String(e.displayId ?? ""),
    description: String(e.description ?? e.text ?? ""),
  }));

  // Detect invalid references (referenced but not defined)
  const invalidRefs: string[] = [];
  for (const ref of testFunctionRefs) {
    if (!definedFunctionIds.has(ref)) invalidRefs.push(ref);
  }
  for (const ref of testConstraintRefs) {
    if (!definedConstraintIds.has(ref)) invalidRefs.push(ref);
  }
  for (const ref of testExceptionRefs) {
    if (!definedExceptionIds.has(ref)) invalidRefs.push(ref);
  }
  for (const ref of designConstraintRefs) {
    if (!definedConstraintIds.has(ref)) invalidRefs.push(ref);
  }

  // Calculate overall score
  const totalItems = functions.length + constraints.length * 2 + exceptions.length; // constraints count twice (test + design)
  const coveredItems = (functions.length - uncoveredFunctions.length)
    + (constraints.length - uncoveredConstraintsTest.length)
    + (constraints.length - uncoveredConstraintsDesign.length)
    + (exceptions.length - uncoveredExceptions.length);
  const overall = totalItems > 0 ? Math.round((coveredItems / totalItems) * 100) : 100;

  return {
    functionCoverage: { total: functions.length, covered: functions.length - uncoveredFunctions.length, uncovered: uncoveredFunctions },
    constraintTestCoverage: { total: constraints.length, covered: constraints.length - uncoveredConstraintsTest.length, uncovered: uncoveredConstraintsTest },
    constraintDesignCoverage: { total: constraints.length, covered: constraints.length - uncoveredConstraintsDesign.length, uncovered: uncoveredConstraintsDesign },
    exceptionCoverage: { total: exceptions.length, covered: exceptions.length - uncoveredExceptions.length, uncovered: uncoveredExceptions },
    invalidReferences: [...new Set(invalidRefs)].sort(),
    overall,
  };
}

function asArray(val: unknown): Record<string, unknown>[] {
  if (!Array.isArray(val)) return [];
  return val as Record<string, unknown>[];
}
