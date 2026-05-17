import { MermaidValidator } from "../generators/mermaid.js";

const ENTITY_NAME_MAP: Record<string, string[]> = {
  用户: ["User", "Account", "Member"],
  管理员: ["Admin", "Administrator", "Manager"],
  学生: ["Student"],
  教师: ["Teacher", "Instructor", "Professor"],
  图书: ["Book"],
  订单: ["Order"],
  商品: ["Product", "Goods", "Item"],
  课程: ["Course"],
  成绩: ["Grade", "Score"],
  选课记录: ["Enrollment", "CourseSelection", "Selection"],
  员工: ["Employee", "Staff", "Worker"],
  会议室: ["MeetingRoom", "Room"],
  预约记录: ["Reservation", "Booking", "Appointment"],
  设备: ["Equipment", "Device", "Facility"],
  顾客: ["Customer", "Client"],
  商家: ["Merchant", "Seller", "Shop"],
  平台管理员: ["PlatformAdmin", "Admin"],
  购物车: ["Cart", "ShoppingCart"],
  支付: ["Payment", "Pay"],
  退款: ["Refund"],
  医院: ["Hospital"],
  挂号: ["Registration"],
  医生: ["Doctor"],
  病人: ["Patient"],
  患者: ["Patient"],
  号源: ["Source", "NumberSource"],
  就诊记录: ["VisitRecord", "MedicalRecord"],
  预约: ["Appointment", "Reservation"],
  科室: ["Department"],
  排班: ["Schedule", "Duty"],
  借阅记录: ["BorrowRecord", "LendingRecord", "Loan"],
  学期: ["Semester", "Term"],
};

const FUNCTION_SYNONYMS: Record<string, string[]> = {
  用户注册: ["注册", "用户注册与登录", "注册与登录"],
  用户登录: ["登录", "用户注册与登录", "注册与登录", "登录系统"],
  图书搜索: ["搜索图书", "图书查询", "查询图书", "检索"],
  图书借阅: ["借阅图书", "借书", "借阅"],
  图书归还: ["归还图书", "还书", "归还"],
  借阅管理: ["借阅记录管理", "图书借阅管理"],
  图书管理: ["图书信息管理", "图书维护"],
  选课: ["课程选择", "选择课程"],
  退课: ["退选", "取消选课"],
  课程发布: ["发布课程", "创建课程"],
  课程审核: ["审核课程"],
  成绩录入: ["录入成绩", "成绩管理"],
  课表查看: ["查看课表", "课表查询"],
  订单管理: ["查看订单", "订单查看"],
  订单取消: ["取消订单"],
  退款申请: ["申请退款"],
  退款处理: ["处理退款", "退款审核"],
  购物车管理: ["管理购物车"],
  下单支付: ["下单", "支付", "下单与支付"],
  商品浏览: ["浏览商品", "查看商品"],
  用户注册与登录: ["注册", "登录", "用户注册", "用户登录"],
  预约申请: ["提交预约", "发起预约"],
  预约审批: ["审批预约", "审核预约"],
  取消预约: ["预约取消"],
  预约查看: ["查看预约", "预约查询"],
  会议室管理: ["管理会议室"],
  设备管理: ["管理设备"],
  患者注册: ["注册", "患者注册与登录"],
  科室浏览: ["浏览科室", "查看科室"],
  医生查询: ["查询医生", "查看医生"],
  排班管理: ["管理排班", "医生排班"],
  预约挂号: ["挂号预约", "挂号"],
  就诊管理: ["管理就诊"],
  就诊记录: ["查看就诊记录"],
  会议室浏览: ["浏览会议室", "查看会议室"],
  预约管理: ["管理预约"],
  挂号管理: ["管理挂号"],
};

const EN_TO_CN: Record<string, string[]> = {};
for (const [cn, enNames] of Object.entries(ENTITY_NAME_MAP)) {
  for (const en of enNames) {
    EN_TO_CN[en.toLowerCase()] ??= [];
    EN_TO_CN[en.toLowerCase()].push(cn);
  }
}

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

export function fuzzyMatchEntity(entityName: string, target: string): boolean {
  const entity = String(entityName ?? "");
  const text = String(target ?? "");
  if (!entity || !text) return false;
  if (text.includes(entity)) return true;
  for (const en of ENTITY_NAME_MAP[entity] ?? []) {
    if (text.includes(en)) return true;
  }
  return (EN_TO_CN[entity.toLowerCase()] ?? []).some((cn) => text.includes(cn));
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
): boolean {
  const name = String(funcName ?? "");
  if (!name) return false;
  if (resultText.includes(name)) return true;

  const keywords = name.split(RE_FUNC_SPLIT).filter((kw) => kw.length > 1);
  if (keywords.length >= 2 && keywords.every((kw) => resultText.includes(kw))) {
    return true;
  }

  for (const synonym of FUNCTION_SYNONYMS[name] ?? []) {
    if (resultText.includes(synonym)) return true;
    if (resultFunctions.some((item) => synonym.includes(item) || item.includes(synonym))) {
      return true;
    }
  }

  for (const resultName of resultFunctions) {
    if ((FUNCTION_SYNONYMS[resultName] ?? []).includes(name)) {
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
): number {
  if (!result || !gold) return 0;
  let total = 0;
  let covered = 0;

  const expectedActors = readNames(gold.expected_actors);
  const resultActors = readNames(result.actors);
  for (const actor of expectedActors) {
    total += 1;
    if (resultActors.some((item) => fuzzyMatchEntity(actor, item))) covered += 1;
  }

  const expectedFunctions = readNames(gold.expected_functions);
  const resultFunctions = readNames(result.functions);
  const resultText = resultFunctions.join(" ");
  for (const func of expectedFunctions) {
    total += 1;
    if (fuzzyMatchFunction(func, resultFunctions, resultText)) covered += 1;
  }

  const expectedEntities = readNames(gold.expected_entities);
  const resultEntities = readNames(result.entities);
  for (const entity of expectedEntities) {
    total += 1;
    if (resultEntities.some((item) => fuzzyMatchEntity(entity, item))) covered += 1;
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
): number {
  if (!result || !gold) return 0;
  const expectedEntities = readNames(gold.expected_entities);
  const resultEntities = readNames(result.entities);
  if (expectedEntities.length === 0) return 100;
  const correct = expectedEntities.filter((entity) => resultEntities.some((item) => fuzzyMatchEntity(entity, item))).length;
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
): number {
  if (!result) return 0;
  let score = 100;
  const entities = readNames(result.entities);
  const classDiagram = String(diagrams?.class_diagram ?? "");
  for (const entity of entities) {
    if (entity && !fuzzyMatchEntity(entity, classDiagram)) score -= 10;
  }

  const activity = String(diagrams?.activity_diagram ?? "");
  const state = String(diagrams?.state_diagram ?? "");
  const coreClasses = entities.filter(Boolean).slice(0, 3);
  for (const item of coreClasses) {
    if (activity && !fuzzyMatchEntity(item, activity)) score -= 5;
    if (state && !fuzzyMatchEntity(item, state)) score -= 3;
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
