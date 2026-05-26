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
  private promptTemplate: string;
  private relationshipPromptTemplate: string;
  private constraintPromptTemplate: string;

  constructor(llm: LLMClient) {
    super(llm);
    this.promptTemplate = loadPrompt(
      "merge_analysis.md",
      "请合并以下多份需求分析结果：\n\n{analyze_results}",
    );
    this.relationshipPromptTemplate = loadPrompt(
      "merge_relationships.md",
      "",
    );
    this.constraintPromptTemplate = loadPrompt(
      "merge_constraints.md",
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

    // 将预合并结果（而非原始分片）发给 LLM，LLM 仅做关系补全和冲突解决
    const preMergedStr = JSON.stringify(preMerged, null, 2);
    const safeText = this.sanitizePlaceholder(requirementText || "", "requirement_text");
    let prompt = this.buildPrompt(this.promptTemplate, {
      analyze_results: `### 预合并结果（所有分析结果的并集，已按名称去重）\n\`\`\`json\n${preMergedStr}\n\`\`\`\n\n请基于以上并集和原始需求文档，解决命名冲突、补全跨模块关系、统一ID编号。不要删除任何实体或功能——它们是各自业务领域的核心概念。`,
      requirement_text: safeText,
    });

    const result = await this.llm.generateJson(prompt, systemPrompt ?? "");

    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw createToolError("MERGE_NON_DICT", "merge 返回了非字典类型", { recoverable: false });
    }

    const merged = BaseGenerator.unwrapContent(result);

    // 关系补全：通过 LLM 推断跨模块缺失关系，仅输出关系补丁并追加
    const patches = await this._completeRelationships(merged, safeText);
    AnalyzeMerger._applyRelationshipPatches(merged, patches);

    // 约束补全：通过 LLM 扫描缺失的业务规则和异常流程
    const constraintPatches = await this._completeConstraints(merged, safeText);
    AnalyzeMerger._applyConstraintPatches(merged, constraintPatches);

    RequirementNormalizer.normalize(merged);
    RequirementNormalizer.normalizeAgainstSource(merged, requirementText);
    return merged;
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

    return result;
  }

  /**
   * 关系补全：传入合并后的实体列表和原始需求，LLM 仅输出关系补丁数组。
   * 失败时返回空数组，不影响主流程。
   */
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
   */
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
}
