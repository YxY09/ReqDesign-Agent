import { MermaidValidator } from "../generators/mermaid.js";

const RE_CONSTRAINT_SPLIT = /[，,、;；（）()\s的时了后]/;
const RE_NUMBER_QUANT = /\d+\s*[分天时月秒门]/g;
const RE_FUNC_SPLIT = /[与和及、]/;
const RE_STATE_QUOTED = /state\s+"([^"]+)"/g;
const RE_STATE_UNQUOTED = /state\s+(?!"|\[)(\S+)/g;
const RE_ARROW_LEFT = /(\S+)\s*-->/g;
const RE_ARROW_RIGHT = /-->\s*(\S+)/g;
const RE_CORE_NOUNS = /[\u4e00-\u9fff]{2,4}/g;

function readNames(items: unknown, preferredKey = "name"): string[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    if (typeof item === "string") return item;
    if (typeof item === "object" && item !== null) {
      const record = item as Record<string, unknown>;
      return String(record[preferredKey] ?? record.description ?? "");
    }
    return String(item);
  }).filter(Boolean);
}

export function fuzzyMatchEntity(
  entityName: string,
  target: string,
  entityNameMap: Record<string, string[]> = {},
): boolean {
  const entity = String(entityName ?? "");
  const text = String(target ?? "");
  if (!entity || !text) return false;
  if (text.includes(entity)) return true;

  // Build EN_TO_CN from entityNameMap
  const enToCn: Record<string, string[]> = {};
  for (const [cn, enNames] of Object.entries(entityNameMap)) {
    for (const en of enNames) {
      enToCn[en.toLowerCase()] ??= [];
      enToCn[en.toLowerCase()].push(cn);
    }
  }

  for (const en of entityNameMap[entity] ?? []) {
    if (text.includes(en)) return true;
  }
  return (enToCn[entity.toLowerCase()] ?? []).some((cn) => text.includes(cn));
}

export function editDistance(s1: string, s2: string, threshold = -1): number {
  if (s1.length < s2.length) return editDistance(s2, s1, threshold);
  if (s2.length === 0) return s1.length;
  let previous = [...Array(s2.length + 1).keys()];
  for (let i = 0; i < s1.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < s2.length; j++) {
      const insertions = previous[j + 1] + 1;
      const deletions = current[j] + 1;
      const substitutions = previous[j] + (s1[i] === s2[j] ? 0 : 1);
      current.push(Math.min(insertions, deletions, substitutions));
    }
    if (threshold >= 0 && Math.min(...current) > threshold) {
      return threshold + 1;
    }
    previous = current;
  }
  return previous[previous.length - 1];
}

export function fuzzyMatchFunction(
  funcName: string,
  resultFunctions: string[],
  resultText: string,
  functionSynonyms: Record<string, string[]> = {},
): boolean {
  const name = String(funcName ?? "");
  if (!name) return false;
  if (resultText.includes(name)) return true;

  const keywords = name.split(RE_FUNC_SPLIT).filter((kw) => kw.length > 1);
  if (keywords.length >= 2 && keywords.every((kw) => resultText.includes(kw))) {
    return true;
  }

  for (const synonym of functionSynonyms[name] ?? []) {
    if (resultText.includes(synonym)) return true;
    if (resultFunctions.some((item) => synonym.includes(item) || item.includes(synonym))) {
      return true;
    }
  }

  for (const resultName of resultFunctions) {
    if ((functionSynonyms[resultName] ?? []).includes(name)) {
      return true;
    }
  }

  if (name.length >= 6) {
    const threshold = Math.max(1, Math.floor(name.length / 4));
    for (const resultName of resultFunctions) {
      if (Math.abs(name.length - resultName.length) <= 2) {
        if (editDistance(name, resultName, threshold) <= threshold) {
          return true;
        }
      }
    }
  }

  return false;
}

