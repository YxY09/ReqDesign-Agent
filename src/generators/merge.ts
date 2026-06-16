/**
 * AnalyzeMerger — 基于 LLM 合并多份分析结果。
 *
 * 接收所有分析产物，发送给 LLM 并使用合并 prompt，
 * 返回一份干净、统一的需求 JSON。
 */

import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";
import { createToolError } from "../tools/types.js";
import { BaseGenerator } from "./base.js";
import { RequirementNormalizer } from "../shared/normalizer.js";
import { checkAnalysisQuality, type QualityCheckResult } from "../shared/analysisQualityGate.js";
import { canonicalizeAndLink } from "../shared/canonicalizer.js";
import {
  canonicalizeConstraints as canonicalizeConstraintsNew,
  type ConstraintCandidate,
} from "../shared/constraintCanonicalizer.js";
import type { EntityRegistry } from "../shared/types.js";
import { resolveEntityRef, normalizeRelationType } from "../shared/referenceNormalizer.js";

/**
 * Convert merged constraints to ConstraintCandidate[], run the new
 * ConstraintCanonicalizer, and replace merged["constraints"] with the results.
 *
 * Also adds compatibility fields (id, source_text) for downstream consumers
 * that expect the old format.
 */
export function canonicalizeConstraintsPipeline(merged: Record<string, unknown>): void {
  const rawConstraints = asArray(merged["constraints"]);
  const rawMissing = asArray(merged["missingConstraintCandidates"]);

  // --- Handle constraints ---
  if (rawConstraints.length || rawMissing.length) {
    // Convert regular constraints to ConstraintCandidate[]
    const candidates: ConstraintCandidate[] = rawConstraints.map((c) => ({
      description: String(c.description ?? "").trim(),
      sourceText: String(c.source_text ?? "").trim(),
      sectionId: c.sectionId as string | undefined,
      relatedFunctionCandidates: Array.isArray(c.related_functions)
        ? (c.related_functions as unknown[]).map((r) => String(r))
        : undefined,
    }));

    // Convert missingConstraintCandidates to ConstraintCandidate[] and append
    const missingCandidates: ConstraintCandidate[] = rawMissing.map((c) => ({
      description: String(c.description ?? "").trim(),
      sourceText: String(c.source_text ?? c.sourceText ?? "").trim(),
      sectionId: c.sectionId as string | undefined,
      relatedFunctionCandidates: Array.isArray(c.related_functions)
        ? (c.related_functions as unknown[]).map((r) => String(r))
        : undefined,
    }));
    candidates.push(...missingCandidates);

    // Get functions for linking (already canonical IDs after canonicalizeAndLink)
    const rawFunctions = asArray(merged["functions"]);
    const funcInputs = rawFunctions.map((f) => ({
      id: String(f.id ?? ""),
      displayId: String(f.displayId ?? ""),
      name: String(f.name ?? ""),
    }));

    const canonical = canonicalizeConstraintsNew(candidates, funcInputs);

    // Add compatibility fields for downstream consumers (quality gate, resolveReferences, etc.)
    for (const c of canonical) {
      ((c as unknown) as Record<string, unknown>).id = c.canonicalId;
      ((c as unknown) as Record<string, unknown>).source_text = c.sourceText;
      ((c as unknown) as Record<string, unknown>).description = c.descriptionZh;
    }

    merged["constraints"] = canonical;
    // Clean up consumed candidates
    delete merged["missingConstraintCandidates"];
  }

  // --- Handle exceptions / missingExceptionCandidates ---
  if (Array.isArray(merged["exceptions"])) {
    merged["exceptions"] = dedupeExceptions(asArray(merged["exceptions"]));
  }

  // Dedup against existing exceptions and append survivors.
  const rawExcCandidates = asArray(merged["missingExceptionCandidates"]);
  if (rawExcCandidates.length > 0) {
    const existingExceptions = asArray(merged["exceptions"]);
    for (const candidate of rawExcCandidates) {
      const desc = String(candidate.description ?? "").trim();
      if (desc) {
        existingExceptions.push(candidate);
      }
    }
    delete merged["missingExceptionCandidates"];
  }

  const exceptions = dedupeExceptions(asArray(merged["exceptions"]));
  if (exceptions.length > 0) {
    merged["exceptions"] = exceptions;
    canonicalizeAppendedExceptions(exceptions);
  }
}

function canonicalizeAppendedExceptions(exceptions: Record<string, unknown>[]): void {
  const usedCanonicalIds = new Set<string>();
  let maxDisplay = 0;

  for (const exception of exceptions) {
    const canonicalId = String(exception.id ?? "").trim();
    if (canonicalId && canonicalId.startsWith("EXC_")) {
      usedCanonicalIds.add(canonicalId);
    }
    const displayId = String(exception.displayId ?? "").trim();
    const match = displayId.match(/^X(\d{3,})$/);
    if (match) {
      maxDisplay = Math.max(maxDisplay, Number.parseInt(match[1], 10));
    }
  }

  for (const exception of exceptions) {
    const displayId = String(exception.displayId ?? "").trim();
    const canonicalId = String(exception.id ?? "").trim();
    if (/^X\d{3,}$/.test(displayId) && canonicalId.startsWith("EXC_")) {
      continue;
    }

    const text = String(
      exception.description ??
      exception.trigger ??
      exception.text ??
      canonicalId,
    ).trim();
    if (!text) continue;

    let nextCanonicalId = exceptionCanonicalId(text);
    if (usedCanonicalIds.has(nextCanonicalId)) {
      let suffix = 2;
      while (usedCanonicalIds.has(`${nextCanonicalId}_${suffix}`)) suffix++;
      nextCanonicalId = `${nextCanonicalId}_${suffix}`;
    }
    usedCanonicalIds.add(nextCanonicalId);
    maxDisplay += 1;

    if (canonicalId && !canonicalId.startsWith("EXC_")) {
      exception.originalId = canonicalId;
    }
    exception.id = nextCanonicalId;
    exception.displayId = `X${String(maxDisplay).padStart(3, "0")}`;
  }
}

