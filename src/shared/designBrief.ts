import { RequirementIndex, type RequirementRefKind } from "./requirementIndex.js";
import { extractSalientAnchors } from "./salientAnchors.js";
import { semanticTerms } from "./semanticCoverage.js";

type DesignConstraintType =
  | "business_rule"
  | "permission"
  | "security"
  | "performance"
  | "data_integrity"
  | "workflow"
  | "ui"
  | "integration";

interface DesignBriefAttribute {
  name: string;
  type: string;
  description?: string;
}

interface DesignBriefRelation {
  target: string;
  type: string;
  description?: string;
}

interface DesignBriefFunction {
  id: string;
  name: string;
  description: string;
  subCapabilities?: string[];
  acceptanceCriteria?: string[];
  relatedEntities?: string[];
  relatedConstraints?: string[];
  relatedExceptions?: string[];
}

interface DesignBriefEntity {
  name: string;
  description: string;
  keyAttributes?: DesignBriefAttribute[];
  relations?: DesignBriefRelation[];
  sourceFunctions?: string[];
  sourceConstraints?: string[];
}

interface DesignBriefConstraint {
  id: string;
  type: DesignConstraintType;
  sourceText: string;
  description?: string;
  anchors?: string[];
  relatedFunctions?: string[];
  relatedEntities?: string[];
}

interface DesignBriefException {
  id: string;
  description: string;
  sourceText: string;
  trigger?: string;
  handling?: string;
  anchors?: string[];
  relatedFunctions?: string[];
  relatedEntities?: string[];
}

interface DesignCoverageSkeletonEntry {
  refId: string;
  refKind: RequirementRefKind;
  originalText?: string;
  anchors?: string[];
}

export interface DesignBrief {
  version: 1;
  project: {
    name: string;
    overview: string;
  };
  designContract: {
    idPolicy: string;
    allowedFunctionIds: string[];
    allowedConstraintIds: string[];
    allowedExceptionIds: string[];
    allowedEntityNames: string[];
  };
  functions: DesignBriefFunction[];
  entities: DesignBriefEntity[];
  constraints: DesignBriefConstraint[];
  exceptions: DesignBriefException[];
  coverageSkeleton: DesignCoverageSkeletonEntry[];
}

type ReqRecord = Record<string, unknown>;

const DISPLAY_ID_RE = /^[FCX]\d{3,4}$/;
const INTERNAL_REQ_ID_RE = /^(?:FUN|CON|EXC)_[A-Za-z0-9_]+$/;
const ATTR_PRIORITY_RE = /(?:^id$|Id$|ID$|name|title|status|state|type|date|time|amount|total|price|count|number|no$|code|password|key|role|permission|doctor|patient|drug|record|order|prescription|schedule|appointment|payment)/i;

function asRecords(value: unknown): ReqRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is ReqRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.map((item) => String(item ?? "").trim()).filter(Boolean));
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function compactList(values: string[], limit: number): string[] | undefined {
  const result = unique(values).slice(0, limit);
  return result.length > 0 ? result : undefined;
}

function compactField<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined;
}

function publicId(rec: ReqRecord): string {
  const displayId = text(rec.displayId);
  if (displayId) return displayId;
  const id = text(rec.id);
  if (id) return id;
  const constraintRef = text(rec.constraintRef);
  return constraintRef;
}

function sourceText(rec: ReqRecord, fallbackFields: string[]): string {
  const direct = text(rec.source_text) || text(rec.sourceText);
  if (direct) return direct;
  return fallbackFields.map((field) => text(rec[field])).filter(Boolean).join(" / ");
}

function functionText(fn: ReqRecord): string {
  return [
    fn.name,
    fn.description,
    fn.preconditions,
    ...asStrings(fn.sub_capabilities),
    ...asStrings(fn.acceptance_criteria),
  ].map((part) => text(part)).filter(Boolean).join(" ");
}

function exceptionText(exc: ReqRecord): string {
  return [
    exc.description,
    exc.source_text,
    exc.sourceText,
    exc.trigger,
    exc.handling,
  ].map((part) => text(part)).filter(Boolean).join(" ");
}

function buildIdMap(items: ReqRecord[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    const display = publicId(item);
    if (!display) continue;
    const ids = [item.displayId, item.id].map((id) => text(id)).filter(Boolean);
    for (const id of ids) map.set(id, display);
  }
  return map;
}

function normalizeRefs(value: unknown, idMap: Map<string, string>, allowed: Set<string>): string[] {
  return unique(asStrings(value).map((id) => idMap.get(id) ?? id).filter((id) => allowed.has(id)));
}

