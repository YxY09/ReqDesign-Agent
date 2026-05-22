/**
 * SystemDesigner — 根据需求 JSON 生成系统设计文档。
 */

import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";
import { createToolError } from "../tools/types.js";
import { BaseGenerator } from "./base.js";

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

function extractCoreClassSection(designText: string): string {
  const headingRe = /^#{2,}\s*.*核心类.*$/gim;
  const match = headingRe.exec(designText);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = designText.slice(start);
  const nextHeading = rest.search(/^#{2,}\s+/m);
  return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
}

function extractCoreClassTableNames(designText: string): string[] {
  const names = new Set<string>();
  const section = extractCoreClassSection(designText);
  if (!section.trim()) return [];

  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    if (/^\|\s*-+/.test(trimmed)) continue;
    if (/类名|Class/i.test(trimmed)) continue;

    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/^`|`$/g, ""));
    const first = cells[0] ?? "";
    const name = first.match(/^I?[A-Z][A-Za-z0-9_]*$/)?.[0];
    if (name) names.add(name);
  }
  return [...names];
}

function extractClassDiagramSections(designText: string): string[] {
  const sections: string[] = [];
  const fenceRe = /```(?:mermaid)?\s*([\s\S]*?)```/g;
  let fence: RegExpExecArray | null;
  while ((fence = fenceRe.exec(designText)) !== null) {
    if (fence[1].includes("classDiagram")) sections.push(fence[1]);
  }
  if (sections.length === 0 && designText.includes("classDiagram")) {
    sections.push(designText);
  }
  return sections;
}

function extractReferencedClassNames(designText: string): string[] {
  const refs = new Set<string>();
  const classDiagramText = extractClassDiagramSections(designText).join("\n");
  if (!classDiagramText.trim()) return [];

  const relationRe = /^\s*([A-Za-z_]\w*)\s+(?:"[^"]*"\s+)?(?:<?--|-->|--|o--|\*--|\.\.>)\s+(?:"[^"]*"\s+)?([A-Za-z_]\w*)/gm;
  let relation: RegExpExecArray | null;
  while ((relation = relationRe.exec(classDiagramText)) !== null) {
    refs.add(relation[1]);
    refs.add(relation[2]);
  }

  const genericRe = /(?:List|Set|Array|Collection|Map)~([A-Za-z_]\w*)~/g;
  let generic: RegExpExecArray | null;
  while ((generic = genericRe.exec(classDiagramText)) !== null) {
    refs.add(generic[1]);
  }
  return [...refs];
}