export function matchConstraintOrException(expected: string, targetText: string): boolean {
  const source = String(expected ?? "");
  const target = String(targetText ?? "");
  if (!source || !target) return false;
  if (target.includes(source)) return true;

  let keywords = source.split(RE_CONSTRAINT_SPLIT).filter((kw) => kw.length >= 2);
  if (keywords.length === 0) {
    keywords = Array.from({ length: Math.max(0, source.length - 1) }, (_, index) => source.slice(index, index + 2));
  }
  if (keywords.length === 0) return false;
  if (keywords.every((kw) => target.includes(kw))) return true;

  const matched = keywords.filter((kw) => target.includes(kw)).length;
  if (keywords.length >= 2 && matched / keywords.length >= 0.7) return true;

  const numberMatches = source.match(RE_NUMBER_QUANT) ?? [];
  if (numberMatches.length > 0 && numberMatches.some((item) => target.includes(item))) {
    return true;
  }

  const coreNouns = (source.match(RE_CORE_NOUNS) ?? []).filter((item) => !["系统", "时应", "提示", "后不"].includes(item));
  if (coreNouns.length >= 2) {
    const nounMatched = coreNouns.filter((item) => target.includes(item)).length;
    if (nounMatched / coreNouns.length >= 0.5) return true;
  }

  return false;
}

export function scoreRequirementCoverage(
  result: Record<string, unknown>,
  gold: Record<string, unknown>,
  entityNameMap: Record<string, string[]> = {},
  functionSynonyms: Record<string, string[]> = {},
): number {
  if (!result || !gold) return 0;
  let total = 0;
  let covered = 0;

  const expectedActors = readNames(gold.expected_actors);
  const resultActors = readNames(result.actors);
  for (const actor of expectedActors) {
    total += 1;
    if (resultActors.some((item) => fuzzyMatchEntity(actor, item, entityNameMap))) covered += 1;
  }

  const expectedFunctions = readNames(gold.expected_functions);
  const resultFunctions = readNames(result.functions);
  const resultText = resultFunctions.join(" ");
  for (const func of expectedFunctions) {
    total += 1;
    if (fuzzyMatchFunction(func, resultFunctions, resultText, functionSynonyms)) covered += 1;
  }

  const expectedEntities = readNames(gold.expected_entities);
  const resultEntities = readNames(result.entities);
  for (const entity of expectedEntities) {
    total += 1;
    if (resultEntities.some((item) => fuzzyMatchEntity(entity, item, entityNameMap))) covered += 1;
  }

  const expectedConstraints = readNames(gold.expected_constraints);
  const resultConstraints = readNames(result.constraints, "description");
  const constraintText = resultConstraints.join(" ");
  for (const constraint of expectedConstraints) {
    total += 1;
    if (matchConstraintOrException(constraint, constraintText)) covered += 1;
  }

  const expectedExceptions = readNames(gold.expected_exceptions);
  const resultExceptions = readNames(result.exceptions, "description");
  const exceptionText = resultExceptions.join(" ");
  for (const item of expectedExceptions) {
    total += 1;
    if (matchConstraintOrException(item, exceptionText)) covered += 1;
  }

  if (total === 0) return 0;
  return Math.round((covered / total) * 1000) / 10;
}

export function scoreDiagramSyntax(diagrams: Record<string, unknown>): number {
  if (!diagrams || Object.keys(diagrams).length === 0) return 0;
  const validator = new MermaidValidator();
  let passed = 0;
  for (const [name, content] of Object.entries(diagrams)) {
    if (typeof content !== "string" || !content.trim()) continue;
    const result = validator.validate(content, name);
    if (result.valid) passed += 1;
  }
  return Math.round((passed / Object.keys(diagrams).length) * 1000) / 10;
}

export function scoreEntityAccuracy(
  result: Record<string, unknown>,
  gold: Record<string, unknown>,
  entityNameMap: Record<string, string[]> = {},
): number {
  if (!result || !gold) return 0;
  const expectedEntities = readNames(gold.expected_entities);
  const resultEntities = readNames(result.entities);
  if (expectedEntities.length === 0) return 100;
  const correct = expectedEntities.filter((entity) => resultEntities.some((item) => fuzzyMatchEntity(entity, item, entityNameMap))).length;
  return Math.round((correct / expectedEntities.length) * 1000) / 10;
}

export function scoreProcessCompleteness(
  diagrams: Record<string, unknown>,
  gold: Record<string, unknown>,
): number {
  const activity = String(diagrams?.activity_diagram ?? "");
  if (!activity) return 0;

  let score = 0;
  const startKeywords = ["[开始]", "([开始])", "[*]", "([开始", "开始"];
  const endKeywords = ["[结束]", "([结束])", "[*]", "([结束", "结束"];
  if (startKeywords.some((kw) => activity.includes(kw))) score += 25;
  if (endKeywords.some((kw) => activity.includes(kw))) score += 25;
  if (/\w+\s*\{[^}]+\}/.test(activity)) score += 25;

  const expectedProcesses = readNames(gold?.expected_processes);
  if (expectedProcesses.length === 0) {
    score += 25;
  } else {
    const covered = expectedProcesses.filter((proc) => {
      const keywords = proc.split("流程").filter(Boolean);
      if (keywords.length === 0) return activity.includes(proc);
      return keywords.some((kw) => activity.includes(kw));
    }).length;
    score += (covered / expectedProcesses.length) * 25;
  }

  return Math.round(score * 10) / 10;
}