function termsOverlap(a: string, b: string): boolean {
  const aTerms = new Set(semanticTerms(a));
  if (aTerms.size === 0) return false;
  for (const term of semanticTerms(b)) {
    if (aTerms.has(term)) return true;
  }
  return false;
}

function linkedFunctions(
  rec: ReqRecord,
  recText: string,
  functions: ReqRecord[],
  functionIdMap: Map<string, string>,
  allowedFunctionIds: Set<string>,
): string[] {
  const explicit = normalizeRefs(rec.related_functions ?? rec.relatedFunctions, functionIdMap, allowedFunctionIds);
  if (explicit.length > 0) return explicit;
  return unique(functions
    .filter((fn) => termsOverlap(recText, functionText(fn)))
    .map(publicId)
    .filter((id) => allowedFunctionIds.has(id)));
}

function entityNamesFromText(source: string, entityRecords: ReqRecord[]): string[] {
  const found: string[] = [];
  for (const entity of entityRecords) {
    const name = text(entity.name ?? entity.canonicalName);
    if (!name) continue;
    const aliases = [
      name,
      text(entity.displayName),
      ...asStrings(entity.aliases),
      text(entity.description),
    ].filter(Boolean);
    if (aliases.some((alias) => source.includes(alias) || termsOverlap(alias, source))) {
      found.push(name);
    }
  }
  return unique(found);
}

function entityNamesForFunction(fn: ReqRecord, entityRecords: ReqRecord[]): string[] {
  return entityNamesFromText(functionText(fn), entityRecords);
}

function classifyConstraintType(rec: ReqRecord): DesignConstraintType {
  const s = [
    rec.type,
    rec.constraintType,
    rec.category,
    rec.description,
    rec.source_text,
    rec.sourceText,
    rec.canonicalRule,
    rec.canonicalRuleEn,
  ].map((part) => text(part)).join(" ").toLowerCase();

  if (/(rbac|permission|role|access|authorize|authz|权限|角色|不可|只能|双签|主任|审核)/i.test(s)) return "permission";
  if (/(encrypt|decrypt|aes|twofish|rijndael|tls|https|password|key|hash|脱敏|加密|密钥|密码|安全)/i.test(s)) return "security";
  if (/(qps|rps|ms|seconds?|timeout|latency|concurrent|throughput|响应|并发|超时|秒内|性能)/i.test(s)) return "performance";
  if (/(audit|log|trace|history|immutable|unique|integrity|consistent|留痕|审计|日志|唯一|一致|校验|修改记录)/i.test(s)) return "data_integrity";
  if (/(workflow|state|status|approve|approval|process|流程|状态|审批|审核|流转)/i.test(s)) return "workflow";
  if (/(ui|screen|form|button|display|页面|界面|按钮|展示)/i.test(s)) return "ui";
  if (/(api|integration|external|webhook|同步|接口|第三方|集成)/i.test(s)) return "integration";
  return "business_rule";
}

function selectKeyAttributes(entity: ReqRecord): DesignBriefAttribute[] {
  const attrs = asRecords(entity.attributes);
  const normalized = attrs
    .map((attr) => ({
      name: text(attr.name),
      type: text(attr.type) || "string",
      description: text(attr.description),
      priority: ATTR_PRIORITY_RE.test(text(attr.name)) ? 0 : 1,
    }))
    .filter((attr) => attr.name);

  return normalized
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 8)
    .map(({ name, type, description }) => ({ name, type, ...(description ? { description } : {}) }));
}

function normalizeRelations(entity: ReqRecord, allowedEntityNames: Set<string>): DesignBriefRelation[] {
  const rels = asRecords(entity.relationships ?? entity.relations);
  const normalized: DesignBriefRelation[] = [];
  for (const rel of rels) {
    const target = text(rel.target ?? rel.to ?? rel.entity ?? rel.name);
    if (!target || !allowedEntityNames.has(target)) continue;
    const type = text(rel.type ?? rel.relationship ?? rel.kind) || "related_to";
    const description = text(rel.description ?? rel.label);
    normalized.push({ target, type, ...(description ? { description } : {}) });
  }
  return normalized;
}

function skeletonEntry(
  refId: string,
  refKind: RequirementRefKind,
  originalText: string,
  anchors: string[] = [],
): DesignCoverageSkeletonEntry {
  return {
    refId,
    refKind,
    ...(originalText ? { originalText } : {}),
    ...(anchors.length > 0 ? { anchors } : {}),
  };
}

function publicIdsOnly(ids: string[]): string[] {
  return ids.filter((id) => DISPLAY_ID_RE.test(id) || !INTERNAL_REQ_ID_RE.test(id));
}