function isHelperClassName(name: string): boolean {
  return HELPER_CLASS_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function containsToken(text: string, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (/^[A-Za-z]\d+$/.test(trimmed)) {
    return new RegExp(`\\b${trimmed}\\b`).test(text);
  }
  return text.includes(trimmed);
}

function itemId(item: unknown): string {
  if (typeof item === "object" && item !== null) {
    return String((item as Record<string, unknown>).id ?? "").trim();
  }
  return "";
}

function collectIds(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items.map(itemId).filter(Boolean);
}

function extractRequirementIds(designText: string, prefixes: string[]): string[] {
  const prefixGroup = prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const idRe = new RegExp(`\\b(?:${prefixGroup})\\d{3,}\\b`, "g");
  return [...new Set(designText.match(idRe) ?? [])];
}

// isSimpleRequirement / isMediumRequirement removed — overdesign self-check
// moved entirely to evaluation phase to avoid false positives from
// "不采用X" / "未引入X" explanations in design text.

export class SystemDesigner extends BaseGenerator<string> {
  private promptTemplate: string;

  constructor(llm: LLMClient) {
    super(llm);
    this.promptTemplate = loadPrompt(
      "design_planner.md",
      "请根据以下需求分析结果和原始需求生成系统设计方案：\n\n结构化需求：\n{requirement_json}\n\n原始需求：\n{requirement_text}",
    );
  }

  async generate(
    requirementJson: Record<string, unknown>,
    requirementText = "",
    systemPrompt?: string,
  ): Promise<string> {
    return this.generateDesign(requirementJson, requirementText, systemPrompt);
  }

  async generateDesign(
    requirementJson: Record<string, unknown>,
    requirementText = "",
    systemPrompt?: string,
  ): Promise<string> {
    if (!requirementJson || typeof requirementJson !== "object") {
      throw createToolError("DESIGN_EMPTY_INPUT", "需求JSON不能为空且必须是字典类型", { recoverable: false });
    }

    let reqStr = JSON.stringify(requirementJson, null, 2);
    reqStr = this.sanitizePlaceholder(reqStr, "requirement_json");
    reqStr = this.sanitizePlaceholder(reqStr, "design_text");
    const safeText = this.sanitizePlaceholder(requirementText || "", "requirement_text");
    let prompt = this.promptTemplate.replace(/\{requirement_json\}/g, reqStr);
    prompt = prompt.replace(
      /\{requirement_text\}/g,
      `${SystemDesigner.buildDesignContract(requirementJson)}\n\n${safeText}`,
    );

    const result = await this.llm.generateText(prompt, systemPrompt ?? "");
    return result;
  }

  static buildDesignContract(requirementJson: Record<string, unknown>): string {
    const functions = BaseGenerator.formatContractList(
      requirementJson.functions,
      ["id", "name", "description"],
    );

    // Build sub-capabilities section for each function that has them
    const functionsWithSubs = (Array.isArray(requirementJson.functions)
      ? requirementJson.functions as Array<Record<string, unknown>>
      : []).filter((fn) =>
        Array.isArray(fn.sub_capabilities) && fn.sub_capabilities.length > 0 ||
        Array.isArray(fn.acceptance_criteria) && fn.acceptance_criteria.length > 0,
      );
    const subCapsLines = functionsWithSubs.length > 0
      ? [
          "### 功能子能力与验收点（设计必须覆盖）",
          ...functionsWithSubs.map((fn) => {
            const id = String(fn.id ?? "");
            const subs = Array.isArray(fn.sub_capabilities) ? fn.sub_capabilities as string[] : [];
            const acs = Array.isArray(fn.acceptance_criteria) ? fn.acceptance_criteria as string[] : [];
            const parts: string[] = [];
            if (subs.length > 0) parts.push(`  子能力: ${subs.join(", ")}`);
            if (acs.length > 0) parts.push(`  验收点: ${acs.join(", ")}`);
            return `- ${id} ${String(fn.name ?? "")}:\n${parts.join("\n")}`;
          }),
        ]
      : [];

    const entities = BaseGenerator.formatContractList(
      requirementJson.entities,
      ["name", "description"],
    );
    const constraints = BaseGenerator.formatContractList(
      requirementJson.constraints,
      ["id", "description"],
    );
    const exceptions = BaseGenerator.formatContractList(
      requirementJson.exceptions,
      ["id", "description", "trigger", "handling"],
    );

    return [
      "## 设计合同（硬性约束，必须逐项遵守）",
      "以下清单是设计阶段唯一可信的 ID 和核心领域类来源。不要新增、改名或重新编号。",
      functions.length > 0 ? `### 功能 ID 清单\n${functions.map((item) => `- ${item}`).join("\n")}` : "",
      entities.length > 0 ? `### 允许的核心领域类\n${entities.map((item) => `- ${item}`).join("\n")}` : "",
      constraints.length > 0 ? `### 约束 ID 清单\n${constraints.map((item) => `- ${item}`).join("\n")}` : "",
      exceptions.length > 0 ? `### 异常 ID 清单\n${exceptions.map((item) => `- ${item}`).join("\n")}` : "",
      subCapsLines.length > 0 ? subCapsLines.join("\n") : "",
      "### 输出前自检",
      "- 模块划分必须覆盖全部功能 ID，且每个 ID 所在模块语义必须匹配功能名称和描述。",
      "- 核心类/接口设计里的核心领域类必须来自“允许的核心领域类”清单，大小写完全一致。",
      "- 异常处理设计必须使用异常 ID 清单中的原始编号，例如 X001 就必须写 X001，不能改成 E001。",
      "- 约束处理设计必须使用约束 ID 清单中的原始编号。",
    ].filter(Boolean).join("\n\n");
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

    const declaredClassNames = [
      ...new Set([
        ...extractClassNames(designText),
        ...extractCoreClassTableNames(designText),
      ]),
    ];
    const declaredClassNameSet = new Set(declaredClassNames);
    const undefinedRefs = extractReferencedClassNames(designText)
      .filter((name) => !declaredClassNameSet.has(name));
    if (undefinedRefs.length > 0) {
      warnings.push(`类图引用了未定义的类: ${[...new Set(undefinedRefs)].join(", ")}`);
    }

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
        const hasName = name ? containsToken(designText, String(name)) : false;
        const hasId = fid ? containsToken(designText, String(fid)) : false;
        if (name && !hasName && !hasId) {
          const label = fid || name;
          warnings.push(`功能 ${label} 未在设计中体现`);
        }
      }
    }

    // NOTE: Overdesign signal check moved to evaluation phase only.
    // Self-check cannot reliably distinguish "不采用X" explanations from actual
    // usage of X, and the false positive rate is too high for deterministic checks.
    // The evaluation LLM can judge intent correctly.

    // NOTE: Medium overdesign check also moved to evaluation phase for the same reason.

    const constraintIds = collectIds(requirementJson["constraints"]);
    if (constraintIds.length > 0) {
      for (const id of constraintIds) {
        if (!containsToken(designText, id)) {
          warnings.push(`约束 ${id} 未在设计中体现`);
        }
      }
    }

    const exceptionIds = collectIds(requirementJson["exceptions"]);
    if (exceptionIds.length > 0) {
      for (const id of exceptionIds) {
        if (!containsToken(designText, id)) {
          warnings.push(`异常 ${id} 未在设计中体现`);
        }
      }
      const allowed = new Set(exceptionIds);
      const observed = extractRequirementIds(designText, ["E", "X"]);
      const undefinedExceptionIds = observed.filter((id) => {
        if (!/^E\d{3,}$|^X\d{3,}$/.test(id)) return false;
        return !allowed.has(id);
      });
      if (undefinedExceptionIds.length > 0) {
        warnings.push(`设计引用了未定义的异常 ID: ${undefinedExceptionIds.join(", ")}`);
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
