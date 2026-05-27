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

export class AnalyzeMerger extends BaseGenerator<Record<string, unknown>> {
  private relationshipPromptTemplate: string;
  private constraintPromptTemplate: string;
  private dedupPromptTemplate: string;
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
    this.dedupPromptTemplate = loadPrompt(
      "merge_dedup_functions.md",
      "",
    );
    this.postProcessPromptTemplate = loadPrompt(
      "merge_post_process.md",
      "",
    );
  }

  async generate(
    artifacts: Array<{ taskId: string; content: Record<string, unknown> }>,
    requirementText: string,
    systemPrompt?: string,
  ): Promise<Record<string, unknown>> {
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

    // 只有一个分析结果：无需合并，直接返回
    if (artifacts.length === 1) {
      return artifacts[0].content;
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

      // 3. 应用功能去重
      const dedupPatches = Array.isArray(obj.dedup_functions) ? obj.dedup_functions : [];
      if (dedupPatches.length > 0 && functions && functions.length > 0) {
        const toRemove = new Set<string>();
        for (const item of dedupPatches) {
          if (typeof item === "object" && item !== null && "merge" in item) {
            const merges = (item as Record<string, unknown>).merge;
            if (Array.isArray(merges)) {
              for (const m of merges) {
                toRemove.add(String(m));
              }
            }
          }
        }
        if (toRemove.size > 0) {
          (merged.functions as Array<Record<string, unknown>>) =
            functions.filter((f) => !toRemove.has(String(f.id ?? f.name ?? "")));
        }
      }
    } catch {
      // 静默失败，不影响主流程
    }
  }

  /**
   * Programmatic pre-merge: union all arrays from analyze results.
   * Deduplicates by exact name match. The LLM merge step then refines
   * (resolves naming conflicts, adds cross-relationships) rather than
   * reconstructing everything from scratch.
   */
  preMerge(
    artifacts: Array<{ taskId: string; content: Record<string, unknown> }>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {
      project_name: "",
      project_overview: "",
      actors: [] as Array<Record<string, unknown>>,
      functions: [] as Array<Record<string, unknown>>,
      entities: [] as Array<Record<string, unknown>>,
      constraints: [] as Array<Record<string, unknown>>,
      exceptions: [] as Array<Record<string, unknown>>,
      non_functional_requirements: [] as Array<Record<string, unknown>>,
      business_processes: [] as Array<Record<string, unknown>>,
    };

    const seenActors = new Set<string>();
    const seenFunctions = new Set<string>();
    const seenEntities = new Set<string>();
    const seenConstraints = new Set<string>();
    const seenExceptions = new Set<string>();
    const seenNFR = new Set<string>();
    const seenBP = new Set<string>();

    for (const artifact of artifacts) {
      const c = artifact.content;

      // project_name / overview: take from first artifact that has it
      if (!result.project_name && typeof c.project_name === "string" && c.project_name) {
        result.project_name = c.project_name;
      }
      if (!result.project_overview && typeof c.project_overview === "string" && c.project_overview) {
        result.project_overview = c.project_overview;
      }

      // actors
      for (const item of (c.actors as Array<Record<string, unknown>>) ?? []) {
        const name = String(item.name ?? "").trim();
        if (name && !seenActors.has(name)) {
          seenActors.add(name);
          (result.actors as Array<Record<string, unknown>>).push(item);
        }
      }

      // functions (dedup by id, fallback to name)
      for (const item of (c.functions as Array<Record<string, unknown>>) ?? []) {
        const id = String(item.id ?? "").trim();
        const name = String(item.name ?? "").trim();
        const key = id || name;
        if (key && !seenFunctions.has(key)) {
          seenFunctions.add(key);
          (result.functions as Array<Record<string, unknown>>).push(item);
        }
      }

      // entities (dedup by name)
      for (const item of (c.entities as Array<Record<string, unknown>>) ?? []) {
        const name = String(item.name ?? "").trim();
        if (name && !seenEntities.has(name)) {
          seenEntities.add(name);
          (result.entities as Array<Record<string, unknown>>).push(item);
        }
      }

      // constraints (dedup by id)
      for (const item of (c.constraints as Array<Record<string, unknown>>) ?? []) {
        const id = String(item.id ?? "").trim();
        if (id && !seenConstraints.has(id)) {
          seenConstraints.add(id);
          (result.constraints as Array<Record<string, unknown>>).push(item);
        }
      }

      // exceptions (dedup by id)
      for (const item of (c.exceptions as Array<Record<string, unknown>>) ?? []) {
        const id = String(item.id ?? "").trim();
        if (id && !seenExceptions.has(id)) {
          seenExceptions.add(id);
          (result.exceptions as Array<Record<string, unknown>>).push(item);
        }
      }

      // non_functional_requirements (dedup by category)
      for (const item of (c.non_functional_requirements as Array<Record<string, unknown>>) ?? []) {
        const cat = String(item.category ?? "").trim();
        if (cat && !seenNFR.has(cat)) {
          seenNFR.add(cat);
          (result.non_functional_requirements as Array<Record<string, unknown>>).push(item);
        }
      }

      // business_processes (dedup by name)
      for (const item of (c.business_processes as Array<Record<string, unknown>>) ?? []) {
        const name = String(item.name ?? "").trim();
        if (name && !seenBP.has(name)) {
          seenBP.add(name);
          (result.business_processes as Array<Record<string, unknown>>).push(item);
        }
      }
    }

    // 防线1：description 关键词重叠去重
    if ((result.functions as Array<Record<string, unknown>>).length > 1) {
      result.functions = AnalyzeMerger._dedupFunctionsByDescription(
        result.functions as Array<Record<string, unknown>>,
      );
    }

    return result;
  }

  /**
   * 防线1辅助：基于 description 关键词 Jaccard 相似度去重。
   * 对每对 name 不同但 description 高度相似的功能进行合并。
   */
  private static _dedupFunctionsByDescription(
    functions: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const stopWords = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "shall", "should",
      "may", "might", "must", "can", "could", "to", "of", "in", "for", "on", "with",
      "at", "by", "from", "as", "into", "through", "during", "before", "after",
      "above", "below", "between", "under", "again", "further", "once",
      "this", "that", "these", "those", "it", "its"]);

    const getWords = (s: string) => {
      const words = s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w));
      return new Set(words);
    };

    const result = [...functions];
    const merged = new Set<number>();

    for (let i = 0; i < result.length; i++) {
      if (merged.has(i)) continue;
      const wi = getWords(String(result[i].description ?? ""));
      for (let j = i + 1; j < result.length; j++) {
        if (merged.has(j)) continue;
        const wj = getWords(String(result[j].description ?? ""));
        const intersection = [...wi].filter(x => wj.has(x)).length;
        const union = new Set([...wi, ...wj]).size;
        const similarity = union > 0 ? intersection / union : 0;
        if (similarity > 0.7) {
          // 保留 description 较长的那条
          if (String(result[j].description ?? "").length > String(result[i].description ?? "").length) {
            result[i] = result[j];
          }
          merged.add(j);
        }
      }
    }

    return result.filter((_, i) => !merged.has(i));
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
   * 防线2：LLM 语义去重 — 找出语义重复的功能并合并。
   * 失败时不影响主流程，返回空数组。
   * @deprecated 已合并至 _completeAll，保留供未来单独使用。
   */
  // @ts-expect-error TS6133 - preserved for future standalone use
  private async _dedupFunctions(
    merged: Record<string, unknown>,
    requirementText: string,
    systemPrompt?: string,
  ): Promise<string[]> {
    if (!this.dedupPromptTemplate) {
      return [];
    }

    try {
      const funcs = (merged.functions as Array<Record<string, unknown>>) ?? [];
      if (funcs.length <= 1) return [];

      // 只传 id + name + description 的精简列表
      const summary = funcs.map(f => `${f.id || "?"}: ${f.name} - ${String(f.description ?? "").slice(0, 80)}`).join('\n');

      const prompt = this.buildPrompt(this.dedupPromptTemplate, {
        functions_summary: summary,
        requirement_text: requirementText,
      });

      const raw = await this.llm.generateJson(prompt, systemPrompt ?? "");
      const content = BaseGenerator.unwrapContent(raw);

      if (Array.isArray(content)) {
        // 返回要被删除的 function id 列表
        const toRemove = new Set<string>();
        for (const item of content) {
          for (const m of (item.merge || [])) {
            toRemove.add(String(m));
          }
        }
        (merged.functions as Array<Record<string, unknown>>) =
          funcs.filter(f => !toRemove.has(String(f.id ?? f.name ?? "")));

        return content.map((c: any) => c.reason || "");
      }
      return [];
    } catch {
      return [];
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
      .replace(/\s+/g, "")
      .trim();
  }
}
