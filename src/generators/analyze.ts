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

    if (Array.isArray(result.functions)) {
      for (const func of result.functions) {
        if (typeof func !== "object" || func === null) continue;
        const rec = func as Record<string, unknown>;
        const id = String(rec.id ?? rec.name ?? "unknown");
        if (!rec.preconditions) warnings.push(`功能 ${id} 缺少 preconditions 字段`);
        const priority = String(rec.priority ?? "");
        if (priority && !["high", "medium", "low"].includes(priority)) {
          warnings.push(`功能 ${id} priority 必须为 high/medium/low`);
        }
      }
    }

    if (Array.isArray(result.entities)) {
      for (const ent of result.entities) {
        if (typeof ent !== "object" || ent === null) continue;
        const rec = ent as Record<string, unknown>;
        const name = String(rec.name ?? "unknown");
        if (!Array.isArray(rec.attributes) || rec.attributes.length === 0) {
          warnings.push(`实体 ${name} 缺少 attributes`);
        } else if (rec.attributes.some((attr) =>
          typeof attr !== "object" ||
          attr === null ||
          !("name" in attr) ||
          !("type" in attr) ||
          !("description" in attr)
        )) {
          warnings.push(`实体 ${name} attributes 必须包含 name/type/description`);
        }
        if (!Array.isArray(rec.relationships)) {
          warnings.push(`实体 ${name} 缺少 relationships 字段`);
        }
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
    RequirementAnalyzer._normalizeFunctions(result);
    RequirementAnalyzer._normalizeEntities(result);
    RequirementAnalyzer._ensureActorEntities(result);
    return result;
  }

  private static _normalizeFunctions(result: Record<string, unknown>): void {
    const functions = result.functions;
    if (!Array.isArray(functions)) return;
    for (const func of functions) {
      if (typeof func !== "object" || func === null) continue;
      const rec = func as Record<string, unknown>;
      if (typeof rec.priority === "string") {
        const p = rec.priority.trim().toLowerCase();
        const map: Record<string, string> = {
          "高": "high",
          "中": "medium",
          "低": "low",
          "p0": "high",
          "p1": "medium",
          "p2": "low",
        };
        rec.priority = map[p] ?? p;
      }
      if (!rec.preconditions) rec.preconditions = "";
    }
  }

  private static _normalizeEntities(result: Record<string, unknown>): void {
    const entities = result.entities;
    if (!Array.isArray(entities)) return;
    for (const ent of entities) {
      if (typeof ent !== "object" || ent === null) continue;
      const rec = ent as Record<string, unknown>;
      if (!Array.isArray(rec.relationships)) rec.relationships = [];
      if (!Array.isArray(rec.attributes)) {
        rec.attributes = [];
        continue;
      }
      rec.attributes = rec.attributes.map((attr) => {
        if (typeof attr === "object" && attr !== null && !Array.isArray(attr)) {
          const obj = attr as Record<string, unknown>;
          return {
            name: String(obj.name ?? "").trim(),
            type: String(obj.type ?? "String").trim() || "String",
            description: String(obj.description ?? "").trim(),
          };
        }
        return RequirementAnalyzer._parseAttributeString(String(attr));
      });
    }
  }

  private static _ensureActorEntities(result: Record<string, unknown>): void {
    const actors = Array.isArray(result.actors) ? result.actors : [];
    if (!Array.isArray(result.entities)) result.entities = [];
    const entities = result.entities as unknown[];
    const existing = new Set(
      entities
        .filter((ent): ent is Record<string, unknown> => typeof ent === "object" && ent !== null && !Array.isArray(ent))
        .map((ent) => String(ent.name ?? "").trim().toLowerCase())
        .filter(Boolean),
    );

    for (const actor of actors) {
      const name = typeof actor === "object" && actor !== null
        ? String((actor as Record<string, unknown>).name ?? "").trim()
        : String(actor ?? "").trim();
      if (!name || existing.has(name.toLowerCase())) continue;
      const description = typeof actor === "object" && actor !== null
        ? String((actor as Record<string, unknown>).description ?? `${name} 角色实体`).trim()
        : `${name} 角色实体`;
      entities.push({
        name,
        description,
        attributes: [
          { name: "id", type: "Long", description: `${name} 唯一标识` },
          { name: "status", type: "String", description: `${name} 状态` },
        ],
        relationships: [],
      });
      existing.add(name.toLowerCase());
    }
  }

  private static _parseAttributeString(raw: string): Record<string, string> {
    const text = raw.trim();
    const match = text.match(/^([^:：\\-]+)\s*[:：]\s*([^\\-]+?)\s*(?:-\s*(.*))?$/);
    if (!match) {
      const name = text.replace(/\s+/g, "") || "field";
      return { name, type: "String", description: text };
    }
    return {
      name: match[1].trim(),
      type: match[2].trim() || "String",
      description: (match[3] ?? match[1]).trim(),
    };
  }
}
