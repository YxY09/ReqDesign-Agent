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
import { checkAnalysisQuality } from "../shared/analysisQualityGate.js";
import { canonicalizeAndLink } from "../shared/canonicalizer.js";
import {
  canonicalizeConstraints as canonicalizeConstraintsNew,
  type ConstraintCandidate,
} from "../shared/constraintCanonicalizer.js";

/**
 * Convert merged constraints to ConstraintCandidate[], run the new
 * ConstraintCanonicalizer, and replace merged["constraints"] with the results.
 *
 * Also adds compatibility fields (id, source_text) for downstream consumers
 * that expect the old format.
 */
function canonicalizeConstraintsPipeline(merged: Record<string, unknown>): void {
  const rawConstraints = asArray(merged["constraints"]);
  if (!rawConstraints.length) return;

  // Convert to ConstraintCandidate[]
  const candidates: ConstraintCandidate[] = rawConstraints.map((c) => ({
    description: String(c.description ?? "").trim(),
    sourceText: String(c.source_text ?? "").trim(),
    sectionId: c.sectionId as string | undefined,
    relatedFunctionCandidates: Array.isArray(c.related_functions)
      ? (c.related_functions as unknown[]).map((r) => String(r))
      : undefined,
  }));

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
  }

  merged["constraints"] = canonical;
}

/** Coerce unknown to Record array. */
function asArray(val: unknown): Record<string, unknown>[] {
  if (!Array.isArray(val)) return [];
  return val as Record<string, unknown>[];
}

export class AnalyzeMerger extends BaseGenerator<Record<string, unknown>> {
  private relationshipPromptTemplate: string;
  private constraintPromptTemplate: string;
  private postProcessPromptTemplate: string;

  constructor(llm: LLMClient) {
    super(llm);
    this.relationshipPromptTemplate = loadPrompt(
      "merge_relationships.md",
      "",
    );
    this.constraintPromptTemplate = loadPrompt(
      "merge_constraints.md",
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
      // Canonicalize IDs & resolve cross-references first, then constraints
      canonicalizeAndLink(single);
      canonicalizeConstraintsPipeline(single);
      return single;
    }

    // 程序化预合并：将所有分析结果按名称去重取并集
    const preMerged = this.preMerge(artifacts);
    const safeText = this.sanitizePlaceholder(requirementText || "", "requirement_text");

    // 直接用 preMerge 结果（保全集），跳过 LLM merge
    // LLM merge 会"优化"掉内容，preMerge 是程序化并集不会丢
    const merged = preMerged;

    // 统一补全：关系补全 + 约束补全 + 功能去重
    await this._postProcess(merged, safeText, systemPrompt);

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

    // Quality gate: attach result without blocking
    const qualityResult = checkAnalysisQuality(merged, requirementText);
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
      AnalyzeMerger._applyRelationshipPatches(merged, typedRelPatches);

      // 2. 应用约束补丁
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

      // 3. 应用功能去重 — 已禁用。
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
    }

    // --- Phase 2: Smart merge each type ---

    const mergedActors = AnalyzeMerger._mergeActors(allActors);
    const mergedEntities = AnalyzeMerger._mergeEntities(allEntities);
    const mergedFunctions = AnalyzeMerger._mergeFunctions(allFunctions);
    const mergedConstraints = AnalyzeMerger._mergeByConstraintRef(allConstraints);
    const mergedExceptions = AnalyzeMerger._mergeByExceptionRef(allExceptions);
    const mergedNFR = AnalyzeMerger._mergeByCategory(allNFR);
    const mergedBP = AnalyzeMerger._mergeByName(allBP);

    // Collect proposed new entities/functions, dedup by name
    const proposedEntities = AnalyzeMerger._dedupByName(allProposedEntities);
    const proposedFunctions = AnalyzeMerger._dedupByName(allProposedFunctions);

    // Collect missing constraint candidates, dedup by description
    const missingConstraintCandidates = AnalyzeMerger._dedupByDescription(allMissingConstraintCandidates);

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