function dedupeExceptions(exceptions: Record<string, unknown>[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const exactSeen = new Map<string, number>();
  const semanticSeen = new Map<string, number>();

  for (const exception of exceptions) {
    const text = String(exception.description ?? exception.text ?? exception.trigger ?? "").trim();
    if (!text) {
      result.push(exception);
      continue;
    }

    const exactKey = normalizeExceptionText(text);
    const semanticKey = exceptionSemanticKey(text);
    const existingIndex = exactSeen.get(exactKey) ??
      (semanticKey ? semanticSeen.get(semanticKey) : undefined);

    if (existingIndex !== undefined) {
      result[existingIndex] = mergeExceptionRecords(result[existingIndex], exception);
      continue;
    }

    const index = result.length;
    result.push(exception);
    exactSeen.set(exactKey, index);
    if (semanticKey) semanticSeen.set(semanticKey, index);
  }

  return result;
}

function mergeExceptionRecords(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null || value === "") continue;
    const current = merged[key];
    if (current === undefined || current === null || current === "") {
      merged[key] = value;
      continue;
    }
    if (Array.isArray(current) || Array.isArray(value)) {
      const set = new Set<string>();
      for (const item of Array.isArray(current) ? current : [current]) {
        const text = String(item).trim();
        if (text) set.add(text);
      }
      for (const item of Array.isArray(value) ? value : [value]) {
        const text = String(item).trim();
        if (text) set.add(text);
      }
      merged[key] = [...set];
      continue;
    }
    if (
      (key === "description" || key === "handling" || key === "trigger") &&
      String(value).length > String(current).length
    ) {
      merged[key] = value;
    }
  }
  return merged;
}

function normalizeExceptionText(text: string): string {
  return text
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERIC_EXCEPTION_SEMANTIC_KEYS = new Set([
  "not found",
  "found",
  "failure",
  "error",
  "invalid",
]);

function exceptionSemanticKey(text: string): string {
  if (!/^[A-Za-z]/.test(text.trim())) return "";
  const words = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !EXCEPTION_ID_STOP_WORDS.has(word));
  const key = [...new Set(words)].join(" ");
  if (!key || GENERIC_EXCEPTION_SEMANTIC_KEYS.has(key)) return "";
  return key;
}

function exceptionCanonicalId(text: string): string {
  if (/^[A-Za-z]/.test(text)) {
    const words = text
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !EXCEPTION_ID_STOP_WORDS.has(word))
      .slice(0, 4)
      .map((word) => word.toUpperCase());
    if (words.length > 0) return `EXC_${words.join("_")}`;
  }
  return `EXC_${simpleTextHash(text)}`;
}

const EXCEPTION_ID_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "when", "user",
  "users", "system", "case", "cases", "attempt", "attempts", "fails",
  "failure", "error", "invalid",
]);

function simpleTextHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36).toUpperCase().slice(0, 8).padEnd(8, "0");
}

