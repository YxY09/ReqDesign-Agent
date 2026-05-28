/**
 * BaseGenerator — LLM 内容生产层（Layer 1）
 *
 * 职责：加载 prompt 模板 → 调用 LLM → 返回结构化输出
 * 不涉及：状态管理、多步编排、后处理、评分
 *
 * 实现类：SystemDesigner, TestCaseGenerator, RequirementAnalyzer,
 *         DiagramGenerator, AnalyzeMerger
 */

import type { LLMClient } from "../llmClient.js";
import { createToolError } from "../tools/types.js";

export abstract class BaseGenerator<TOutput> {
  protected llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  /** 对输入文本进行清理，防止与 prompt 模板中的占位符发生冲突 */
  protected sanitizePlaceholder(text: string, placeholder: string): string {
    return text.replace(new RegExp(`\\{${placeholder}\\}`, "g"), "");
  }

  /** 替换所有占位符，构建最终 prompt */
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

  /** 解除 LLM JSON 响应中 {content: {...}} 包装 */
  static unwrapContent(
    result: Record<string, unknown>,
  ): Record<string, unknown> {
    const content = result["content"];
    if (typeof content === "object" && content !== null && !Array.isArray(content)) {
      return content as Record<string, unknown>;
    }
    return result;
  }

  /** 格式化列表项，用于在 prompt 中生成契约/检查清单 */
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

  /** generateJson 的重试包装器，带类型验证。
   * 子类应调用此方法而非自行实现重试循环。
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
          throw createToolError("GEN_NON_DICT", `LLM returned non-dict type: ${typeof result}`, { recoverable: true });
        }
        return result as Record<string, unknown>;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt >= maxRetries) {
          throw createToolError("GEN_FAILED", `Generation failed after ${maxRetries} attempts: ${lastError.message}`, { recoverable: true });
        }
      }
    }
    throw lastError!;
  }

  abstract generate(input: unknown): Promise<TOutput>;
}
