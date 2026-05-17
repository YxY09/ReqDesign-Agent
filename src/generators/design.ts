/**
 * SystemDesigner — generates system design documents from requirement JSON.
 */

import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";

const GENERIC_SUFFIXES = new Set([
  "Account",
  "Data",
  "Detail",
  "Domain",
  "Dto",
  "Entity",
  "Info",
  "Model",
  "Object",
  "Vo",
  "Bean",
]);

const HELPER_CLASS_SUFFIXES = [
  "Service",
  "Controller",
  "Repository",
  "Manager",
  "Gateway",
  "Handler",
  "Client",
  "ClientImpl",
  "Facade",
  "Helper",
  "Utils",
  "Util",
  "Adapter",
  "Factory",
  "Provider",
  "Validator",
  "Processor",
  "Scheduler",
  "Task",
  "Worker",
  "Config",
  "Context",
  "Mapper",
  "Dao",
  "Repo",
];

function splitPascalCase(name: string): string[] {
  return name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [];
}

function normalizeDomainName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]/g, "");
  if (!cleaned) return "";

  let tokens = splitPascalCase(cleaned);
  while (tokens.length > 1 && GENERIC_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }
  return tokens.join("").toLowerCase();
}

function extractClassNames(designText: string): string[] {
  const classNames = new Set<string>();
  const classRe = /class\s+([A-Za-z_]\w*)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = classRe.exec(designText)) !== null) {
    classNames.add(match[1]);
  }
  return [...classNames];
}

function isHelperClassName(name: string): boolean {
  return HELPER_CLASS_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export class SystemDesigner {
  private llm: LLMClient;
  private promptTemplate: string;

  constructor(llm: LLMClient) {
    this.llm = llm;
    this.promptTemplate = loadPrompt(
      "design_planner.md",
      "请根据以下需求分析结果和原始需求生成系统设计方案：\n\n结构化需求：\n{requirement_json}\n\n原始需求：\n{requirement_text}",
    );
  }

  async generateDesign(
    requirementJson: Record<string, unknown>,
    requirementText = "",
    systemPrompt?: string,
  ): Promise<string> {
    if (!requirementJson || typeof requirementJson !== "object") {
      throw new Error("需求JSON不能为空且必须是字典类型");
    }

    let reqStr = JSON.stringify(requirementJson, null, 2);
    reqStr = reqStr.replace(/\{requirement_json\}/g, "").replace(/\{design_text\}/g, "");
    const safeText = (requirementText || "").replace(/\{requirement_text\}/g, "");
    let prompt = this.promptTemplate.replace(/\{requirement_json\}/g, reqStr);
    prompt = prompt.replace(/\{requirement_text\}/g, safeText);

    const result = await this.llm.generateText(prompt, systemPrompt ?? "");
    return result;
  }

  static validateDesign(designText: string, requirementJson: Record<string, unknown>): string[] {
    const warnings: string[] = [];

    if (!designText?.trim()) {
      warnings.push("设计文档为空");
      return warnings;
    }
    if (!requirementJson || typeof requirementJson !== "object") {
      warnings.push("需求分析结果为空");
      return warnings;
    }

    const requiredSections = ["模块划分", "核心类", "数据流"];
    for (const section of requiredSections) {
      if (!designText.includes(section)) {
        warnings.push(`缺少关键章节: ${section}`);
      }
    }

    const declaredClassNames = extractClassNames(designText);
    const normalizedClassNames = new Set(
      declaredClassNames.map(normalizeDomainName).filter(Boolean),
    );

    const functions = requirementJson["functions"];
    if (Array.isArray(functions)) {
      for (const func of functions) {
        const name = typeof func === "object" && func !== null
          ? (func as Record<string, unknown>).name ?? (func as Record<string, unknown>).id
          : String(func);
        const fid = typeof func === "object" && func !== null
          ? (func as Record<string, unknown>).id
          : "";
        if (name && !designText.includes(String(name))) {
          const label = fid || name;
          warnings.push(`功能 ${label} 未在设计中体现`);
        }
      }
    }

    const entities = requirementJson["entities"];
    if (Array.isArray(entities)) {
      const normalizedEntityNames = new Set<string>();
      for (const ent of entities) {
        const name = typeof ent === "object" && ent !== null
          ? (ent as Record<string, unknown>).name
          : String(ent);
        if (!name) continue;
        if (/[\u4e00-\u9fff]/.test(String(name))) continue;

        const normalized = normalizeDomainName(String(name));
        if (normalized) normalizedEntityNames.add(normalized);

        const directMatch = designText.includes(String(name)) || declaredClassNames.includes(String(name));
        const normalizedMatch = normalized
          ? normalizedClassNames.has(normalized)
          : false;

        if (!directMatch && !normalizedMatch) {
          warnings.push(`实体 ${name} 未在设计中体现`);
        }
      }

      const extraCoreClasses = declaredClassNames.filter((name) => {
        if (isHelperClassName(name)) return false;
        const normalized = normalizeDomainName(name);
        if (!normalized) return false;
        return !normalizedEntityNames.has(normalized);
      });
      if (extraCoreClasses.length > 0) {
        warnings.push(`设计中出现未在需求中识别的核心类: ${extraCoreClasses.join(", ")}`);
      }
    }

    return warnings;
  }
}
