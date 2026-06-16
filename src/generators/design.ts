/**
 * SystemDesigner — 根据需求 JSON 生成系统设计文档。
 */

import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";
import { minimizeForPrompt } from "../shared/minimizeJsonForPrompt.js";
import { RequirementIndex } from "../shared/requirementIndex.js";
import { extractRelationEndpoints } from "../shared/mermaidRelations.js";
import { semanticCoverageState, semanticItemId, tokenContains, semanticMatch, semanticTerms } from "../shared/semanticCoverage.js";
import type { DesignModel } from "../shared/types.js";
import { isDesignModel } from "../shared/types.js";
import { createToolError } from "../tools/types.js";
import { isAbortError } from "../utils/errors.js";
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
  "Generator",
  "Publisher",
  "Dispatcher",
  "Executor",
  "Builder",
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

  // Single source of truth: relation-endpoint extraction lives in
  // shared/mermaidRelations.js. Reusing it also picks up the `<|--` / `--|>`
  // inheritance arrows so dangling inheritance endpoints are flagged here
  // too, consistent with the entity (checkEntities) validation path.
  for (const name of extractRelationEndpoints(classDiagramText)) {
    refs.add(name);
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

function collectSemanticCoverageIssues(
  designText: string,
  items: unknown,
  fields: string[],
  label: string,
): string[] {
  if (!Array.isArray(items)) return [];
  const missing: string[] = [];
  const drifted: string[] = [];

  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const displayId = semanticItemId(rec);
    if (!displayId) continue;
    const state = semanticCoverageState(designText, rec, fields);
    if (state === "missing") {
      missing.push(displayId);
      continue;
    }
    if (state === "drifted") {
      drifted.push(displayId);
    }
  }

  const warnings: string[] = [];
  if (missing.length > 0) {
    warnings.push(`以下 ${missing.length} 个${label}未在设计中体现: ${missing.join(", ")}`);
  }
  if (drifted.length > 0) {
    warnings.push(`以下 ${drifted.length} 个${label}编号虽出现但语义未匹配原始需求: ${drifted.join(", ")}`);
  }
  return warnings;
}

function extractJustifiedExtraClassNames(designText: string): Set<string> {
  const justified = new Set<string>();
  const headingRe = /^#{2,}\s*.*(?:补充核心类|新增核心类|核心类依据|补充类依据).*$/gim;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(designText)) !== null) {
    const start = match.index + match[0].length;
    const rest = designText.slice(start);
    const nextHeading = rest.search(/^#{2,}\s+/m);
    const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
    for (const line of section.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
      if (/^\|\s*-+/.test(trimmed)) continue;
      if (/类名|Class/i.test(trimmed)) continue;
      const cells = trimmed.split("|").slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, ""));
      const className = cells[0]?.match(/^I?[A-Z][A-Za-z0-9_]*$/)?.[0];
      const evidence = cells.slice(1).join(" ");
      if (className && evidence.trim().length >= 4) justified.add(className);
    }
  }
  return justified;
}

// isSimpleRequirement / isMediumRequirement removed — overdesign self-check
// moved entirely to evaluation phase to avoid false positives from
// "不采用X" / "未引入X" explanations in design text.

export class SystemDesigner extends BaseGenerator<DesignModel> {
  private promptTemplate: string;

  constructor(llm: LLMClient) {
    super(llm);
    this.promptTemplate = loadPrompt(
      "design_planner.md",
      "请根据以下需求分析结果生成系统设计方案：\n\n结构化需求：\n{requirement_json}\n\n{requirement_text}",
    );
  }

  async generate(input: unknown): Promise<DesignModel> {
    if (input == null || typeof input !== "object" || Array.isArray(input)) {
      throw createToolError("DESIGN_EMPTY_INPUT", "generate() requires an object input with requirementJson", { recoverable: false });
    }
    const { requirementJson, systemPrompt } = input as {
      requirementJson: Record<string, unknown>;
      systemPrompt?: string;
    };
    return this.generateDesign(requirementJson, systemPrompt);
  }

