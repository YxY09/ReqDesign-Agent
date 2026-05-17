/**
 * RequirementAnalyzer — extracts structured JSON from natural language requirements.
 */

import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";

export class RequirementAnalyzer {
  static readonly REQUIRED_FIELDS = ["actors", "functions", "entities"];
  static readonly OPTIONAL_FIELDS = ["constraints", "exceptions", "non_functional_requirements", "business_processes"];

  private llm: LLMClient;
  private promptTemplate: string;

  constructor(llm: LLMClient) {
    this.llm = llm;
    this.promptTemplate = loadPrompt(
      "requirement_analysis.md",
      "请从以下需求文档中抽取结构化的需求要素，以JSON格式输出：\n\n{requirement_text}",
    );
  }

  async analyze(
    requirementText: string,
    maxRetries = 3,
    systemPrompt?: string,
    existingJson?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!requirementText && !existingJson) {
      throw new Error("需求文本和已有分析结果不能同时为空");
    }

    let prefix = "";
    if (existingJson) {
      const existingStr = JSON.stringify(existingJson, null, 2).slice(0, 4000);
      prefix = `## 已有的结构化需求结果（请在此基础上补充缺失内容、去重并统一命名）\n\`\`\`json\n${existingStr}\n\`\`\`\n\n`;
    }

    const safeText = (requirementText || "").replace(/\{requirement_text\}/g, "");
    const prompt = prefix + this.promptTemplate.replace(/\{requirement_text\}/g, safeText);

    let result = await this._generateWithRetry(prompt, systemPrompt ?? "", maxRetries);
    result = RequirementAnalyzer._unwrapContentResult(result);
    result = RequirementAnalyzer._normalizeResult(result);

    return result;
  }

  private async _generateWithRetry(
    prompt: string,
    systemMsg: string,
    maxRetries: number,
  ): Promise<Record<string, unknown>> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.llm.generateJson(prompt, systemMsg);
        if (typeof result !== "object" || result === null || Array.isArray(result)) {
          throw new Error(`LLM返回非字典类型: ${typeof result}`);
        }
        return result as Record<string, unknown>;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < maxRetries) {
          // retry
        } else {
          throw new Error(`需求分析结果解析失败: ${lastError.message}`);
        }
      }
    }
    throw lastError!;
  }

  static validateResult(result: Record<string, unknown>): string[] {
    const warnings: string[] = [];
    if (!result || typeof result !== "object") {
      warnings.push("需求分析结果为空");
      return warnings;
    }

    for (const field of RequirementAnalyzer.REQUIRED_FIELDS) {
      const val = result[field];
      if (val === undefined || val === null) {
        warnings.push(`缺少必需字段: ${field}`);
      } else if (Array.isArray(val) && val.length === 0) {
        warnings.push(`${field} 为空`);
      }
    }

    for (const field of RequirementAnalyzer.OPTIONAL_FIELDS) {
      if (!(field in result)) {
        warnings.push(`建议补充可选字段: ${field}`);
      }
    }

    return warnings;
  }

  static _unwrapContentResult(result: Record<string, unknown>): Record<string, unknown> {
    const content = result["content"];
    if (typeof content === "object" && content !== null && !Array.isArray(content)) {
      return content as Record<string, unknown>;
    }
    return result;
  }

  static _normalizeResult(result: Record<string, unknown>): Record<string, unknown> {
    const listFields = [
      "actors", "functions", "entities", "constraints",
      "exceptions", "non_functional_requirements", "business_processes",
    ];
    for (const field of listFields) {
      const val = result[field];
      if (val === undefined || val === null) {
        result[field] = [];
      } else if (!Array.isArray(val)) {
        if (typeof val === "string" && ["", "none", "null", "无"].includes(val.toLowerCase())) {
          result[field] = [];
        } else {
          result[field] = [val];
        }
      }
    }
    return result;
  }
}
