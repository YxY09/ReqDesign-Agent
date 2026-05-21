/**
 * BaseGenerator — LLM 内容生产层 (Layer 1)
 *
 * 职责：加载 prompt 模板 → 调用 LLM → 返回结构化输出
 * 不涉及：状态管理、多步编排、后处理、评分
 *
 * 实现类：SystemDesigner, TestCaseGenerator, RequirementAnalyzer,
 *         DiagramGenerator, AnalyzeMerger
 */

import type { LLMClient } from "../llmClient.js";

export abstract class BaseGenerator<TOutput> {
  protected llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  /** Sanitize input text to prevent placeholder collision with prompt template */
  protected sanitizePlaceholder(text: string, placeholder: string): string {
    return text.replace(new RegExp(`\\{${placeholder}\\}`, "g"), "");
  }

  /** Build final prompt by replacing all placeholders */
  protected buildPrompt(
    template: string,
    replacements: Record<string, string>,
  ): string {
    let prompt = template;
    for (const [key, value] of Object.entries(replacements)) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, "g"), value);
    }
    return prompt;
  }

  /** Unwrap {content: {...}} wrapper from LLM JSON responses */
  static unwrapContent(
    result: Record<string, unknown>,
  ): Record<string, unknown> {
    const content = result["content"];
    if (typeof content === "object" && content !== null && !Array.isArray(content)) {
      return content as Record<string, unknown>;
    }
    return result;
  }

  /** Format items for contract/checklist inclusion in prompts */
  static formatContractList(
    items: unknown,
    fields: string[],
  ): string[] {
    if (!Array.isArray(items)) return [];
    return items.map((item) => {
      if (typeof item !== "object" || item === null) return String(item);
      const record = item as Record<string, unknown>;
      return fields
        .map((field) => String(record[field] ?? "").trim())
        .filter(Boolean)
        .join(" | ");
    }).filter(Boolean);
  }

  /**
   * Retry wrapper for generateJson calls with type validation.
   * Subclasses call this instead of manual retry loops.
   */
  protected async generateJsonWithRetry(
    prompt: string,
    systemPrompt: string,
    maxRetries: number,
  ): Promise<Record<string, unknown>> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.llm.generateJson(prompt, systemPrompt);
        if (typeof result !== "object" || result === null || Array.isArray(result)) {
          throw new Error(`LLM returned non-dict type: ${typeof result}`);
        }
        return result as Record<string, unknown>;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt >= maxRetries) {
          throw new Error(`Generation failed after ${maxRetries} attempts: ${lastError.message}`);
        }
      }
    }
    throw lastError!;
  }

  abstract generate(...args: any[]): Promise<TOutput>;
}