export function buildDesignBrief(requirementJson: Record<string, unknown>): DesignBrief {
  const requirementIndex = RequirementIndex.fromRequirementJson(requirementJson);
  const functions = asRecords(requirementJson.functions);
  const entities = asRecords(requirementJson.entities);
  const constraints = asRecords(requirementJson.constraints);
  const exceptions = asRecords(requirementJson.exceptions);

  const functionIdMap = buildIdMap(functions);

  const allowedFunctionIds = new Set(publicIdsOnly(functions.map(publicId).filter(Boolean)));
  const allowedConstraintIds = new Set(publicIdsOnly(constraints.map(publicId).filter(Boolean)));
  const allowedExceptionIds = new Set(publicIdsOnly(exceptions.map(publicId).filter(Boolean)));
  const allowedEntityNames = new Set(entities.map((entity) => text(entity.name ?? entity.canonicalName)).filter(Boolean));

  const functionEntities = new Map<string, string[]>();
  for (const fn of functions) {
    const id = publicId(fn);
    if (!id) continue;
    functionEntities.set(id, entityNamesForFunction(fn, entities));
  }

  const constraintLinks = constraints.map((constraint) => {
    const id = publicId(constraint);
    const source = sourceText(constraint, ["description", "canonicalRule", "canonicalRuleEn"]);
    const desc = text(constraint.description) || source;
    const relatedFunctions = linkedFunctions(
      constraint,
      [desc, source, text(constraint.canonicalRule), text(constraint.canonicalRuleEn)].join(" "),
      functions,
      functionIdMap,
      allowedFunctionIds,
    );
    const entitiesFromOwnText = entityNamesFromText([desc, source].join(" "), entities);
    const entitiesFromFunctions = relatedFunctions.flatMap((fnId) => functionEntities.get(fnId) ?? []);
    const anchors = extractSalientAnchors([source, desc].join(" "));
    const compactRelatedFunctions = compactList(relatedFunctions, 6);
    const compactRelatedEntities = compactList(
      unique([...entitiesFromOwnText, ...entitiesFromFunctions]).filter((name) => allowedEntityNames.has(name)),
      5,
    );
    return {
      id,
      type: classifyConstraintType(constraint),
      sourceText: source,
      ...(desc && desc !== source ? { description: desc } : {}),
      ...(anchors.length > 0 ? { anchors } : {}),
      ...(compactRelatedFunctions ? { relatedFunctions: compactRelatedFunctions } : {}),
      ...(compactRelatedEntities ? { relatedEntities: compactRelatedEntities } : {}),
    };
  }).filter((constraint) => constraint.id && allowedConstraintIds.has(constraint.id));

  const exceptionLinks = exceptions.map((exception) => {
    const id = publicId(exception);
    const source = sourceText(exception, ["description", "trigger", "handling"]);
    const trigger = text(exception.trigger);
    const handling = text(exception.handling);
    const desc = text(exception.description) || source;
    const recText = exceptionText(exception);
    const relatedFunctions = linkedFunctions(exception, recText, functions, functionIdMap, allowedFunctionIds);
    const entitiesFromOwnText = entityNamesFromText(recText, entities);
    const entitiesFromFunctions = relatedFunctions.flatMap((fnId) => functionEntities.get(fnId) ?? []);
    const anchors = extractSalientAnchors(recText);
    const compactRelatedFunctions = compactList(relatedFunctions, 6);
    const compactRelatedEntities = compactList(
      unique([...entitiesFromOwnText, ...entitiesFromFunctions]).filter((name) => allowedEntityNames.has(name)),
      5,
    );
    return {
      id,
      description: desc,
      sourceText: source,
      ...(trigger ? { trigger } : {}),
      ...(handling ? { handling } : {}),
      ...(anchors.length > 0 ? { anchors } : {}),
      ...(compactRelatedFunctions ? { relatedFunctions: compactRelatedFunctions } : {}),
      ...(compactRelatedEntities ? { relatedEntities: compactRelatedEntities } : {}),
    };
  }).filter((exception) => exception.id && allowedExceptionIds.has(exception.id));

  const constraintIdsByFunction = new Map<string, string[]>();
  for (const constraint of constraintLinks) {
    for (const fnId of constraint.relatedFunctions ?? []) {
      constraintIdsByFunction.set(fnId, [...(constraintIdsByFunction.get(fnId) ?? []), constraint.id]);
    }
  }

  const exceptionIdsByFunction = new Map<string, string[]>();
  for (const exception of exceptionLinks) {
    for (const fnId of exception.relatedFunctions ?? []) {
      exceptionIdsByFunction.set(fnId, [...(exceptionIdsByFunction.get(fnId) ?? []), exception.id]);
    }
  }

  const briefFunctions: DesignBriefFunction[] = functions
    .map((fn) => {
      const id = publicId(fn);
      const subCapabilities = compactList(asStrings(fn.sub_capabilities), 8);
      const acceptanceCriteria = compactList(asStrings(fn.acceptance_criteria), 8);
      const relatedEntities = compactList(functionEntities.get(id) ?? [], 5);
      const relatedConstraints = compactList(constraintIdsByFunction.get(id) ?? [], 8);
      const relatedExceptions = compactList(exceptionIdsByFunction.get(id) ?? [], 5);
      return {
        id,
        name: text(fn.name) || id,
        description: text(fn.description),
        ...(subCapabilities ? { subCapabilities } : {}),
        ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
        ...(relatedEntities ? { relatedEntities } : {}),
        ...(relatedConstraints ? { relatedConstraints } : {}),
        ...(relatedExceptions ? { relatedExceptions } : {}),
      };
    })
    .filter((fn) => fn.id && allowedFunctionIds.has(fn.id));

  const sourceFunctionsByEntity = new Map<string, string[]>();
  for (const fn of briefFunctions) {
    for (const entityName of fn.relatedEntities ?? []) {
      sourceFunctionsByEntity.set(entityName, [...(sourceFunctionsByEntity.get(entityName) ?? []), fn.id]);
    }
  }

  const sourceConstraintsByEntity = new Map<string, string[]>();
  for (const constraint of constraintLinks) {
    for (const entityName of constraint.relatedEntities ?? []) {
      sourceConstraintsByEntity.set(entityName, [...(sourceConstraintsByEntity.get(entityName) ?? []), constraint.id]);
    }
  }

  const briefEntities: DesignBriefEntity[] = entities
    .map((entity) => {
      const name = text(entity.name ?? entity.canonicalName);
      const keyAttributes = compactField(selectKeyAttributes(entity));
      const relations = compactField(normalizeRelations(entity, allowedEntityNames));
      const sourceFunctions = compactList(sourceFunctionsByEntity.get(name) ?? [], 6);
      const sourceConstraints = compactList(sourceConstraintsByEntity.get(name) ?? [], 10);
      return {
        name,
        description: text(entity.description),
        ...(keyAttributes ? { keyAttributes } : {}),
        ...(relations ? { relations } : {}),
        ...(sourceFunctions ? { sourceFunctions } : {}),
        ...(sourceConstraints ? { sourceConstraints } : {}),
      };
    })
    .filter((entity) => entity.name);

  const coverageSkeleton: DesignCoverageSkeletonEntry[] = [
    ...briefFunctions.map((fn) => skeletonEntry(
      fn.id,
      "function",
      [fn.name, fn.description, ...(fn.subCapabilities ?? []), ...(fn.acceptanceCriteria ?? [])].filter(Boolean).join(" / "),
    )),
    ...constraintLinks.map((constraint) => skeletonEntry(
      constraint.id,
      "constraint",
      constraint.sourceText || constraint.description || "",
      constraint.anchors ?? [],
    )),
    ...exceptionLinks.map((exception) => skeletonEntry(
      exception.id,
      "exception",
      exception.sourceText || [exception.description, exception.trigger, exception.handling].filter(Boolean).join(" / "),
      exception.anchors ?? [],
    )),
  ];

  return {
    version: 1,
    project: {
      name: text(requirementJson.project_name ?? requirementJson.projectName ?? requirementJson.name),
      overview: text(requirementJson.project_overview ?? requirementJson.projectOverview ?? requirementJson.overview ?? requirementJson.description),
    },
    designContract: {
      idPolicy: "Use only display IDs from this brief in every design refId/constraintId/exceptionId/functionIds field. Do not output FUN_*, CON_* or EXC_* internal IDs.",
      allowedFunctionIds: requirementIndex.functions.length > 0
        ? publicIdsOnly(requirementIndex.functions.map((ref) => ref.displayId))
        : [...allowedFunctionIds],
      allowedConstraintIds: requirementIndex.constraints.length > 0
        ? publicIdsOnly(requirementIndex.constraints.map((ref) => ref.displayId))
        : [...allowedConstraintIds],
      allowedExceptionIds: requirementIndex.exceptions.length > 0
        ? publicIdsOnly(requirementIndex.exceptions.map((ref) => ref.displayId))
        : [...allowedExceptionIds],
      allowedEntityNames: [...allowedEntityNames],
    },
    functions: briefFunctions,
    entities: briefEntities,
    constraints: constraintLinks,
    exceptions: exceptionLinks,
    coverageSkeleton,
  };
}
