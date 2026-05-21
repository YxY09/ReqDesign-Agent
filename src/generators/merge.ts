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

    // 将所有分析结果格式化后填入 prompt
    const resultsStr = artifacts
      .map((a, i) => {
        const json = JSON.stringify(a.content, null, 2);
        return `### 分析结果 ${i + 1}（${a.taskId}）\n\`\`\`json\n${json}\n\`\`\``;
      })
      .join("\n\n");

    const safeText = this.sanitizePlaceholder(requirementText || "", "requirement_text");
    let prompt = this.buildPrompt(this.promptTemplate, {
      analyze_results: resultsStr,
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
}