  async generateDesign(
    requirementJson: Record<string, unknown>,
    systemPrompt?: string,
  ): Promise<DesignModel> {
    if (!requirementJson || typeof requirementJson !== "object") {
      throw createToolError("DESIGN_EMPTY_INPUT", "需求JSON不能为空且必须是字典类型", { recoverable: false });
    }

    let reqStr = JSON.stringify(minimizeForPrompt(requirementJson), null, 2);
    reqStr = this.sanitizePlaceholder(reqStr, "requirement_json");
    reqStr = this.sanitizePlaceholder(reqStr, "design_text");
    let prompt = this.promptTemplate.replace(/\{requirement_json\}/g, reqStr);
    const contractParts: string[] = [];
    if (systemPrompt) contractParts.push(systemPrompt);
    contractParts.push(SystemDesigner.buildDesignContract(requirementJson));
    prompt = prompt.replace(/\{requirement_text\}/g, contractParts.join("\n\n"));

    const maxAttempts = 3;
    const basePrompt = prompt;
    let bestModel: DesignModel | null = null;
    let bestGapCount = Infinity;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const raw = await this.generateJsonWithRetry(prompt, systemPrompt ?? "", 1);
        const model = SystemDesigner.parseDesignModel(raw);
        if (!model) {
          throw createToolError("DESIGN_PARSE_FAILED", "LLM output is not a valid DesignModel (missing required arrays)", { recoverable: true });
        }
        const gaps = SystemDesigner.checkCoverageGaps(model, requirementJson);
        if (gaps.length === 0) {
          return model;
        }
        if (gaps.length < bestGapCount) {
          bestModel = model;
          bestGapCount = gaps.length;
        }
        if (attempt >= maxAttempts) break;
        prompt = basePrompt + "\n\n" + SystemDesigner.buildCoverageHint(gaps, requirementJson);
      } catch (e) {
        if (isAbortError(e)) throw e;
        lastError = e instanceof Error ? e : new Error(String(e));
        prompt = basePrompt;
      }
    }
    if (bestModel) return bestModel;
    throw createToolError("DESIGN_FAILED", `Design JSON generation failed after ${maxAttempts} attempts: ${lastError!.message}`, { recoverable: true });
  }

  /**
   * Compare coverageMatrix entries against requirement items (functions,
   * constraints, exceptions) and return the list of items that lack a
   * corresponding coverage entry. Each gap includes the item id and kind.
   */
  static checkCoverageGaps(
    model: DesignModel,
    requirementJson: Record<string, unknown>,
  ): Array<{ id: string; kind: "function" | "constraint" | "exception" }> {
    const gaps: Array<{ id: string; kind: "function" | "constraint" | "exception" }> = [];

    // Index coverageMatrix entries by refId so we can fetch the designDecision
    // for content-completeness checks (e.g. a constraint listed by refId but
    // with an empty/generic designDecision that omits the source sub-rules).
    const entryByRefId = new Map<string, { designDecision: string }>();
    for (const entry of model.coverageMatrix) {
      const refId = String(entry.refId ?? "").trim();
      if (refId) entryByRefId.set(refId, { designDecision: String(entry.designDecision ?? "") });
    }

    const sourceTextOf = (rec: Record<string, unknown>): string => {
      return String(
        rec.source_text ?? rec.sourceText ?? rec.description ?? rec.text ?? "",
      ).trim();
    };

    const checkList = (
      items: unknown,
      kind: "function" | "constraint" | "exception",
    ) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        const displayId = String(rec.displayId ?? "").trim();
        const id = String(rec.id ?? "").trim();
        // A coverage entry matches if its refId equals displayId or id
        const matchedEntry = entryByRefId.get(displayId) ?? entryByRefId.get(id);
        if (!matchedEntry) {
          gaps.push({ id: displayId || id, kind });
          continue;
        }
        // Content completeness is enforced only for constraints with a
        // substantive source text (>10 chars): a listed-but-empty/generic
        // designDecision, or one that omits the source sub-rules/keywords
        // (e.g. “抗生素”), is treated as an uncovered gap.
        if (kind !== "constraint") continue;
        const designDecision = matchedEntry.designDecision.trim();
        const sourceText = sourceTextOf(rec);
        if (sourceText.length <= 10) continue;
        const tooThin = designDecision.length <= 10;
        // Content drift: the design decision must reflect the source text's
        // distinctive terms. semanticMatch alone is permissive for CJK
        // (structural bigrams like 处方/审核 can mask a dropped domain keyword
        // such as “抗生素”), so additionally require a ≥0.5 overlap ratio of
        // the source's distinctive terms in the decision.
        const drifted = !semanticMatch(designDecision, sourceText)
          || sourceTermOverlap(designDecision, sourceText) < 0.5;
        if (tooThin || drifted) {
          gaps.push({ id: displayId || id, kind });
        }
      }
    };

    checkList(requirementJson.functions, "function");
    checkList(requirementJson.constraints, "constraint");
    checkList(requirementJson.exceptions, "exception");

    return gaps;
  }

  /**
   * Build a retry prompt section listing coverage gaps with descriptions
   * so the LLM knows exactly which items it missed. Each gap includes the
   * item kind (function/constraint/exception), its ID, and its description
   * looked up from the requirement JSON.
   */
  static buildCoverageHint(
    gaps: Array<{ id: string; kind: "function" | "constraint" | "exception" }>,
    requirementJson: Record<string, unknown>,
  ): string {
    const findDescription = (
      list: unknown,
      id: string,
    ): string => {
      if (!Array.isArray(list)) return "";
      for (const item of list) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        if (String(rec.displayId ?? "").trim() === id || String(rec.id ?? "").trim() === id) {
          return String(rec.description ?? "").trim();
        }
      }
      return "";
    };

    const kindLabel: Record<string, string> = {
      function: "功能",
      constraint: "约束",
      exception: "异常",
    };

    const lines: string[] = [];
    lines.push("## 二次覆盖率要求");
    lines.push("上一轮设计在 coverageMatrix 中缺失以下条目，请务必逐一补充，每条都要有完整的设计决策（原始描述、设计决策、影响模块、影响类、测试启示）。");
    lines.push("");
    lines.push("必须保留约束源文本中的全部子规则与关键词（例如“抗生素”），不得遗漏。");
    lines.push("");

    for (const gap of gaps) {
      const desc = findDescription(requirementJson[`${gap.kind}s`], gap.id);
      lines.push(`- **${gap.id}** (${kindLabel[gap.kind]})${desc ? `: ${desc}` : ""}`);
    }

    return lines.join("\n");
  }

  static buildDesignContract(requirementJson: Record<string, unknown>): string {
    const safeFunctions = BaseGenerator.itemsWithSafeDisplayId(requirementJson.functions);
    const functions = BaseGenerator.formatContractList(
      safeFunctions,
      ["displayId", "name", "description"],
    );

    // Build sub-capabilities section for each function that has them
    const functionsWithSubs = safeFunctions.filter((fn) =>
      Array.isArray(fn.sub_capabilities) && fn.sub_capabilities.length > 0 ||
      Array.isArray(fn.acceptance_criteria) && fn.acceptance_criteria.length > 0,
    );
    const subCapsLines = functionsWithSubs.length > 0
      ? [
          "### 功能子能力与验收点（设计必须覆盖）",
          ...functionsWithSubs.map((fn) => {
            const id = String(fn.displayId ?? "");
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
      BaseGenerator.itemsWithSafeDisplayId(requirementJson.constraints),
      ["displayId", "description", "source_text"],
    );
    const exceptions = BaseGenerator.formatContractList(
      BaseGenerator.itemsWithSafeDisplayId(requirementJson.exceptions),
      ["displayId", "description", "trigger", "handling"],
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
      "- 必须输出 `## 设计覆盖矩阵` 章节，逐条列出功能、约束、异常的原始 ID、原始描述、设计决策、影响模块、影响类、测试启示。",
      "- 覆盖矩阵中的原始描述必须保留需求分析中的核心语义，不能只写 ID 或改写成其他约束。",
      "- 模块划分必须覆盖全部功能 ID，且每个 ID 所在模块语义必须匹配功能名称和描述。",
      "- 核心类/接口设计里的核心领域类必须来自“允许的核心领域类”清单，大小写完全一致。",
      "- 如果确实需要补充未在实体清单中的核心类，必须增加 `## 补充核心类依据` 表格，列出类名和需求原文依据；没有依据的补充类会被拒绝。",
      "- 异常处理设计必须使用异常 ID 清单中的原始编号，例如 X001 就必须写 X001，不能改成 E001。",
      "- 约束处理设计必须使用约束 ID 清单中的原始编号。",
    ].filter(Boolean).join("\n\n");
  }

  private static _cellSafe(text: string): string {
    return String(text ?? "").replace(/\|/g, "\\|");
  }

  static renderDesignMarkdown(model: DesignModel): string {
    const lines: string[] = [];
    const s = SystemDesigner._cellSafe;

    lines.push("## 模块划分\n");
    lines.push("| 模块名称 | 职责描述 | 对应功能 |");
    lines.push("|----------|----------|----------|");
    for (const mod of model.modules) {
      lines.push(`| ${s(mod.name)} | ${s(mod.responsibility)} | ${s(mod.functionIds.join(", "))} |`);
    }

    lines.push("\n## 核心类/接口设计\n");
    lines.push("| 类名 | 类型 | 职责 | 关联实体 |");
    lines.push("|------|------|------|----------|");
    for (const cls of model.classes) {
      lines.push(`| ${s(cls.name)} | ${s(cls.kind)} | ${s(cls.responsibility)} | ${s(cls.entityRef ?? "-")} |`);
    }
    for (const cls of model.classes) {
      lines.push(`\n### ${s(cls.name)}`);
      lines.push(`- **职责**: ${s(cls.responsibility)}`);
      if (cls.attributes && cls.attributes.length > 0) {
        lines.push("- **属性**:");
        for (const attr of cls.attributes) {
          lines.push(`  - ${s(attr.name)}: ${s(attr.type)}${attr.description ? ` — ${s(attr.description)}` : ""}`);
        }
      }
      if (cls.methods && cls.methods.length > 0) {
        lines.push("- **方法**: " + cls.methods.map(s).join(", "));
      }
      if (cls.entityRef) {
        lines.push(`- **关联实体**: ${s(cls.entityRef)}`);
      }
    }

    lines.push("\n## 数据流说明\n");
    for (const flow of model.dataFlows) {
      lines.push(`### ${s(flow.name)}`);
      if (flow.relatedFunctionIds.length > 0) {
        lines.push(`相关功能: ${s(flow.relatedFunctionIds.join(", "))}`);
      }
      flow.steps.forEach((step, i) => lines.push(`${i + 1}. ${s(step)}`));
      lines.push("");
    }

    lines.push("\n## 设计覆盖矩阵\n");
    lines.push("| ID | 类型 | 原始描述 | 设计决策 | 影响模块 | 影响类 | 测试启示 |");
    lines.push("|-----|------|----------|----------|---------|------|--------|");
    for (const entry of model.coverageMatrix) {
      const mods = s(entry.affectedModuleIds.join(", "));
      const cls = s(entry.affectedClassNames.join(", "));
      lines.push(`| ${s(entry.refId)} | ${s(entry.refKind)} | ${s(entry.originalDescription)} | ${s(entry.designDecision)} | ${mods} | ${cls} | ${s(entry.testImplication)} |`);
    }

    if (model.supplementaryClasses && model.supplementaryClasses.length > 0) {
      lines.push("\n## 补充核心类依据\n");
      lines.push("| 类名 | 需求原文依据 |");
      lines.push("|------|-------------|");
      for (const sc of model.supplementaryClasses) {
        lines.push(`| ${s(sc.name)} | ${s(sc.justification)} |`);
      }
    }

    return lines.join("\n");
  }

  static validateDesignModel(model: DesignModel, requirementJson: Record<string, unknown>): string[] {
    const warnings: string[] = [];

    if (!model.modules || model.modules.length === 0) warnings.push("DesignModel 缺少 modules");
    if (!model.classes || model.classes.length === 0) warnings.push("DesignModel 缺少 classes");
    if (!model.dataFlows || model.dataFlows.length === 0) warnings.push("DesignModel 缺少 dataFlows");
    if (!model.coverageMatrix || model.coverageMatrix.length === 0) warnings.push("DesignModel 缺少 coverageMatrix");

    const coveredFunctionIds = new Set<string>(model.modules.flatMap((m) => m.functionIds));
    const functions = Array.isArray(requirementJson.functions)
      ? (requirementJson.functions as Record<string, unknown>[])
      : [];
    for (const fn of functions) {
      const id = String(fn.id ?? "");
      const displayId = String(fn.displayId ?? "");
      if ((id || displayId) && !coveredFunctionIds.has(id) && !coveredFunctionIds.has(displayId)) {
        warnings.push(`功能 ${displayId || id} 未映射到任何模块的 functionIds`);
      }
    }

    const coveredRefIds = new Set<string>(model.coverageMatrix.map((e) => e.refId));
    const constraints = Array.isArray(requirementJson.constraints)
      ? (requirementJson.constraints as Record<string, unknown>[])
      : [];
    for (const c of constraints) {
      const displayId = String(c.displayId ?? "");
      const canonId = String(c.id ?? "");
      const label = displayId || canonId;
      if (label && !coveredRefIds.has(displayId) && !coveredRefIds.has(canonId)) {
        warnings.push(`约束 ${label} 未在 coverageMatrix 中体现`);
      }
    }
    const exceptions = Array.isArray(requirementJson.exceptions)
      ? (requirementJson.exceptions as Record<string, unknown>[])
      : [];
    for (const e of exceptions) {
      const displayId = String(e.displayId ?? "");
      const canonId = String(e.id ?? "");
      const label = displayId || canonId;
      if (label && !coveredRefIds.has(displayId) && !coveredRefIds.has(canonId)) {
        warnings.push(`异常 ${label} 未在 coverageMatrix 中体现`);
      }
    }

    return warnings;
  }

  static parseDesignModel(raw: Record<string, unknown>): DesignModel | null {
    const obj = SystemDesigner._unwrapDesignContent(raw);
    if (!isDesignModel(obj)) return null;
    return obj;
  }

  private static _unwrapDesignContent(raw: Record<string, unknown>): unknown {
    // Unwrap {content: {...}} or {design: {...}} LLM envelope
    if (isDesignModel(raw)) return raw;
    const inner = raw["content"] ?? raw["design"] ?? raw["result"];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner;
    return raw;
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

    const requirementIndex = RequirementIndex.fromRequirementJson(requirementJson);
    const referencedIds = requirementIndex.extractIds(designText);
    const unknownRequirementIds = requirementIndex.unknownReferences(referencedIds);
    if (unknownRequirementIds.length > 0) {
      warnings.push(`设计文档引用了未定义的需求 ID: ${unknownRequirementIds.join(", ")}`);
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
        const rec = typeof func === "object" && func !== null ? (func as Record<string, unknown>) : null;
        const name = rec ? (rec.name ?? rec.id) : String(func);
        const fid = rec ? String(rec.id ?? "") : "";
        const fdisplayId = rec ? String(rec.displayId ?? "") : "";
        const hasName = name ? tokenContains(designText, String(name)) : false;
        const hasId = fid ? tokenContains(designText, fid) : false;
        const hasDisplayId = fdisplayId ? tokenContains(designText, fdisplayId) : false;
        if (name && !hasName && !hasId && !hasDisplayId) {
          const label = fdisplayId || fid || name;
          warnings.push(`功能 ${label} 未在设计中体现`);
        }
      }
    }

    // NOTE: Overdesign signal check moved to evaluation phase only.
    // Self-check cannot reliably distinguish "不采用X" explanations from actual
    // usage of X, and the false positive rate is too high for deterministic checks.
    // The evaluation LLM can judge intent correctly.

    // NOTE: Medium overdesign check also moved to evaluation phase for the same reason.

    warnings.push(...collectSemanticCoverageIssues(
      designText,
      requirementJson["constraints"],
      ["description", "source_text", "sourceText", "canonicalRule", "canonicalRuleEn"],
      "约束",
    ));
    warnings.push(...collectSemanticCoverageIssues(
      designText,
      requirementJson["exceptions"],
      ["description", "trigger", "handling", "source_text", "sourceText"],
      "异常",
    ));

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

      const justifiedExtraClasses = extractJustifiedExtraClassNames(designText);
      const extraCoreClasses = declaredClassNames.filter((name) => {
        if (isHelperClassName(name)) return false;
        if (justifiedExtraClasses.has(name)) return false;
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

/**
 * Content-drift helper for constraint coverage: fraction of the source
 * text's distinctive terms (via semanticTerms, so CJK bigrams + ASCII word
 * tokens, stop words removed) that are reflected in the design decision.
 * Returns 1 when the source has no distinctive terms. Used to catch decisions
 * that list the constraint by id but drop a domain keyword (e.g. “抗生素").
 */
function sourceTermOverlap(designDecision: string, sourceText: string): number {
  const sourceTerms = new Set(semanticTerms(sourceText));
  if (sourceTerms.size === 0) return 1;
  const decisionTerms = new Set(semanticTerms(designDecision));
  let matched = 0;
  for (const term of sourceTerms) {
    if (decisionTerms.has(term)) matched++;
  }
  return matched / sourceTerms.size;
}