  // --- Entities: merge by entityRef first, then by normalized name ---
  private static _mergeEntities(items: Record<string, unknown>[]): Record<string, unknown>[] {
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
        AnalyzeMerger._mergeEntityInPlace(merged, group[i]);
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
          AnalyzeMerger._mergeEntityInPlace(merged, group[i]);
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

    // Relationships: union by target+type
    const tRels = (Array.isArray(target.relationships) ? target.relationships : []) as Record<string, unknown>[];
    const sRels = (Array.isArray(source.relationships) ? source.relationships : []) as Record<string, unknown>[];
    const relKeys = new Set<string>();
    const mergedRels: Record<string, unknown>[] = [];
    for (const r of [...tRels, ...sRels]) {
      const relKey = `${String(r.target ?? "")}|${String(r.type ?? "")}`;
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

  // --- Constraints: merge by constraintRef first, fallback to source_text dedup ---
  private static _mergeByConstraintRef(
    items: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    if (items.length <= 1) return [...items];

    // Group by constraintRef
    const refGroups = new Map<string, Record<string, unknown>[]>();
    const noRefItems: Record<string, unknown>[] = [];

    for (const item of items) {
      const ref = String(item.constraintRef ?? "").trim();
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

    // Fallback: group by normalized source_text; items without source_text stay separate
    if (noRefItems.length > 0) {
      const sourceGroups = new Map<string, Record<string, unknown>[]>();
      let uniqueCounter = 0;
      for (const item of noRefItems) {
        const normalized = AnalyzeMerger._normalizeForMatch(String(item.source_text ?? ""));
        const key = normalized || `__item_${uniqueCounter++}`;
        let group = sourceGroups.get(key);
        if (!group) { group = []; sourceGroups.set(key, group); }
        group.push(item);
      }
      for (const [_key, group] of sourceGroups) {
        if (group.length === 1) {
          result.push(group[0]);
        } else {
          group.sort((a, b) => String(b.description ?? "").length - String(a.description ?? "").length);
          result.push(group[0]);
        }
      }
    }

    return result;
  }

  // --- Exceptions: merge by exceptionRef first, fallback to source_text dedup ---
  private static _mergeByExceptionRef(
    items: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    if (items.length <= 1) return [...items];

    // Group by exceptionRef
    const refGroups = new Map<string, Record<string, unknown>[]>();
    const noRefItems: Record<string, unknown>[] = [];

    for (const item of items) {
      const ref = String(item.exceptionRef ?? "").trim();
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

    // Fallback: group by normalized source_text; items without source_text stay separate
    if (noRefItems.length > 0) {
      const sourceGroups = new Map<string, Record<string, unknown>[]>();
      let uniqueCounter = 0;
      for (const item of noRefItems) {
        const normalized = AnalyzeMerger._normalizeForMatch(String(item.source_text ?? ""));
        const key = normalized || `__item_${uniqueCounter++}`;
        let group = sourceGroups.get(key);
        if (!group) { group = []; sourceGroups.set(key, group); }
        group.push(item);
      }
      for (const [_key, group] of sourceGroups) {
        if (group.length === 1) {
          result.push(group[0]);
        } else {
          group.sort((a, b) => String(b.description ?? "").length - String(a.description ?? "").length);
          result.push(group[0]);
        }
      }
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
    const seen = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      const cat = String(item.category ?? "").trim();
      if (!cat) continue;
      const normalized = AnalyzeMerger._NFR_CATEGORY_ZH_EN[cat] ?? cat;
      const key = normalized.toLowerCase();
      if (!seen.has(key)) seen.set(key, item);
    }
    return [...seen.values()];
  }

  // --- Business processes: dedup by name ---
  private static _mergeByName(items: Record<string, unknown>[]): Record<string, unknown>[] {
    const seen = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      const name = String(item.name ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, item);
    }
    return [...seen.values()];
  }

  // --- Dedup by canonicalName for proposed entities/functions ---
  private static _dedupByName(items: Record<string, unknown>[]): Record<string, unknown>[] {
    const seen = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      const name = String(item.name ?? item.canonicalName ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, item);
    }
    return [...seen.values()];
  }

  // --- Dedup by description for missing constraint candidates ---
  private static _dedupByDescription(items: Record<string, unknown>[]): Record<string, unknown>[] {
    const seen = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      const desc = String(item.description ?? "").trim();
      if (!desc) continue;
      const key = desc.toLowerCase();
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
   * 约束补全：传入合并后的结果和原始需求，LLM 扫描缺失的业务规则和异常流程。
   * 失败时返回空对象，不影响主流程。
   * @deprecated 已合并至 _completeAll，保留供未来单独使用。
   */
  // @ts-expect-error TS6133 - preserved for future standalone use
  private async _completeConstraints(
    merged: Record<string, unknown>,
    requirementText: string,
  ): Promise<{ constraints: Array<Record<string, unknown>>; exceptions: Array<Record<string, unknown>> }> {
    if (!this.constraintPromptTemplate) {
      return { constraints: [], exceptions: [] };
    }

    const constraints = merged.constraints as Array<Record<string, unknown>> | undefined;
    const exceptions = merged.exceptions as Array<Record<string, unknown>> | undefined;
    const entities = merged.entities as Array<Record<string, unknown>> | undefined;
    const functions = merged.functions as Array<Record<string, unknown>> | undefined;

    const existingConstraints = (constraints ?? [])
      .map((c) => `- [${c.id ?? "?"}] ${c.description ?? ""}`)
      .join("\n") || "（无）";
    const existingExceptions = (exceptions ?? [])
      .map((e) => `- [${e.id ?? "?"}] ${e.description ?? ""}`)
      .join("\n") || "（无）";
    const entityNames = (entities ?? [])
      .map((e) => `- ${e.name ?? "?"}`)
      .join("\n") || "（无）";
    const functionNames = (functions ?? [])
      .map((f) => `- [${f.id ?? "?"}] ${f.name ?? "?"}`)
      .join("\n") || "（无）";

    const prompt = this.buildPrompt(this.constraintPromptTemplate, {
      existing_constraints: existingConstraints,
      existing_exceptions: existingExceptions,
      entity_names: entityNames,
      function_names: functionNames,
      requirement_text: requirementText,
    });

    try {
      const result = await this.llm.generateJson(prompt, "");
      const obj = typeof result === "object" && result !== null && !Array.isArray(result)
        ? result as Record<string, unknown>
        : null;
      if (!obj) {
        return { constraints: [], exceptions: [] };
      }

      const rawConstraints = Array.isArray(obj.constraints) ? obj.constraints : [];
      const rawExceptions = Array.isArray(obj.exceptions) ? obj.exceptions : [];

      const validConstraints: Array<Record<string, unknown>> = [];
      for (const c of rawConstraints) {
        if (typeof c === "object" && c !== null && "description" in c) {
          validConstraints.push(c as Record<string, unknown>);
        }
      }

      const validExceptions: Array<Record<string, unknown>> = [];
      for (const e of rawExceptions) {
        if (typeof e === "object" && e !== null && "description" in e) {
          validExceptions.push(e as Record<string, unknown>);
        }
      }

      return { constraints: validConstraints, exceptions: validExceptions };
    } catch {
      return { constraints: [], exceptions: [] };
    }
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

    // 追加 constraints
    if (patches.constraints && patches.constraints.length > 0) {
      let mergedConstraints = merged.constraints as Array<Record<string, unknown>> | undefined;
      if (!mergedConstraints) {
        mergedConstraints = [];
        merged.constraints = mergedConstraints;
      }
      const existingDescs = new Set(
        mergedConstraints.map((c) => String(c.description ?? "").trim()),
      );
      for (const c of patches.constraints) {
        const desc = String(c.description ?? "").trim();
        if (desc && !existingDescs.has(desc)) {
          existingDescs.add(desc);
          mergedConstraints.push(c);
        }
      }
    }

    // 追加 exceptions
    if (patches.exceptions && patches.exceptions.length > 0) {
      let mergedExceptions = merged.exceptions as Array<Record<string, unknown>> | undefined;
      if (!mergedExceptions) {
        mergedExceptions = [];
        merged.exceptions = mergedExceptions;
      }
      const existingDescs = new Set(
        mergedExceptions.map((e) => String(e.description ?? "").trim()),
      );
      for (const e of patches.exceptions) {
        const desc = String(e.description ?? "").trim();
        if (desc && !existingDescs.has(desc)) {
          existingDescs.add(desc);
          mergedExceptions.push(e);
        }
      }
    }
  }

  /**
   * 应用关系补丁到合并结果：遍历补丁，找到对应实体，追加关系（不删除已有）。
   * 去重：如果已有同名 target 的关系则跳过。
   */
  private static _applyRelationshipPatches(
    merged: Record<string, unknown>,
    patches: Array<{ entity: string; target: string; type: string; description: string }>,
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

      // 去重：如果已有同名 target 的关系则跳过
      const exists = relationships.some(
        (r) => String(r.target ?? "").trim() === patch.target,
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
}
