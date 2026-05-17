/**
 * AnalyzeMerger — LLM-based merge of multiple analyze results.
 *
 * Takes all analyze artifacts, sends them to the LLM with the merge prompt,
 * returns a clean, unified requirementJson.
 */

import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";

export class AnalyzeMerger {
  private llm: LLMClient;
  private promptTemplate: string;

  constructor(llm: LLMClient) {
    this.llm = llm;
    this.promptTemplate = loadPrompt(
      "merge_analysis.md",
      "请合并以下多份需求分析结果：\n\n{analyze_results}",
    );
  }

  async merge(
    artifacts: Array<{ taskId: string; content: Record<string, unknown> }>,
    requirementText: string,
    systemPrompt?: string,
  ): Promise<Record<string, unknown>> {
    if (artifacts.length === 0) {
      throw new Error("没有可合并的分析结果");
    }

    // Single artifact: no merge needed, just return it
    if (artifacts.length === 1) {
      return artifacts[0].content;
    }

    // Format all artifacts for the prompt
    const resultsStr = artifacts
      .map((a, i) => {
        const json = JSON.stringify(a.content, null, 2);
        return `### 分析结果 ${i + 1}（${a.taskId}）\n\`\`\`json\n${json}\n\`\`\``;
      })
      .join("\n\n");

    let prompt = this.promptTemplate.replace(/\{analyze_results\}/g, resultsStr);
    const safeText = (requirementText || "").replace(/\{requirement_text\}/g, "");
    prompt = prompt.replace(/\{requirement_text\}/g, safeText);

    const result = await this.llm.generateJson(prompt, systemPrompt ?? "");

    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error("merge 返回了非字典类型");
    }

    return AnalyzeMerger._unwrapContent(result);
  }

  static _unwrapContent(result: Record<string, unknown>): Record<string, unknown> {
    const content = result["content"];
    if (typeof content === "object" && content !== null && !Array.isArray(content)) {
      return content as Record<string, unknown>;
    }
    return result;
  }
}