export function scoreStateDiagram(
  diagrams: Record<string, unknown>,
  gold: Record<string, unknown>,
): number {
  const state = String(diagrams?.state_diagram ?? "");
  if (!state) return 0;
  let score = 0;
  if (state.includes("[*]")) score += 30;
  else if (["开始", "Start", "start"].some((kw) => state.includes(kw))) score += 30;
  if (state.includes("-->")) score += 20;

  const quotedStates = [...state.matchAll(RE_STATE_QUOTED)].map((match) => match[1]);
  const unquotedStates = [...state.matchAll(RE_STATE_UNQUOTED)].map((match) => match[1]);
  const arrowStates = [
    ...[...state.matchAll(RE_ARROW_LEFT)].map((match) => match[1]),
    ...[...state.matchAll(RE_ARROW_RIGHT)].map((match) => match[1]),
  ];
  const allStates = new Set([...quotedStates, ...unquotedStates, ...arrowStates].filter((item) => item !== "*" && item.length > 1));
  if (allStates.size >= 3) score += 25;
  else if (allStates.size >= 2) score += 15;

  const expectedProcesses = readNames(gold?.expected_processes);
  if (expectedProcesses.length === 0) {
    score += 25;
  } else {
    const covered = expectedProcesses.filter((proc) => {
      const keywords = proc.split("流程").filter(Boolean);
      return (keywords.length > 0 ? keywords : [proc]).some((kw) => state.includes(kw));
    }).length;
    score += (covered / expectedProcesses.length) * 25;
  }

  return Math.round(Math.min(100, score) * 10) / 10;
}

export function scoreConsistency(
  result: Record<string, unknown>,
  diagrams: Record<string, unknown>,
  entityNameMap: Record<string, string[]> = {},
): number {
  if (!result) return 0;
  let score = 100;
  const entities = readNames(result.entities);
  const classDiagram = String(diagrams?.class_diagram ?? "");
  for (const entity of entities) {
    if (entity && !fuzzyMatchEntity(entity, classDiagram, entityNameMap)) score -= 10;
  }

  const activity = String(diagrams?.activity_diagram ?? "");
  const state = String(diagrams?.state_diagram ?? "");
  const coreClasses = entities.filter(Boolean).slice(0, 3);
  for (const item of coreClasses) {
    if (activity && !fuzzyMatchEntity(item, activity, entityNameMap)) score -= 5;
    if (state && !fuzzyMatchEntity(item, state, entityNameMap)) score -= 3;
  }

  return Math.round(Math.max(0, score) * 10) / 10;
}

export function computeOverallScore(params: {
  requirementCoverage: number;
  diagramSyntax: number;
  entityAccuracy: number;
  processCompleteness: number;
  consistency: number;
  stateDiagram?: number;
}): number {
  const overall = params.requirementCoverage * 0.35
    + params.diagramSyntax * 0.2
    + params.entityAccuracy * 0.2
    + params.processCompleteness * 0.1
    + (params.stateDiagram ?? 0) * 0.05
    + params.consistency * 0.1;
  return Math.round(overall * 10) / 10;
}

export interface BenchmarkCaseResult {
  case_name: string;
  status: string;
  passed?: boolean;
  scores?: Record<string, number>;
  error?: string;
}

export function computeRunSummary(results: BenchmarkCaseResult[]): Record<string, unknown> {
  const success = results.filter((item) => item.status === "success");
  if (success.length === 0) {
    return { passed: 0, failed: 0, error: results.length, avg_scores: {} };
  }

  const passed = success.filter((item) => item.passed).length;
  const failed = success.length - passed;
  const error = results.length - success.length;
  const metrics = [
    "requirement_coverage",
    "diagram_syntax",
    "entity_accuracy",
    "process_completeness",
    "state_diagram",
    "consistency",
    "overall",
  ];
  const avgScores: Record<string, number> = {};
  for (const metric of metrics) {
    const values = success.map((item) => item.scores?.[metric] ?? 0);
    avgScores[metric] = values.length > 0
      ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
      : 0;
  }
  return { passed, failed, error, avg_scores: avgScores };
}
