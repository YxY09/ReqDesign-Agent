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

  constructor(llm: LLMClient) {
    super(llm);
    this.promptTemplate = loadPrompt(
      "merge_analysis.md",
      "请合并以下多份需求分析结果：\n\n{analyze_results}",
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
}