function normalizeEntityIdentities(
  merged: Record<string, unknown>,
  registry?: EntityRegistry,
): void {
  const entities = asArray(merged["entities"]);
  if (entities.length === 0) return;

  const usedIds = new Set<string>();
  const nameToId = new Map<string, string>();

  for (const entity of entities) {
    const name = String(entity.name ?? entity.canonicalName ?? "").trim();
    const rawRef = String(entity.entityRef ?? entity.id ?? "").trim();
    let canonicalId = rawRef ? resolveEntityRef(rawRef, registry) : "";
    if (!canonicalId || !canonicalId.startsWith("E_")) {
      canonicalId = name ? entityCanonicalId(name) : entityCanonicalId(rawRef || "Entity");
    }
    if (usedIds.has(canonicalId)) {
      let suffix = 2;
      while (usedIds.has(`${canonicalId}_${suffix}`)) suffix++;
      canonicalId = `${canonicalId}_${suffix}`;
    }
    usedIds.add(canonicalId);

    const oldId = String(entity.id ?? "").trim();
    if (oldId && oldId !== canonicalId && !oldId.startsWith("E_")) {
      entity.originalId = oldId;
    }
    entity.id = canonicalId;
    entity.entityRef = canonicalId;
    if (!String(entity.canonicalName ?? "").trim()) entity.canonicalName = name || canonicalId;
    if (!String(entity.displayName ?? "").trim() && name) entity.displayName = name;

    for (const alias of [
      name,
      String(entity.canonicalName ?? "").trim(),
      String(entity.displayName ?? "").trim(),
      canonicalId,
    ]) {
      if (alias) nameToId.set(alias.toLowerCase(), canonicalId);
    }
  }

  for (const entity of entities) {
    const relationships = Array.isArray(entity.relationships)
      ? entity.relationships as Record<string, unknown>[]
      : [];
    const normalizedRelationships: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const relationship of relationships) {
      const target = String(relationship.target ?? "").trim();
      let normalizedTarget = target ? resolveEntityRef(target, registry) : "";
      if (normalizedTarget && !normalizedTarget.startsWith("E_")) {
        normalizedTarget = nameToId.get(normalizedTarget.toLowerCase()) ?? normalizedTarget;
      }
      if (!normalizedTarget) continue;
      const normalizedType = normalizeRelationType(String(relationship.type ?? ""));
      const key = `${normalizedTarget}|${normalizedType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalizedRelationships.push({
        ...relationship,
        target: normalizedTarget,
        type: normalizedType,
      });
    }
    entity.relationships = normalizedRelationships;
  }
}

function entityCanonicalId(name: string): string {
  const snake = name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `E_${snake || simpleTextHash(name)}`;
}

/** Coerce unknown to Record array. */
function asArray(val: unknown): Record<string, unknown>[] {
  if (!Array.isArray(val)) return [];
  return val as Record<string, unknown>[];
}

export class AnalyzeMerger extends BaseGenerator<Record<string, unknown>> {
  private relationshipPromptTemplate: string;
  private postProcessPromptTemplate: string;

  constructor(llm: LLMClient) {
    super(llm);
    this.relationshipPromptTemplate = loadPrompt(
      "merge_relationships.md",
      "",
    );
    this.postProcessPromptTemplate = loadPrompt(
      "merge_post_process.md",
      "",
    );
  }

  async generate(input: unknown): Promise<Record<string, unknown>> {
    const { artifacts, requirementText, systemPrompt } = input as {
      artifacts: Array<{ taskId: string; content: Record<string, unknown> }>;
      requirementText: string;
      systemPrompt?: string;
    };
    return this.merge(artifacts, requirementText, systemPrompt);
  }

  async merge(
    artifacts: Array<{ taskId: string; content: Record<string, unknown> }>,
    requirementText: string,
    systemPrompt?: string,
    registry?: EntityRegistry,
  ): Promise<Record<string, unknown>> {
    if (artifacts.length === 0) {
      throw createToolError("MERGE_NO_RESULTS", "没有可合并的分析结果", { recoverable: false });
    }

    // 只有一个分析结果：无需合并，但仍需 canonicalize
    if (artifacts.length === 1) {
      const single = artifacts[0].content as Record<string, unknown>;
      // 清理实体 ID：用 entityRef 覆盖旧 id
      for (const e of (single.entities as Array<Record<string, unknown>> | undefined) ?? []) {
        if (e.entityRef) e.id = e.entityRef;
      }
      AnalyzeMerger._absorbProposedEntities(single);
      // Canonicalize IDs & resolve cross-references first, then constraints
      canonicalizeAndLink(single);
      canonicalizeConstraintsPipeline(single);
      normalizeEntityIdentities(single, registry);
      return single;
    }

    // 程序化预合并：将所有分析结果按名称去重取并集
    const preMerged = this.preMerge(artifacts, registry);
    AnalyzeMerger._absorbProposedEntities(preMerged);
    const safeText = this.sanitizePlaceholder(requirementText || "", "requirement_text");

    // 直接用 preMerge 结果（保全集），跳过 LLM merge
    // LLM merge 会"优化"掉内容，preMerge 是程序化并集不会丢
    const merged = preMerged;

    // 统一补全：关系补全 + 约束补全 + 功能去重
    await this._postProcess(merged, safeText, systemPrompt, registry);

    RequirementNormalizer.normalize(merged);
    RequirementNormalizer.normalizeAgainstSource(merged, requirementText);
    AnalyzeMerger._verifySourceRefs(merged, requirementText);

    // 清理实体 ID：用 entityRef 覆盖旧 id
    for (const e of (merged.entities as Array<Record<string, unknown>> | undefined) ?? []) {
      if (e.entityRef) e.id = e.entityRef;
    }

    // Canonicalize IDs & resolve cross-references first, then constraints
    canonicalizeAndLink(merged);
    canonicalizeConstraintsPipeline(merged);
    normalizeEntityIdentities(merged, registry);

    // Quality gate: attach result without blocking. When source_text is
    // missing on constraints/exceptions, attempt a bounded LLM repair first;
    // on any error or persistent failure, fall back to the pre-repair result.
    let qualityResult = checkAnalysisQuality(merged, requirementText);
    const needsRepair = AnalyzeMerger.hasMissingSourceText(merged, requirementText)
      && !AnalyzeMerger.noUnverifiedPassed(qualityResult);
    if (needsRepair) {
      const repaired = await this.repairMissingSourceText(merged, requirementText, systemPrompt);
      if (repaired) {
        try {
          canonicalizeConstraintsPipeline(repaired);
          const reChecked = checkAnalysisQuality(repaired, requirementText);
          // Only adopt the repair if it improved the source_text situation.
          if (!AnalyzeMerger.hasMissingSourceText(repaired, requirementText)) {
            Object.assign(merged, repaired);
            qualityResult = reChecked;
          }
        } catch {
          // Repair post-processing failed → keep the original merged result.
        }
      }
    }
    (merged as Record<string, unknown>).__qualityGate = qualityResult;

    return merged;
  }

  /**
   * 统一补全：一次 LLM 调用完成关系补全 + 约束补全 + 功能去重。
   * 失败时静默返回，不影响主流程。
   */
  private async _postProcess(
    merged: Record<string, unknown>,
    requirementText: string,
    systemPrompt?: string,
    registry?: EntityRegistry,
  ): Promise<void> {
    if (!this.postProcessPromptTemplate) {
      return;
    }

    // 构造精简摘要
    const entities = merged.entities as Array<Record<string, unknown>> | undefined;
    const functions = merged.functions as Array<Record<string, unknown>> | undefined;
    const constraints = merged.constraints as Array<Record<string, unknown>> | undefined;
    const exceptions = merged.exceptions as Array<Record<string, unknown>> | undefined;

    const sections: string[] = [];

    // 实体摘要
    const entityLines = (entities ?? []).map((e) => {
      const name = String(e.name ?? "").trim();
      const desc = String(e.description ?? "").trim();
      const existingRels = (e.relationships as Array<Record<string, unknown>> ?? [])
        .map((r) => `${r.target}(${r.type})`)
        .join(", ");
      let line = `  - ${name}`;
      if (desc) line += `: ${desc}`;
      if (existingRels) line += ` [已有关系: ${existingRels}]`;
      return line;
    });
    if (entityLines.length > 0) {
      sections.push(`### 实体\n${entityLines.join("\n")}`);
    }

    // 功能摘要
    const funcLines = (functions ?? []).map(
      (f) => `  - [${f.id || "?"}] ${f.name}: ${String(f.description ?? "").slice(0, 80)}`,
    );
    if (funcLines.length > 0) {
      sections.push(`### 功能\n${funcLines.join("\n")}`);
    }

    // 已有约束
    const constLines = (constraints ?? []).map(
      (c) => `  - [${c.id ?? "?"}] ${c.description ?? ""}`,
    );
    if (constLines.length > 0) {
      sections.push(`### 已有约束\n${constLines.join("\n")}`);
    }

    // 已有异常
    const excLines = (exceptions ?? []).map(
      (e) => `  - [${e.id ?? "?"}] ${e.description ?? ""}`,
    );
    if (excLines.length > 0) {
      sections.push(`### 已有异常\n${excLines.join("\n")}`);
    }

    const mergedSummary = sections.length > 0 ? sections.join("\n\n") : "（无已合并结果）";

    const prompt = this.buildPrompt(this.postProcessPromptTemplate, {
      merged_summary: mergedSummary,
      requirement_text: requirementText,
    });

    try {
      const result = await this.llm.generateJson(prompt, systemPrompt ?? "");
      const obj = typeof result === "object" && result !== null && !Array.isArray(result)
        ? result as Record<string, unknown>
        : null;
      if (!obj) return;

      // 1. 应用关系补丁
      const relPatches = Array.isArray(obj.relationships) ? obj.relationships : [];
      const typedRelPatches: Array<{ entity: string; target: string; type: string; description: string }> = [];
      for (const p of relPatches) {
        if (
          typeof p === "object" && p !== null &&
          "entity" in p && "target" in p && "type" in p &&
          typeof (p as Record<string, unknown>).entity === "string" &&
          typeof (p as Record<string, unknown>).target === "string" &&
          typeof (p as Record<string, unknown>).type === "string"
        ) {
          typedRelPatches.push({
            entity: (p as Record<string, unknown>).entity as string,
            target: (p as Record<string, unknown>).target as string,
            type: (p as Record<string, unknown>).type as string,
            description: String((p as Record<string, unknown>).description ?? ""),
          });
        }
      }
      AnalyzeMerger._applyRelationshipPatches(merged, typedRelPatches, registry);

      // 2. 应用关系实体补丁
      const entityPatches = Array.isArray(obj.relationship_entities)
        ? obj.relationship_entities
        : [];
      AnalyzeMerger._applyEntityPatches(
        merged,
        entityPatches.filter(
          (entity) => typeof entity === "object" && entity !== null && "name" in entity,
        ) as Array<Record<string, unknown>>,
      );

      // 3. 应用约束补丁
      const constPatches = Array.isArray(obj.constraints) ? obj.constraints : [];
      const excPatches = Array.isArray(obj.exceptions) ? obj.exceptions : [];
      AnalyzeMerger._applyConstraintPatches(merged, {
        constraints: constPatches.filter(
          (c) => typeof c === "object" && c !== null && "description" in c,
        ) as Array<Record<string, unknown>>,
        exceptions: excPatches.filter(
          (e) => typeof e === "object" && e !== null && "description" in e,
        ) as Array<Record<string, unknown>>,
      });

      // 4. 应用功能去重 — 已禁用。
      // LLM dedup 不可靠，曾误删 BasicSearch（被错误合并到 AdvancedSearch）。
      // preMerge 已按名称合并功能，无需 LLM 再判断语义重复。
      // 保留此注释块以便将来需要时恢复。
    } catch {
      // 静默失败，不影响主流程
    }
  }

  /**
   * Lossless pre-merge: union all arrays with smart Jaccard-based merging.
   *
   * Key invariants:
   *  - Total items (entities + functions + constraints + exceptions) never decrease
   *  - Constraints/exceptions: dedup by description similarity, NOT by ID
   *  - Entities: merge same-name (attributes union, longer description)
   *  - Functions: merge same-name (sub_capabilities union, longer description)
   */
  preMerge(
    artifacts: Array<{ taskId: string; content: Record<string, unknown> }>,
    registry?: EntityRegistry,
  ): Record<string, unknown> {
    // Collect all items from all artifacts, grouped by type
    const allActors: Record<string, unknown>[] = [];
    const allFunctions: Record<string, unknown>[] = [];
    const allEntities: Record<string, unknown>[] = [];
    const allConstraints: Record<string, unknown>[] = [];
    const allExceptions: Record<string, unknown>[] = [];
    const allNFR: Record<string, unknown>[] = [];
    const allBP: Record<string, unknown>[] = [];
    const allProposedEntities: Record<string, unknown>[] = [];
    const allProposedFunctions: Record<string, unknown>[] = [];
    const allMissingConstraintCandidates: Record<string, unknown>[] = [];
    const allMissingExceptionCandidates: Record<string, unknown>[] = [];
    let projectName = "";
    let projectOverview = "";

    for (const artifact of artifacts) {
      const c = artifact.content;

      if (!projectName && typeof c.project_name === "string" && c.project_name) {
        projectName = c.project_name;
      }
      if (!projectOverview && typeof c.project_overview === "string" && c.project_overview) {
        projectOverview = c.project_overview;
      }

      for (const item of (c.actors as Array<Record<string, unknown>>) ?? []) allActors.push(item);
      for (const item of (c.functions as Array<Record<string, unknown>>) ?? []) allFunctions.push(item);
      for (const item of (c.entities as Array<Record<string, unknown>>) ?? []) allEntities.push(item);
      for (const item of (c.constraints as Array<Record<string, unknown>>) ?? []) allConstraints.push(item);
      for (const item of (c.exceptions as Array<Record<string, unknown>>) ?? []) allExceptions.push(item);
      for (const item of (c.non_functional_requirements as Array<Record<string, unknown>>) ?? []) allNFR.push(item);
      for (const item of (c.business_processes as Array<Record<string, unknown>>) ?? []) allBP.push(item);
      for (const item of (c.proposeNewEntities as Array<Record<string, unknown>>) ?? []) allProposedEntities.push(item);
      for (const item of (c.proposeNewFunctions as Array<Record<string, unknown>>) ?? []) allProposedFunctions.push(item);
      for (const item of (c.missingConstraintCandidates as Array<Record<string, unknown>>) ?? []) allMissingConstraintCandidates.push(item);
      for (const item of (c.missingExceptionCandidates as Array<Record<string, unknown>>) ?? []) allMissingExceptionCandidates.push(item);
    }

    // --- Phase 2: Smart merge each type ---

    const mergedActors = AnalyzeMerger._mergeActors(allActors);
    const mergedEntities = AnalyzeMerger._mergeEntities(allEntities, registry);
    const mergedFunctions = AnalyzeMerger._mergeFunctions(allFunctions);
    const mergedConstraints = AnalyzeMerger._mergeByRefField(allConstraints, "constraintRef");
    const mergedExceptions = AnalyzeMerger._mergeByRefField(allExceptions, "exceptionRef");
    const mergedNFR = AnalyzeMerger._mergeByCategory(allNFR);
    const mergedBP = AnalyzeMerger._mergeByName(allBP);

    // Collect proposed new entities/functions, dedup by name
    const proposedEntities = AnalyzeMerger._dedupByName(allProposedEntities);
    const proposedFunctions = AnalyzeMerger._dedupByName(allProposedFunctions);

    // Collect missing constraint candidates, dedup by description
    const missingConstraintCandidates = AnalyzeMerger._dedupByDescription(allMissingConstraintCandidates);
    // Collect missing exception candidates, dedup by description
    const missingExceptionCandidates = AnalyzeMerger._dedupByDescription(allMissingExceptionCandidates);

    return {
      project_name: projectName,
      project_overview: projectOverview,
      actors: mergedActors,
      functions: mergedFunctions,
      entities: mergedEntities,
      constraints: mergedConstraints,
      exceptions: mergedExceptions,
      non_functional_requirements: mergedNFR,
      business_processes: mergedBP,
      proposeNewEntities: proposedEntities,
      proposeNewFunctions: proposedFunctions,
      missingConstraintCandidates,
      missingExceptionCandidates,
    };
  }

  // --- Actors: merge by actorRef first, then by normalized name ---
  private static _mergeActors(items: Record<string, unknown>[]): Record<string, unknown>[] {
    // Phase 1: group by actorRef if present
    const refGroups = new Map<string, Record<string, unknown>[]>();
    const noRefItems: Record<string, unknown>[] = [];

    for (const item of items) {
      const ref = String(item.actorRef ?? "").trim();
      if (ref) {
        let group = refGroups.get(ref);
        if (!group) { group = []; refGroups.set(ref, group); }
        group.push(item);
      } else {
        noRefItems.push(item);
      }
    }

    const result: Record<string, unknown>[] = [];

    // Merge actorRef groups — keep actor with longest description
    for (const [_ref, group] of refGroups) {
      if (group.length === 1) {
        result.push(group[0]);
        continue;
      }
      group.sort((a, b) => String(b.description ?? "").length - String(a.description ?? "").length);
      result.push(group[0]);
    }

    // Phase 2: group remaining items by normalized name (case-insensitive, no Jaccard)
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const item of noRefItems) {
      const name = String(item.name ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      let group = groups.get(key);
      if (!group) { group = []; groups.set(key, group); }
      group.push(item);
    }

    // Within each name group, keep actor with longest description
    for (const [_key, groupItems] of groups) {
      if (groupItems.length === 1) {
        result.push(groupItems[0]);
        continue;
      }
      groupItems.sort((a, b) => {
        const lenA = String(a.description ?? "").length;
        const lenB = String(b.description ?? "").length;
        return lenB - lenA;
      });
      result.push(groupItems[0]);
    }
    return result;
  }

  private static _absorbProposedEntities(merged: Record<string, unknown>): void {
    const proposed = asArray(merged["proposeNewEntities"]);
    if (proposed.length === 0) return;

    const entities = asArray(merged["entities"]);
    const existingNames = new Set(
      entities.map((e) => String(e.name ?? e.canonicalName ?? "").trim().toLowerCase()),
    );

    for (const item of proposed) {
      const name = String(item.name ?? "").trim();
      if (!name || existingNames.has(name.toLowerCase())) continue;
      entities.push(item);
      existingNames.add(name.toLowerCase());
    }

    merged["entities"] = entities;
    delete merged["proposeNewEntities"];
  }

  // --- Entities: merge by entityRef first, then by normalized name ---
  private static _mergeEntities(items: Record<string, unknown>[], registry?: EntityRegistry): Record<string, unknown>[] {
    // Phase 1: group by entityRef if present
    const refGroups = new Map<string, Record<string, unknown>[]>();
    const noRefItems: Record<string, unknown>[] = [];

    for (const item of items) {
      const ref = String(item.entityRef ?? "").trim();
      if (ref) {
        let group = refGroups.get(ref);
        if (!group) { group = []; refGroups.set(ref, group); }
        group.push(item);
      } else {
        noRefItems.push(item);
      }
    }

    const result: Record<string, unknown>[] = [];

    // Merge entityRef groups
    for (const [_ref, group] of refGroups) {
      if (group.length === 1) {
        result.push(group[0]);
        continue;
      }
      const merged = { ...group[0] };
      for (let i = 1; i < group.length; i++) {
        AnalyzeMerger._mergeEntityInPlace(merged, group[i], registry);
      }
      const attrs = merged.attributes as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(attrs) && attrs.length > 20) {
        merged.attributes = attrs.slice(0, 20);
      }
      result.push(merged);
    }

    // Phase 2: merge remaining items by normalized name (legacy compat)
    const nameGroups = new Map<string, Record<string, unknown>[]>();
    for (const item of noRefItems) {
      const name = String(item.name ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      let group = nameGroups.get(key);
      if (!group) { group = []; nameGroups.set(key, group); }
      group.push(item);
    }

    let suffixCounter = 1;
    for (const [_key, group] of nameGroups) {
      if (group.length === 1) {
        result.push(group[0]);
        continue;
      }

      // Check if descriptions are too dissimilar (Jaccard < 0.3 AND no containment)
      const words0 = AnalyzeMerger._getWords(String(group[0].description ?? ""));
      const words1 = AnalyzeMerger._getWords(String(group[1].description ?? ""));
      const sim = AnalyzeMerger._jaccard(words0, words1);
      const shorterContained = AnalyzeMerger._isContained(words0, words1);

      if (sim < 0.3 && !shorterContained && words0.size > 0 && words1.size > 0) {
        // Descriptions are completely unrelated — keep all with suffix
        const baseName = String(group[0].name ?? "").trim();
        for (const member of group) {
          result.push({ ...member, name: `${baseName}_${suffixCounter++}` });
        }
      } else {
        // Merge: longer description, attribute union, relationship union
        const merged = { ...group[0] };
        for (let i = 1; i < group.length; i++) {
          AnalyzeMerger._mergeEntityInPlace(merged, group[i], registry);
        }
        const attrs = merged.attributes as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(attrs) && attrs.length > 20) {
          merged.attributes = attrs.slice(0, 20);
        }
        result.push(merged);
      }
    }

    return result;
  }

  /** Merge entity `source` into `target` in-place. */
  private static _mergeEntityInPlace(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
    registry?: EntityRegistry,
  ): void {
    // Description: keep longer
    const tDesc = String(target.description ?? "");
    const sDesc = String(source.description ?? "");
    if (sDesc.length > tDesc.length) target.description = sDesc;

    // Attributes: union by name, keep longer description version
    const tAttrs = (Array.isArray(target.attributes) ? target.attributes : []) as Record<string, unknown>[];
    const sAttrs = (Array.isArray(source.attributes) ? source.attributes : []) as Record<string, unknown>[];
    const attrMap = new Map<string, Record<string, unknown>>();
    for (const a of tAttrs) {
      const n = String(a.name ?? "").trim();
      if (n) attrMap.set(n.toLowerCase(), a);
    }
    for (const a of sAttrs) {
      const n = String(a.name ?? "").trim();
      if (!n) continue;
      const key = n.toLowerCase();
      const existing = attrMap.get(key);
      if (!existing) {
        attrMap.set(key, a);
      } else {
        // Keep version with longer description
        if (String(a.description ?? "").length > String(existing.description ?? "").length) {
          attrMap.set(key, a);
        }
      }
    }
    target.attributes = [...attrMap.values()];

    // Relationships: union by normalized target+type
    const tRels = (Array.isArray(target.relationships) ? target.relationships : []) as Record<string, unknown>[];
    const sRels = (Array.isArray(source.relationships) ? source.relationships : []) as Record<string, unknown>[];
    const relKeys = new Set<string>();
    const mergedRels: Record<string, unknown>[] = [];
    for (const r of [...tRels, ...sRels]) {
      const normalizedTarget = resolveEntityRef(String(r.target ?? ""), registry);
      const normalizedType = normalizeRelationType(String(r.type ?? ""));
      const relKey = `${normalizedTarget}|${normalizedType}`;
      if (!relKeys.has(relKey)) {
        relKeys.add(relKey);
        mergedRels.push(r);
      }
    }
    target.relationships = mergedRels;
  }

  // --- Functions: merge by normalized name ---
  private static _mergeFunctions(items: Record<string, unknown>[]): Record<string, unknown>[] {
    const groups = new Map<string, Record<string, unknown>[]>();

    for (const item of items) {
      const name = String(item.name ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      let group = groups.get(key);
      if (!group) { group = []; groups.set(key, group); }
      group.push(item);
    }

    const result: Record<string, unknown>[] = [];

    for (const group of groups.values()) {
      if (group.length === 1) {
        result.push(group[0]);
        continue;
      }

      // Same name: merge — longer description, union sub_capabilities & acceptance_criteria
      const merged = { ...group[0] };
      for (let i = 1; i < group.length; i++) {
        const src = group[i];
        // Description: keep longer
        if (String(src.description ?? "").length > String(merged.description ?? "").length) {
          merged.description = src.description;
        }
        // Union sub_capabilities
        merged.sub_capabilities = AnalyzeMerger._unionStringArrays(
          merged.sub_capabilities, src.sub_capabilities,
        );
        // Union acceptance_criteria
        merged.acceptance_criteria = AnalyzeMerger._unionStringArrays(
          merged.acceptance_criteria, src.acceptance_criteria,
        );
      }
      result.push(merged);
    }

    return result;
  }

  // --- Constraints/Exceptions: merge by ref field, fallback to source_text dedup ---
  private static _mergeByRefField(
    items: Record<string, unknown>[],
    refField: string,
  ): Record<string, unknown>[] {
    if (items.length <= 1) return [...items];

    // Group by the ref field
    const refGroups = new Map<string, Record<string, unknown>[]>();
    const noRefItems: Record<string, unknown>[] = [];

    for (const item of items) {
      const ref = String(item[refField] ?? "").trim();
      if (ref) {
        let group = refGroups.get(ref);
        if (!group) { group = []; refGroups.set(ref, group); }
        group.push(item);
      } else {
        noRefItems.push(item);
      }
    }

    const result: Record<string, unknown>[] = [];

    // Keep longest description per ref group
    for (const [_ref, group] of refGroups) {
      if (group.length === 1) {
        result.push(group[0]);
      } else {
        group.sort((a, b) => String(b.description ?? "").length - String(a.description ?? "").length);
        result.push(group[0]);
      }
    }

    result.push(...AnalyzeMerger._mergeBySourceText(noRefItems));

    return result;
  }

  private static _mergeBySourceText(items: Record<string, unknown>[]): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    const sourceGroups = new Map<string, Record<string, unknown>[]>();

    for (const item of items) {
      const source = AnalyzeMerger._normalizeForMatch(String(item.source_text ?? ""));
      if (!source) {
        result.push(item);
        continue;
      }
      let group = sourceGroups.get(source);
      if (!group) {
        group = [];
        sourceGroups.set(source, group);
      }
      group.push(item);
    }

    for (const group of sourceGroups.values()) {
      if (group.length === 1) {
        result.push(group[0]);
        continue;
      }
      group.sort((a, b) =>
        String(b.description ?? "").length - String(a.description ?? "").length,
      );
      result.push(group[0]);
    }

    return result;
  }

  /** Chinese → English NFR category mapping for cross-language dedup. */
  private static readonly _NFR_CATEGORY_ZH_EN: Record<string, string> = {
    "性能": "performance",
    "安全": "security",
    "可用性": "availability",
    "可扩展性": "scalability",
    "可维护性": "maintainability",
    "可靠性": "reliability",
    "易用性": "usability",
    "兼容性": "compatibility",
  };

  // --- NFR: dedup by category ---
  private static _mergeByCategory(items: Record<string, unknown>[]): Record<string, unknown>[] {
    return AnalyzeMerger._dedupByKey(items, (item) => {
      const cat = String(item.category ?? "").trim();
      if (!cat) return "";
      return (AnalyzeMerger._NFR_CATEGORY_ZH_EN[cat] ?? cat).toLowerCase();
    });
  }

  // --- Business processes: dedup by name ---
  private static _mergeByName(items: Record<string, unknown>[]): Record<string, unknown>[] {
    return AnalyzeMerger._dedupByKey(items, (item) =>
      String(item.name ?? "").trim().toLowerCase(),
    );
  }

  // --- Dedup by canonicalName for proposed entities/functions ---
  private static _dedupByName(items: Record<string, unknown>[]): Record<string, unknown>[] {
    return AnalyzeMerger._dedupByKey(items, (item) =>
      String(item.name ?? item.canonicalName ?? "").trim().toLowerCase(),
    );
  }

  // --- Dedup by description for missing constraint candidates ---
  private static _dedupByDescription(items: Record<string, unknown>[]): Record<string, unknown>[] {
    return AnalyzeMerger._dedupByKey(items, (item) =>
      String(item.description ?? "").trim().toLowerCase(),
    );
  }

  /** 首次出现优先：按 keyFn 归一化键去重，键为空则跳过该条目。 */
  private static _dedupByKey(
    items: Record<string, unknown>[],
    keyFn: (item: Record<string, unknown>) => string,
  ): Record<string, unknown>[] {
    const seen = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      const key = keyFn(item);
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, item);
    }
    return [...seen.values()];
  }

  // --- Shared Jaccard helpers ---

  private static readonly _STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall", "should",
    "may", "might", "must", "can", "could", "to", "of", "in", "for", "on", "with",
    "at", "by", "from", "as", "into", "through", "during", "before", "after",
    "above", "below", "between", "under", "again", "further", "once",
    "this", "that", "these", "those", "it", "its",
  ]);

  private static _getWords(s: string): Set<string> {
    const words = s
      .replace(/([a-z])([A-Z])/g, "$1 $2")  // camelCase split
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .map((w) => w.replace(/s$/, "")) // basic singular normalization
      .filter((w) => w.length > 1 && !AnalyzeMerger._STOP_WORDS.has(w));
    return new Set(words);
  }

  private static _jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const x of a) { if (b.has(x)) inter++; }
    const union = new Set([...a, ...b]).size;
    return union > 0 ? inter / union : 0;
  }

  /** Check if the shorter word set is fully contained in the longer one. */
  private static _isContained(a: Set<string>, b: Set<string>): boolean {
    const [shorter, longer] = a.size <= b.size ? [a, b] : [b, a];
    if (shorter.size === 0) return false;
    for (const w of shorter) {
      if (!longer.has(w)) return false;
    }
    return true;
  }

  private static _unionStringArrays(a: unknown, b: unknown): string[] {
    const set = new Set<string>();
    for (const arr of [a, b]) {
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const s = String(item).trim();
          if (s) set.add(s);
        }
      }
    }
    return [...set];
  }

  /**
   * 关系补全：传入合并后的实体列表和原始需求，LLM 仅输出关系补丁数组。
   * 失败时返回空数组，不影响主流程。
   * @deprecated 已合并至 _completeAll，保留供未来单独使用。
   */
  // @ts-expect-error TS6133 - preserved for future standalone use
  private async _completeRelationships(
    merged: Record<string, unknown>,
    requirementText: string,
  ): Promise<Array<{ entity: string; target: string; type: string; description: string }>> {
    if (!this.relationshipPromptTemplate) {
      return [];
    }

    const entities = merged.entities as Array<Record<string, unknown>> | undefined;
    if (!entities || entities.length === 0) {
      return [];
    }

    // 构造精简的实体摘要：只传实体名+描述，不传完整 JSON
    const entitySummaries = entities.map((e) => {
      const name = String(e.name ?? "").trim();
      const desc = String(e.description ?? "").trim();
      const existingRels = (e.relationships as Array<Record<string, unknown>> ?? [])
        .map((r) => `${r.target}(${r.type})`)
        .join(", ");
      let summary = `- ${name}`;
      if (desc) summary += `: ${desc}`;
      if (existingRels) summary += ` [已有关系: ${existingRels}]`;
      return summary;
    }).join("\n");

    const prompt = this.buildPrompt(this.relationshipPromptTemplate, {
      merged_entities: entitySummaries,
      requirement_text: requirementText,
    });

    try {
      const result = await this.llm.generateJson(prompt, "");
      const rawPatches = AnalyzeMerger._extractPatches(result);
      if (!Array.isArray(rawPatches)) {
        return [];
      }
      const patches: Array<{ entity: string; target: string; type: string; description: string }> = [];
      for (const p of rawPatches) {
        if (
          typeof p === "object" &&
          p !== null &&
          "entity" in p &&
          "target" in p &&
          "type" in p &&
          typeof (p as Record<string, unknown>).entity === "string" &&
          typeof (p as Record<string, unknown>).target === "string" &&
          typeof (p as Record<string, unknown>).type === "string"
        ) {
          patches.push({
            entity: (p as Record<string, unknown>).entity as string,
            target: (p as Record<string, unknown>).target as string,
            type: (p as Record<string, unknown>).type as string,
            description: String((p as Record<string, unknown>).description ?? ""),
          });
        }
      }
      return patches;
    } catch {
      return [];
    }
  }

  /**
   * 从 LLM 返回结果中提取补丁数组。
   * LLM 可能直接返回数组，也可能包裹在 {content: [...]} 中。
   */
  private static _extractPatches(
    result: Record<string, unknown>,
  ): Array<unknown> | null {
    if (Array.isArray(result)) {
      return result;
    }
    const content = result["content"];
    if (Array.isArray(content)) {
      return content;
    }
    // LLM 有时把数组放在 patches 字段里
    const patches = result["patches"];
    if (Array.isArray(patches)) {
      return patches;
    }
    return null;
  }

  /**
   * 应用约束补丁到合并结果：遍历补丁，追加约束和异常（不删除已有）。
   * 去重：按 description 相似度（完全相同则跳过）。
   */
  private static _applyConstraintPatches(
    merged: Record<string, unknown>,
    patches: { constraints: Array<Record<string, unknown>>; exceptions: Array<Record<string, unknown>> },
  ): void {
    if (!patches) return;

    // Route constraint patches to missingConstraintCandidates (NOT directly to merged.constraints).
    // This ensures all items go through canonicalizeConstraintsPipeline → SemanticDeduper.
    if (patches.constraints && patches.constraints.length > 0) {
      const existingDescs = new Set(
        asArray(merged["missingConstraintCandidates"]).map((c) => String(c.description ?? "").trim()),
      );
      // Also filter: don't add constraints whose description matches an existing exception
      const exceptionDescs = new Set(
        asArray(merged["exceptions"]).map((e) =>
          String(e.description ?? e.text ?? "").trim().toLowerCase(),
        ),
      );
      const accepted: Array<Record<string, unknown>> = [];
      for (const c of patches.constraints) {
        const desc = String(c.description ?? "").trim();
        if (desc && !existingDescs.has(desc)) {
          // Skip if source_text matches an existing exception description
          const srcText = String(c.source_text ?? "").trim().toLowerCase();
          if (srcText && exceptionDescs.has(srcText)) continue;
          // Skip if description matches an existing exception description (case-insensitive)
          if (exceptionDescs.has(desc.toLowerCase())) continue;
          existingDescs.add(desc);
          accepted.push(c);
        }
      }
      if (accepted.length > 0) {
        const candidates = asArray(merged["missingConstraintCandidates"]);
        candidates.push(...accepted);
        merged["missingConstraintCandidates"] = candidates;
      }
    }

    // Route exception patches to missingExceptionCandidates (NOT directly to merged.exceptions).
    // This ensures all items go through dedup before being merged.
    if (patches.exceptions && patches.exceptions.length > 0) {
      const existingDescs = new Set(
        asArray(merged["missingExceptionCandidates"]).map((e) => String(e.description ?? "").trim()),
      );
      const accepted: Array<Record<string, unknown>> = [];
      for (const e of patches.exceptions) {
        const desc = String(e.description ?? "").trim();
        if (desc && !existingDescs.has(desc)) {
          existingDescs.add(desc);
          accepted.push(e);
        }
      }
      if (accepted.length > 0) {
        const excCandidates = asArray(merged["missingExceptionCandidates"]);
        excCandidates.push(...accepted);
        merged["missingExceptionCandidates"] = excCandidates;
      }
    }
  }

  /**
   * 应用关系实体补丁：补充 CaseRegistration / EnrollmentRecord 等关系实体。
   * 只追加缺失实体，不覆盖已有实体；后续 normalizer/canonicalizer 会统一字段和 ID。
   */
  private static _applyEntityPatches(
    merged: Record<string, unknown>,
    patches: Array<Record<string, unknown>>,
  ): void {
    if (!patches || patches.length === 0) return;

    const entities = asArray(merged["entities"]);
    const existingNames = new Set(
      entities.map((entity) => String(entity.name ?? "").trim().toLowerCase()),
    );
    const accepted: Record<string, unknown>[] = [];

    for (const patch of patches) {
      const name = String(patch.name ?? "").trim();
      if (!name || existingNames.has(name.toLowerCase())) continue;
      if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) continue;

      const attributes = Array.isArray(patch.attributes) ? patch.attributes : [];
      const relationships = Array.isArray(patch.relationships) ? patch.relationships : [];
      accepted.push({
        ...patch,
        entityKind: String(patch.entityKind ?? "process_record"),
        attributes,
        relationships,
      });
      existingNames.add(name.toLowerCase());
    }

    if (accepted.length > 0) {
      merged["entities"] = [...entities, ...accepted];
    }
  }

  /**
   * 应用关系补丁到合并结果：遍历补丁，找到对应实体，追加关系（不删除已有）。
   * 去重：如果已有同名 target 的关系则跳过。
   */
  private static _applyRelationshipPatches(
    merged: Record<string, unknown>,
    patches: Array<{ entity: string; target: string; type: string; description: string }>,
    registry?: EntityRegistry,
  ): void {
    if (!patches || patches.length === 0) return;

    const entities = merged.entities as Array<Record<string, unknown>> | undefined;
    if (!entities || entities.length === 0) return;

    for (const patch of patches) {
      if (!patch.entity || !patch.target || !patch.type) continue;

      const entity = entities.find(
        (e) => String(e.name ?? "").trim() === patch.entity,
      );
      if (!entity) continue;

      let relationships = entity.relationships as Array<Record<string, unknown>> | undefined;
      if (!relationships) {
        relationships = [];
        entity.relationships = relationships;
      }

      // 去重：如果已有同名 target 的关系则跳过（使用 normalized comparison）
      const normalizedPatchTarget = resolveEntityRef(patch.target, registry);
      const exists = relationships.some(
        (r) => resolveEntityRef(String(r.target ?? "").trim(), registry) === normalizedPatchTarget,
      );
      if (exists) continue;

      relationships.push({
        target: patch.target,
        type: patch.type,
        description: patch.description || "",
      });
    }
  }

  /**
   * Verify source_text references in constraints and exceptions against the
   * original requirement text. Marks unmatched entries with `unverified: true`.
   * Returns the count of unverified entries.
   */
  static _verifySourceRefs(
    merged: Record<string, unknown>,
    requirementText: string,
  ): number {
    if (!requirementText) return 0;
    const normalizedSource = AnalyzeMerger._normalizeForMatch(requirementText);
    let unverifiedCount = 0;

    for (const listKey of ["constraints", "exceptions"] as const) {
      const list = merged[listKey];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        const sourceText = String(rec.source_text ?? "").trim();
        if (!sourceText) continue;
        const normalized = AnalyzeMerger._normalizeForMatch(sourceText);
        if (!normalizedSource.includes(normalized)) {
          rec.unverified = true;
          unverifiedCount++;
        }
      }
    }

    return unverifiedCount;
  }

  private static _normalizeForMatch(text: string): string {
    return text
      .toLowerCase()
      .replace(/\.\.\./g, "")
      .replace(/…/g, "")
      // Normalize Unicode quotes/apostrophes to ASCII equivalents
      .replace(/[\u2018\u2019\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201F\u00AB\u00BB]/g, '"')
      .replace(/\s+/g, "")
      .trim();
  }

  /**
   * Whether any constraint/exception in the merged result has an empty
   * source_text. Used to decide whether to attempt an LLM source_text repair.
   */
  /**
   * Whether any constraint/exception has a problematic source_text.
   *
   * A source_text is problematic when it is empty, or — when a requirement
   * text is supplied — when it is non-empty but cannot be verified against
   * the requirement (i.e. the canonicalizer may have back-filled it from the
   * description, in which case it is not a real quote from the source doc).
   */
  static hasMissingSourceText(
    merged: Record<string, unknown>,
    requirementText?: string,
  ): boolean {
    const normalizedSource = requirementText
      ? AnalyzeMerger._normalizeForMatch(requirementText)
      : "";
    for (const listKey of ["constraints", "exceptions"] as const) {
      const list = merged[listKey];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        if (AnalyzeMerger._sourceTextIsProblematic(rec, normalizedSource)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * A single item's source_text is problematic when empty, or when (given a
   * non-empty normalized requirement source) it is not contained in the
   * requirement text. Empty source with no requirement text → problematic.
   */
  private static _sourceTextIsProblematic(
    rec: Record<string, unknown>,
    normalizedSource: string,
  ): boolean {
    const st = String(rec.source_text ?? "").trim();
    if (!st) return true;
    if (!normalizedSource) return false;
    const normalized = AnalyzeMerger._normalizeForMatch(st);
    if (!normalized) return true;
    return !normalizedSource.includes(normalized);
  }

  /** Whether the no_unverified_constraints quality check passed. */
  static noUnverifiedPassed(qualityResult: QualityCheckResult): boolean {
    const check = qualityResult.checks.find((c) => c.name === "no_unverified_constraints");
    return Boolean(check?.passed);
  }

  /**
   * Attempt a bounded LLM repair to fill missing source_text on
   * constraints/exceptions. Returns a deep-cloned, repaired copy of `merged`
   * on success, or null on any error. The caller is responsible for
   * re-canonicalizing and re-checking quality, and for falling back to the
   * original on persistent failure.
   */
  private async repairMissingSourceText(
    merged: Record<string, unknown>,
    requirementText: string,
    systemPrompt?: string,
  ): Promise<Record<string, unknown> | null> {
    // Gather the items that need a source_text, preserving their index so we
    // can write the LLM result back deterministically.
    interface RepairTarget { kind: "constraints" | "exceptions"; index: number; id: string; description: string; }
    const targets: RepairTarget[] = [];
    const normalizedSource = requirementText
      ? AnalyzeMerger._normalizeForMatch(requirementText)
      : "";
    for (const listKey of ["constraints", "exceptions"] as const) {
      const list = merged[listKey];
      if (!Array.isArray(list)) continue;
      list.forEach((item, index) => {
        if (typeof item !== "object" || item === null) return;
        const rec = item as Record<string, unknown>;
        if (AnalyzeMerger._sourceTextIsProblematic(rec, normalizedSource)) {
          targets.push({
            kind: listKey,
            index,
            id: String(rec.displayId ?? rec.id ?? index),
            description: String(rec.description ?? "").trim(),
          });
        }
      });
    }
    if (targets.length === 0) return null;

    const itemsBlock = targets.map((t, i) =>
      `- ${i}: [${t.kind}] id=${t.id} desc=${t.description || "(无描述)"}`,
    ).join("\n");

    // Custom inline prompt: reconstruct source_text from the requirement doc.
    const prompt = [
      "你是需求分析修复助手。下列约束/异常缺失了 source_text（来自原始需求文档的原文）。",
      "请仅根据下方需求原文，为每个条目找回最贴切的原文片段作为 source_text。",
      "严格输出 JSON，格式：{ \"repairs\": [{ \"index\": 0, \"source_text\": \"...\" }, ...] }。",
      "index 必须对应下方列表的序号；source_text 必须是需求原文中的连续片段，不得编造。",
      "若某条目在原文中确实找不到，则将其 source_text 置为空字符串。",
      "",
      "### 需要修复的条目",
      itemsBlock,
      "",
      "### 需求原文",
      requirementText || "(无需求原文)",
    ].join("\n");

    let result: unknown;
    try {
      result = await this.llm.generateJson(prompt, systemPrompt ?? "");
    } catch {
      return null;
    }
    const obj = typeof result === "object" && result !== null && !Array.isArray(result)
      ? result as Record<string, unknown>
      : null;
    if (!obj) return null;
    const repairs = Array.isArray(obj.repairs) ? obj.repairs : null;
    if (!repairs) return null;

    // Deep clone the merged result so the original is untouched on failure.
    const repaired = structuredClone
      ? structuredClone(merged)
      : (JSON.parse(JSON.stringify(merged)) as Record<string, unknown>);

    let applied = 0;
    for (const repair of repairs) {
      if (typeof repair !== "object" || repair === null) continue;
      const r = repair as Record<string, unknown>;
      const idx = Number(r.index);
      const sourceText = String(r.source_text ?? "").trim();
      if (!Number.isInteger(idx) || idx < 0 || idx >= targets.length) continue;
      if (!sourceText) continue;
      const target = targets[idx];
      const list = repaired[target.kind];
      if (!Array.isArray(list)) continue;
      const item = list[target.index];
      if (typeof item !== "object" || item === null) continue;
      (item as Record<string, unknown>).source_text = sourceText;
      applied++;
    }
    // Require at least one useful repair to adopt the result.
    return applied > 0 ? repaired : null;
  }
}
