/**
 * SystemDesigner — 根据需求 JSON 生成系统设计文档。
 */

import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";
import { buildDesignBrief } from "../shared/designBrief.js";
import { RequirementIndex } from "../shared/requirementIndex.js";
import { extractRelationEndpoints } from "../shared/mermaidRelations.js";
import { extractSalientAnchors, textIncludesAnchor } from "../shared/salientAnchors.js";
import { semanticCoverageState, semanticItemId, tokenContains } from "../shared/semanticCoverage.js";
import type {
  DesignModel,
  DesignCoverageEntry,
  DesignConstraintImplementation,
  DesignExceptionImplementation,
} from "../shared/types.js";
import { isDesignModel } from "../shared/types.js";
import { createToolError } from "../tools/types.js";
import { isAbortError } from "../utils/errors.js";
import { BaseGenerator } from "./base.js";
import { setupLogger, type Logger } from "../logger.js";

export { extractSalientAnchors, textIncludesAnchor } from "../shared/salientAnchors.js";

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

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

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
  private readonly logger: Logger = setupLogger("reqdesign.SystemDesigner");

  constructor(llm: LLMClient) {
    super(llm);
    this.promptTemplate = loadPrompt(
      "design_planner.md",
      "请根据以下 DesignBrief 生成系统设计方案：\n\nDesignBrief：\n{requirement_json}\n\n{requirement_text}",
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

    let reqStr = JSON.stringify(buildDesignBrief(requirementJson));
    reqStr = this.sanitizePlaceholder(reqStr, "requirement_json");
    reqStr = this.sanitizePlaceholder(reqStr, "design_text");
    let prompt = this.promptTemplate.replace(/\{requirement_json\}/g, reqStr);
    prompt = prompt.replace(/\{requirement_text\}/g, "");

    const maxAttempts = 3;
    const basePrompt = prompt;
    let bestModel: DesignModel | null = null;
    let bestGapCount = Infinity;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.logger.info(`generateDesign: attempt ${attempt}/${maxAttempts} 开始`);
        const raw = await this.withStreamTag(
          `[Generator:design:attempt-${attempt}]`,
          () => this.generateJsonWithRetry(prompt, systemPrompt ?? "", 1),
        );
        const parsed = SystemDesigner.parseDesignModel(raw);
        if (!parsed) {
          throw createToolError("DESIGN_PARSE_FAILED", "LLM output is not a valid DesignModel (missing required arrays)", { recoverable: true });
        }
        // Deterministically repair dangling class/module/requirement references
        // before gap-checking or self-check. Re-prompting cannot fix these (the
        // LLM fabricates a different bogus class name each round), so doing it
        // here removes the dominant self-check blocker that otherwise sends
        // design into an expensive regenerate→replan cascade. See
        // reconcileDesignModel.
        const model = SystemDesigner.reconcileDesignModel(parsed, requirementJson);
        // coverageMatrix is a derived traceability index, not LLM output: build it
        // from the (reconciled) impl blocks + module mappings. This is what lets
        // the prompt stop asking the LLM for coverageMatrix (~38% less output) and
        // guarantees the index references only real classes/modules.
        model.coverageMatrix = SystemDesigner.buildCoverageMatrix(model, requirementJson);
        const gaps = SystemDesigner.checkCoverageGaps(model, requirementJson);
        if (gaps.length === 0) {
          this.logger.info(`generateDesign: attempt ${attempt}/${maxAttempts} coverage complete`);
          return model;
        }
        this.logger.warn(`generateDesign: attempt ${attempt}/${maxAttempts} coverage gaps=${gaps.length}`);
        if (gaps.length < bestGapCount) {
          bestModel = model;
          bestGapCount = gaps.length;
        }
        if (attempt >= maxAttempts) break;
        prompt = basePrompt + "\n\n" + SystemDesigner.buildCoverageHint(gaps, requirementJson);
      } catch (e) {
        if (isAbortError(e)) throw e;
        lastError = e instanceof Error ? e : new Error(String(e));
        this.logger.warn(`generateDesign: attempt ${attempt}/${maxAttempts} failed: ${lastError.message}`);
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
  ): Array<{ id: string; kind: "function" | "constraint" | "exception"; reason?: string }> {
    const gaps: Array<{ id: string; kind: "function" | "constraint" | "exception"; reason?: string }> = [];

    // Index coverageMatrix entries by refId so we can fetch the designDecision
    // for content-completeness checks (e.g. a constraint listed by refId but
    // with an empty/generic designDecision that omits the source sub-rules).
    const entryByRefId = new Map<string, { designDecision: string }>();
    for (const entry of model.coverageMatrix) {
      const refId = String(entry.refId ?? "").trim();
      if (refId) entryByRefId.set(refId, { designDecision: String(entry.designDecision ?? "") });
    }

    // Index the first-class constraint / exception implementation blocks. This
    // is the new primary content store — coverageMatrix is now allowed to
    // reference these blocks instead of restating the design verbatim.
    const cImplById = new Map<string, typeof model.constraintImplementations[number]>();
    for (const ci of model.constraintImplementations ?? []) {
      const id = String(ci.constraintId ?? "").trim();
      if (id) cImplById.set(id, ci);
    }
    const eImplById = new Map<string, typeof model.exceptionImplementations[number]>();
    for (const ei of model.exceptionImplementations ?? []) {
      const id = String(ei.exceptionId ?? "").trim();
      if (id) eImplById.set(id, ei);
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
        const displayId = String(rec.displayId ?? rec.constraintRef ?? rec.exceptionRef ?? "").trim();
        const id = String(rec.id ?? rec.constraintRef ?? rec.exceptionRef ?? "").trim();
        const reportId = displayId || id;

        // For constraints/exceptions, the PRIMARY check is the first-class
        // implementation block. coverageMatrix is now secondary cross-ref.
        if (kind === "constraint") {
          const impl = cImplById.get(displayId) ?? cImplById.get(id);
          if (!impl) {
            gaps.push({ id: reportId, kind, reason: "no constraintImplementation block" });
            continue;
          }
          const sourceText = sourceTextOf(rec);
          const issues = SystemDesigner._checkConstraintImplementation(impl, sourceText);
          if (issues.length > 0) {
            gaps.push({ id: reportId, kind, reason: issues.join("; ") });
          }
          continue;
        }
        if (kind === "exception") {
          const impl = eImplById.get(displayId) ?? eImplById.get(id);
          if (!impl) {
            gaps.push({ id: reportId, kind, reason: "no exceptionImplementation block" });
            continue;
          }
          const sourceText = sourceTextOf(rec);
          const issues = SystemDesigner._checkExceptionImplementation(impl, sourceText);
          if (issues.length > 0) {
            gaps.push({ id: reportId, kind, reason: issues.join("; ") });
          }
          continue;
        }

        // Functions still gate via coverageMatrix (no first-class block).
        const matchedEntry = entryByRefId.get(displayId) ?? entryByRefId.get(id);
        if (!matchedEntry) {
          gaps.push({ id: reportId, kind, reason: "missing in coverageMatrix" });
          continue;
        }
      }
    };

    checkList(requirementJson.functions, "function");
    checkList(requirementJson.constraints, "constraint");
    checkList(requirementJson.exceptions, "exception");

    return gaps;
  }

  /**
   * Verify a single constraint implementation block against the analysis
   * source_text. The block fails (returning a non-empty reason list) when:
   *
   *   1. `implementationMechanism` is too thin (≤ 20 chars) — a one-line
   *      stub can't credibly implement a multi-parameter rule.
   *   2. Any parameter declared in `parametersPreserved` does not appear
   *      verbatim somewhere in mechanism+handling+trigger — a self-broken
   *      contract: the LLM said "I preserved these" but didn't.
   *   3. Any auto-extracted "salient parameter" from sourceTextVerbatim
   *      (numeric+unit tokens like `256-bit`, algorithm names like `AES`,
   *      file extensions like `.kdb`, "single instance" / "no length limit"
   *      key phrases) is missing from mechanism+handling+trigger.
   *
   * #3 is the deterministic anchor: even if the LLM lies in
   * parametersPreserved, the actual source_text is the ground truth.
   */
  private static _checkConstraintImplementation(
    impl: { implementationMechanism: string; handling: string; trigger: string; parametersPreserved: string[]; sourceTextVerbatim: string },
    analysisSourceText: string,
  ): string[] {
    const issues: string[] = [];
    const mechanism = String(impl.implementationMechanism ?? "").trim();
    const handling = String(impl.handling ?? "").trim();
    const trigger = String(impl.trigger ?? "").trim();
    const haystack = `${mechanism}\n${handling}\n${trigger}`;

    if (mechanism.length <= 20) {
      issues.push("implementationMechanism too thin (≤20 chars)");
    }

    // (2) Self-declared parameters must actually appear.
    for (const p of impl.parametersPreserved ?? []) {
      const param = String(p ?? "").trim();
      if (!param) continue;
      if (!textIncludesAnchor(haystack, param)) {
        issues.push(`parametersPreserved '${param}' missing from mechanism/handling`);
      }
    }

    // (3) Auto-extracted anchors from the source text are the ground truth.
    // Prefer sourceTextVerbatim (closest to what the design must reproduce);
    // fall back to the analysis source_text only when verbatim is missing.
    const anchorSource = impl.sourceTextVerbatim?.trim() || analysisSourceText;
    if (anchorSource && anchorSource.length > 10) {
      const anchors = extractSalientAnchors(anchorSource);
      const missing = anchors.filter((a) => !textIncludesAnchor(haystack, a));
      if (missing.length > 0) {
        issues.push(`source anchors missing in mechanism/handling: ${missing.join(", ")}`);
      }
    }

    return issues;
  }

  /**
   * Verify a single exception implementation. Lighter than the constraint
   * check (exceptions usually don't carry numeric parameters) but still
   * enforces (a) a non-trivial trigger+handling and (b) any auto-extracted
   * anchors from sourceTextVerbatim.
   */
  private static _checkExceptionImplementation(
    impl: { trigger: string; handling: string; parametersPreserved: string[]; sourceTextVerbatim: string },
    analysisSourceText: string,
  ): string[] {
    const issues: string[] = [];
    const trigger = String(impl.trigger ?? "").trim();
    const handling = String(impl.handling ?? "").trim();
    const haystack = `${trigger}\n${handling}`;

    if (trigger.length === 0) issues.push("exception trigger is empty");
    if (handling.length <= 10) issues.push("exception handling too thin (≤10 chars)");

    for (const p of impl.parametersPreserved ?? []) {
      const param = String(p ?? "").trim();
      if (!param) continue;
      if (!textIncludesAnchor(haystack, param)) {
        issues.push(`parametersPreserved '${param}' missing`);
      }
    }

    const anchorSource = impl.sourceTextVerbatim?.trim() || analysisSourceText;
    if (anchorSource && anchorSource.length > 10) {
      const anchors = extractSalientAnchors(anchorSource);
      const missing = anchors.filter((a) => !textIncludesAnchor(haystack, a));
      if (missing.length > 0) {
        issues.push(`source anchors missing: ${missing.join(", ")}`);
      }
    }

    return issues;
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
        if (String(rec.displayId ?? rec.constraintRef ?? rec.exceptionRef ?? "").trim() === id || String(rec.id ?? rec.constraintRef ?? rec.exceptionRef ?? "").trim() === id) {
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

  private static _cellSafe(text: string): string {
    return String(text ?? "").replace(/\|/g, "\\|");
  }

  static renderDesignMarkdown(model: DesignModel): string {
    const lines: string[] = [];
    const s = SystemDesigner._cellSafe;

    // Render the first-class constraint implementations FIRST. The judge reads
    // verbatim evidence for each gold obligation and most obligations are
    // constraints — putting these blocks at the top of the doc maximizes the
    // chance a parameter-bearing rule is found before the truncation window
    // closes. Each block is self-contained: sourceText (verbatim), mechanism
    // (must contain all preserved parameters), trigger, handling.
    if (model.constraintImplementations && model.constraintImplementations.length > 0) {
      lines.push("## 约束实现\n");
      for (const ci of model.constraintImplementations) {
        lines.push(`### ${s(ci.constraintId)} 约束实现\n`);
        if (ci.sourceTextVerbatim) {
          lines.push(`- **需求原文（verbatim）**: ${s(ci.sourceTextVerbatim)}`);
        }
        if (ci.implementationMechanism) {
          lines.push(`- **实现机制**: ${s(ci.implementationMechanism)}`);
        }
        if (ci.parametersPreserved && ci.parametersPreserved.length > 0) {
          lines.push(`- **保留参数（必须 verbatim 出现在实现里）**: ${ci.parametersPreserved.map(s).join(", ")}`);
        }
        if (ci.trigger) lines.push(`- **触发条件**: ${s(ci.trigger)}`);
        if (ci.handling) lines.push(`- **处理行为**: ${s(ci.handling)}`);
        if (ci.affectedModuleIds && ci.affectedModuleIds.length > 0) {
          lines.push(`- **影响模块**: ${s(ci.affectedModuleIds.join(", "))}`);
        }
        if (ci.affectedClassNames && ci.affectedClassNames.length > 0) {
          lines.push(`- **影响类**: ${s(ci.affectedClassNames.join(", "))}`);
        }
        lines.push("");
      }
    }

    if (model.exceptionImplementations && model.exceptionImplementations.length > 0) {
      lines.push("## 异常实现\n");
      for (const ei of model.exceptionImplementations) {
        lines.push(`### ${s(ei.exceptionId)} 异常实现\n`);
        if (ei.sourceTextVerbatim) {
          lines.push(`- **需求原文（verbatim）**: ${s(ei.sourceTextVerbatim)}`);
        }
        if (ei.trigger) lines.push(`- **触发条件**: ${s(ei.trigger)}`);
        if (ei.handling) lines.push(`- **处理行为**: ${s(ei.handling)}`);
        if (ei.parametersPreserved && ei.parametersPreserved.length > 0) {
          lines.push(`- **保留参数（必须 verbatim 出现在处理里）**: ${ei.parametersPreserved.map(s).join(", ")}`);
        }
        if (ei.affectedModuleIds && ei.affectedModuleIds.length > 0) {
          lines.push(`- **影响模块**: ${s(ei.affectedModuleIds.join(", "))}`);
        }
        if (ei.affectedClassNames && ei.affectedClassNames.length > 0) {
          lines.push(`- **影响类**: ${s(ei.affectedClassNames.join(", "))}`);
        }
        lines.push("");
      }
    }

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
      if (flow.relatedFunctionIds?.length) {
        lines.push(`相关功能: ${s(flow.relatedFunctionIds.join(", "))}`);
      }
      flow.steps?.forEach((step, i) => lines.push(`${i + 1}. ${s(step)}`));
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

  private static _normIdent(s: string): string {
    return String(s ?? "").toLowerCase().replace(/[_\-\s]/g, "");
  }

  /**
   * Build the coverageMatrix DETERMINISTICALLY from the requirement analysis +
   * the LLM-produced design content (modules / constraintImplementations /
   * exceptionImplementations).
   *
   * coverageMatrix is a traceability INDEX, not a design decision — the schema
   * always treated it as a "secondary cross-reference index". Deriving it here
   * instead of asking the LLM to emit it:
   *   - cuts ~38% of design LLM output (it was the single largest output block),
   *   - removes the dominant source of class-name fabrication (every
   *     affectedClassName now comes from a real impl block / module mapping, so
   *     it can never reference an undefined class), and
   *   - guarantees the index stays consistent with the actual design.
   *
   * One row per requirement item that is ACTUALLY covered:
   *   - function mapped to ≥1 module → row (affectedModuleIds = those modules)
   *   - constraint with a constraintImplementation block → row (refs from block)
   *   - exception with an exceptionImplementation block → row (refs from block)
   * Uncovered items get NO row, so {@link checkCoverageGaps} still flags them and
   * the generation loop re-prompts — coverage is enforced at the source content
   * (module mapping + impl blocks), not at the derived index.
   */
  static buildCoverageMatrix(
    model: DesignModel,
    requirementJson: Record<string, unknown>,
  ): DesignCoverageEntry[] {
    const rows: DesignCoverageEntry[] = [];
    const asArray = (v: unknown): Record<string, unknown>[] =>
      Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : [];
    const descOf = (rec: Record<string, unknown>): string =>
      String(rec.description ?? rec.source_text ?? rec.sourceText ?? rec.name ?? "").trim();
    const idsOf = (rec: Record<string, unknown>): { refId: string; dId: string; cId: string } => {
      const dId = String(rec.displayId ?? rec.constraintRef ?? rec.exceptionRef ?? "").trim();
      const cId = String(rec.id ?? rec.constraintRef ?? rec.exceptionRef ?? "").trim();
      return { refId: dId || cId, dId, cId };
    };

    // Functions: covered iff mapped into some module's functionIds (by either id form).
    for (const fn of asArray(requirementJson.functions)) {
      const { refId, dId, cId } = idsOf(fn);
      if (!refId) continue;
      const mods = (model.modules ?? [])
        .filter((m) =>
          (m.functionIds ?? []).some((f) => {
            const s = String(f ?? "").trim();
            return s !== "" && (s === dId || s === cId);
          }),
        )
        .map((m) => String(m.id ?? "").trim())
        .filter(Boolean);
      if (mods.length === 0) continue;
      rows.push({
        refId,
        refKind: "function",
        originalDescription: descOf(fn),
        designDecision: `实现于模块 ${mods.join(", ")}`,
        affectedModuleIds: mods,
        affectedClassNames: [],
        testImplication: "",
      });
    }

    // Constraints: covered iff a constraintImplementation block exists.
    const ciById = new Map<string, DesignConstraintImplementation>();
    for (const ci of model.constraintImplementations ?? []) {
      const id = String(ci.constraintId ?? "").trim();
      if (id) ciById.set(id, ci);
    }
    for (const c of asArray(requirementJson.constraints)) {
      const { refId, dId, cId } = idsOf(c);
      if (!refId) continue;
      const ci = ciById.get(dId) ?? ciById.get(cId);
      if (!ci) continue;
      rows.push({
        refId,
        refKind: "constraint",
        originalDescription: descOf(c),
        designDecision: `见 constraintImplementations[${refId}]`,
        affectedModuleIds: [...(ci.affectedModuleIds ?? [])],
        affectedClassNames: [...(ci.affectedClassNames ?? [])],
        testImplication: "",
      });
    }

    // Exceptions: covered iff an exceptionImplementation block exists.
    const eiById = new Map<string, DesignExceptionImplementation>();
    for (const ei of model.exceptionImplementations ?? []) {
      const id = String(ei.exceptionId ?? "").trim();
      if (id) eiById.set(id, ei);
    }
    for (const e of asArray(requirementJson.exceptions)) {
      const { refId, dId, cId } = idsOf(e);
      if (!refId) continue;
      const ei = eiById.get(dId) ?? eiById.get(cId);
      if (!ei) continue;
      rows.push({
        refId,
        refKind: "exception",
        originalDescription: descOf(e),
        designDecision: `见 exceptionImplementations[${refId}]`,
        affectedModuleIds: [...(ei.affectedModuleIds ?? [])],
        affectedClassNames: [...(ei.affectedClassNames ?? [])],
        testImplication: "",
      });
    }

    return rows;
  }

  /**
   * Deterministically repair dangling cross-references in a freshly generated
   * DesignModel — the data-integrity violations that `validateDesignModel`
   * flags but that the LLM cannot reliably fix by re-prompting. On the hospital
   * benchmark case the model referenced classes it never defined
   * (`coverageMatrix[F001] 引用了未定义的类 PrescriptionApprovalService`), and
   * every regeneration fabricated a *different* bogus name, so the self-check
   * never converged and the orchestrator burned its whole runtime budget on
   * regenerate→replan while producing nothing.
   *
   * Three always-correct fixes, using only the model's own data:
   *   1. `affectedClassNames` referencing an undefined class → remap to a
   *      defined class by normalized name, else PROMOTE the name into
   *      `supplementaryClasses` so the reference resolves. Promotion preserves
   *      the design's intent (the LLM meant a real implementing class, it just
   *      forgot to define it) and keeps the constraint→class traceability link,
   *      which dropping the reference would sever.
   *   2. `affectedModuleIds` referencing an undefined module → drop (a module id
   *      is a structural key the design must define for itself; there is no
   *      safe place to promote it to).
   *   3. `module.functionIds` referencing a non-existent requirement id → drop
   *      (a module cannot cover a function the requirements do not contain).
   *
   * Returns a deep clone; the input is never mutated (callers may share it,
   * e.g. test fixtures, and `parseDesignModel` does not clone its input).
   */
  static reconcileDesignModel(
    model: DesignModel,
    requirementJson: Record<string, unknown>,
  ): DesignModel {
    const m: DesignModel = JSON.parse(JSON.stringify(model));
    const requirementIndex = RequirementIndex.fromRequirementJson(requirementJson);

    const moduleIds = new Set(
      m.modules.map((mod) => String(mod.id ?? "").trim()).filter(Boolean),
    );
    const definedClasses = [
      ...m.classes.map((c) => String(c.name ?? "").trim()),
      ...(m.supplementaryClasses ?? []).map((c) => String(c.name ?? "").trim()),
    ].filter(Boolean);
    const definedClassSet = new Set(definedClasses);
    const normToCanonical = new Map<string, string>();
    for (const name of definedClasses) {
      const norm = SystemDesigner._normIdent(name);
      if (!normToCanonical.has(norm)) normToCanonical.set(norm, name);
    }

    const promote = new Map<string, string>(); // class name -> justification
    const dedup = (xs: string[]): string[] => [...new Set(xs)];

    const fixClassNames = (names: string[] | undefined, context: string): string[] => {
      if (!Array.isArray(names)) return [];
      const out: string[] = [];
      for (const raw of names) {
        const name = String(raw ?? "").trim();
        if (!name) continue;
        if (definedClassSet.has(name)) {
          out.push(name);
          continue;
        }
        const canonical = normToCanonical.get(SystemDesigner._normIdent(name));
        if (canonical) {
          out.push(canonical);
          continue;
        }
        out.push(name);
        if (!promote.has(name)) {
          promote.set(name, `自动补充：在 ${context} 中被引用但未在核心类表中定义`);
        }
      }
      return dedup(out);
    };
    const fixModuleIds = (ids: string[] | undefined): string[] => {
      if (!Array.isArray(ids)) return [];
      return dedup(
        ids.map((x) => String(x ?? "").trim()).filter((x) => x !== "" && moduleIds.has(x)),
      );
    };

    // coverageMatrix is derived (buildCoverageMatrix), not LLM-authored, so it is
    // not reconciled here — only the LLM-authored impl blocks need dangling-ref repair.
    for (const ci of m.constraintImplementations ?? []) {
      ci.affectedClassNames = fixClassNames(ci.affectedClassNames, `constraintImplementations[${ci.constraintId}]`);
      ci.affectedModuleIds = fixModuleIds(ci.affectedModuleIds);
    }
    for (const ei of m.exceptionImplementations ?? []) {
      ei.affectedClassNames = fixClassNames(ei.affectedClassNames, `exceptionImplementations[${ei.exceptionId}]`);
      ei.affectedModuleIds = fixModuleIds(ei.affectedModuleIds);
    }

    for (const mod of m.modules) {
      if (!Array.isArray(mod.functionIds)) {
        mod.functionIds = [];
        continue;
      }
      mod.functionIds = dedup(
        mod.functionIds
          .map((x) => String(x ?? "").trim())
          .filter((id) => id !== "" && !!requirementIndex.refForId(id)),
      );
    }

    if (promote.size > 0) {
      const supp = m.supplementaryClasses ?? (m.supplementaryClasses = []);
      const existing = new Set(supp.map((sc) => String(sc.name ?? "").trim()));
      for (const [name, justification] of promote) {
        if (!existing.has(name)) supp.push({ name, justification });
      }
    }

    return m;
  }

  static validateDesignModel(model: DesignModel, requirementJson: Record<string, unknown>): string[] {
    const warnings: string[] = [];

    if (!model.modules || model.modules.length === 0) warnings.push("DesignModel 缺少 modules");
    if (!model.classes || model.classes.length === 0) warnings.push("DesignModel 缺少 classes");
    if (!model.dataFlows || model.dataFlows.length === 0) warnings.push("DesignModel 缺少 dataFlows");
    if (!model.coverageMatrix || model.coverageMatrix.length === 0) warnings.push("DesignModel 缺少 coverageMatrix");

    const requirementIndex = RequirementIndex.fromRequirementJson(requirementJson);
    const moduleIds = new Set(model.modules.map((m) => String(m.id ?? "").trim()).filter(Boolean));
    const classNames = new Set([
      ...model.classes.map((cls) => String(cls.name ?? "").trim()).filter(Boolean),
      ...(model.supplementaryClasses ?? []).map((cls) => String(cls.name ?? "").trim()).filter(Boolean),
    ]);
    const entityNames = new Set(asRecords(requirementJson.entities)
      .map((entity) => String(entity.name ?? entity.canonicalName ?? "").trim())
      .filter(Boolean));

    const validateRequirementRef = (id: string, kind: "function" | "constraint" | "exception", context: string) => {
      const refId = String(id ?? "").trim();
      if (!refId) return;
      const ref = requirementIndex.refForId(refId);
      if (ref) {
        if (ref.kind !== kind) {
          warnings.push(`${context} 引用了错误类型的需求 ID ${refId}，期望 ${kind}`);
        }
        if (refId === ref.canonicalId && ref.displayId !== ref.canonicalId) {
          warnings.push(`${context} 使用了内部 ID ${refId}，应使用 display ID ${ref.displayId}`);
        }
        return;
      }
      if (/\b(?:F\d{3,4}|C\d{3,4}|[EX]\d{3,4}|FUN_[A-Za-z0-9_]+|CON_[A-Za-z0-9_]+|EXC_[A-Za-z0-9_]+)\b/.test(refId)) {
        warnings.push(`${context} 引用了未定义的需求 ID ${refId}`);
      }
    };

    const validateDesignRefs = (moduleRefs: string[], classRefs: string[], context: string) => {
      for (const moduleId of moduleRefs) {
        if (moduleId && !moduleIds.has(moduleId)) {
          warnings.push(`${context} 引用了未定义的模块 ${moduleId}`);
        }
      }
      for (const className of classRefs) {
        if (className && !classNames.has(className)) {
          warnings.push(`${context} 引用了未定义的类 ${className}`);
        }
      }
    };

    const coveredFunctionIds = new Set<string>(model.modules.flatMap((m) => m.functionIds));
    const functions = Array.isArray(requirementJson.functions)
      ? (requirementJson.functions as Record<string, unknown>[])
      : [];
    for (const mod of model.modules) {
      for (const functionId of mod.functionIds ?? []) {
        validateRequirementRef(functionId, "function", `模块 ${mod.id}.functionIds`);
      }
    }
    for (const fn of functions) {
      const id = String(fn.id ?? "");
      const displayId = String(fn.displayId ?? "");
      if ((id || displayId) && !coveredFunctionIds.has(id) && !coveredFunctionIds.has(displayId)) {
        warnings.push(`功能 ${displayId || id} 未映射到任何模块的 functionIds`);
      }
    }

    const coveredRefIds = new Set<string>(model.coverageMatrix.map((e) => e.refId));
    for (const entry of model.coverageMatrix) {
      validateRequirementRef(entry.refId, entry.refKind, `coverageMatrix[${entry.refId}]`);
      validateDesignRefs(entry.affectedModuleIds ?? [], entry.affectedClassNames ?? [], `coverageMatrix[${entry.refId}]`);
    }

    const constraints = Array.isArray(requirementJson.constraints)
      ? (requirementJson.constraints as Record<string, unknown>[])
      : [];
    for (const ci of model.constraintImplementations ?? []) {
      validateRequirementRef(ci.constraintId, "constraint", `constraintImplementations[${ci.constraintId}]`);
      validateDesignRefs(ci.affectedModuleIds ?? [], ci.affectedClassNames ?? [], `constraintImplementations[${ci.constraintId}]`);
    }
    for (const c of constraints) {
      const displayId = String(c.displayId ?? c.constraintRef ?? "");
      const canonId = String(c.id ?? c.constraintRef ?? "");
      const label = displayId || canonId;
      if (label && !coveredRefIds.has(displayId) && !coveredRefIds.has(canonId)) {
        warnings.push(`约束 ${label} 未在 coverageMatrix 中体现`);
      }
    }
    const exceptions = Array.isArray(requirementJson.exceptions)
      ? (requirementJson.exceptions as Record<string, unknown>[])
      : [];
    for (const ei of model.exceptionImplementations ?? []) {
      validateRequirementRef(ei.exceptionId, "exception", `exceptionImplementations[${ei.exceptionId}]`);
      validateDesignRefs(ei.affectedModuleIds ?? [], ei.affectedClassNames ?? [], `exceptionImplementations[${ei.exceptionId}]`);
    }
    for (const e of exceptions) {
      const displayId = String(e.displayId ?? e.exceptionRef ?? "");
      const canonId = String(e.id ?? e.exceptionRef ?? "");
      const label = displayId || canonId;
      if (label && !coveredRefIds.has(displayId) && !coveredRefIds.has(canonId)) {
        warnings.push(`异常 ${label} 未在 coverageMatrix 中体现`);
      }
    }

    if (entityNames.size > 0) {
      for (const cls of model.classes) {
        const entityRef = String(cls.entityRef ?? "").trim();
        if (entityRef && !entityNames.has(entityRef)) {
          warnings.push(`类 ${cls.name} 的 entityRef ${entityRef} 不在允许实体清单中`);
        }
      }
    }

    return warnings;
  }

  static parseDesignModel(raw: Record<string, unknown>): DesignModel | null {
    const unwrapped = SystemDesigner._unwrapDesignContent(raw);
    if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) {
      return null;
    }
    const obj = unwrapped as Record<string, unknown>;
    // Normalize the two first-class arrays to [] so older LLM payloads that
    // emit modules/classes/dataFlows/coverageMatrix without the new sections
    // still parse — they'll just fail the design checker downstream (which is
    // the correct failure mode: a design without per-constraint
    // implementation blocks is incomplete, but it should not crash parsing).
    if (!Array.isArray(obj.constraintImplementations)) obj.constraintImplementations = [];
    if (!Array.isArray(obj.exceptionImplementations)) obj.exceptionImplementations = [];
    // coverageMatrix is now DERIVED deterministically (buildCoverageMatrix), not
    // authored by the LLM — default it to [] so older/leaner payloads still parse.
    if (!Array.isArray(obj.coverageMatrix)) obj.coverageMatrix = [];

    // Coerce entry-level fields so downstream code can rely on the shape.
    obj.constraintImplementations = (obj.constraintImplementations as unknown[])
      .map((item) => SystemDesigner._coerceConstraintImplementation(item))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    obj.exceptionImplementations = (obj.exceptionImplementations as unknown[])
      .map((item) => SystemDesigner._coerceExceptionImplementation(item))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    // Coerce per-flow fields so renderDesignMarkdown (and other downstream
    // readers) can rely on `steps`/`relatedFunctionIds` always being arrays,
    // even when a repaired LLM payload omits them.
    if (Array.isArray(obj.dataFlows)) {
      obj.dataFlows = (obj.dataFlows as unknown[])
        .map((item) => SystemDesigner._coerceDataFlow(item))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    }
    // Normalize `classes` to the canonical DesignClassEntry field names. The
    // LLM — especially on the REPAIR path, whose prompt example can be truncated
    // before the classes section — sometimes emits plausible-but-wrong aliases
    // (className/responsibilities/keyAttributes/keyMethods). Left untouched they
    // pass isDesignModel (array-only check) and render as blank table rows
    // (renderDesignMarkdown reads cls.name/kind/responsibility). Coercing here
    // recovers the data under any alias and drops truly nameless stubs.
    if (Array.isArray(obj.classes)) {
      obj.classes = (obj.classes as unknown[])
        .map((item) => SystemDesigner._coerceClass(item))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    }

    if (!isDesignModel(obj)) return null;
    return obj;
  }

  /**
   * Coerce a raw LLM entry into a DesignConstraintImplementation. Returns null
   * when the entry has no usable id (which would orphan it from the analysis
   * constraint list — better to drop than fake-anchor).
   */
  private static _coerceConstraintImplementation(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const r = value as Record<string, unknown>;
    const constraintId = String(r.constraintId ?? r.refId ?? "").trim();
    if (!constraintId) return null;
    return {
      constraintId,
      sourceTextVerbatim: String(r.sourceTextVerbatim ?? r.sourceText ?? "").trim(),
      implementationMechanism: String(r.implementationMechanism ?? r.mechanism ?? "").trim(),
      parametersPreserved: Array.isArray(r.parametersPreserved)
        ? r.parametersPreserved.map((p) => String(p ?? "").trim()).filter(Boolean)
        : [],
      trigger: String(r.trigger ?? "").trim(),
      handling: String(r.handling ?? "").trim(),
      affectedModuleIds: Array.isArray(r.affectedModuleIds)
        ? r.affectedModuleIds.map((p) => String(p ?? "").trim()).filter(Boolean)
        : [],
      affectedClassNames: Array.isArray(r.affectedClassNames)
        ? r.affectedClassNames.map((p) => String(p ?? "").trim()).filter(Boolean)
        : [],
    };
  }

  private static _coerceExceptionImplementation(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const r = value as Record<string, unknown>;
    const exceptionId = String(r.exceptionId ?? r.refId ?? "").trim();
    if (!exceptionId) return null;
    return {
      exceptionId,
      sourceTextVerbatim: String(r.sourceTextVerbatim ?? r.sourceText ?? "").trim(),
      trigger: String(r.trigger ?? "").trim(),
      handling: String(r.handling ?? "").trim(),
      parametersPreserved: Array.isArray(r.parametersPreserved)
        ? r.parametersPreserved.map((p) => String(p ?? "").trim()).filter(Boolean)
        : [],
      affectedModuleIds: Array.isArray(r.affectedModuleIds)
        ? r.affectedModuleIds.map((p) => String(p ?? "").trim()).filter(Boolean)
        : [],
      affectedClassNames: Array.isArray(r.affectedClassNames)
        ? r.affectedClassNames.map((p) => String(p ?? "").trim()).filter(Boolean)
        : [],
    };
  }

  /**
   * Coerce a raw LLM data-flow entry into a DesignDataFlow shape. Always
   * returns array-typed `steps`/`relatedFunctionIds` (defaulting to []) so that
   * renderDesignMarkdown and other consumers can safely read those fields even
   * when a repaired payload omits them. Returns null only when the entry is
   * not a usable object.
   */
  private static _coerceDataFlow(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const r = value as Record<string, unknown>;
    return {
      name: String(r.name ?? "").trim(),
      steps: Array.isArray(r.steps)
        ? r.steps.map((p) => String(p ?? "").trim()).filter(Boolean)
        : [],
      relatedFunctionIds: Array.isArray(r.relatedFunctionIds)
        ? r.relatedFunctionIds.map((p) => String(p ?? "").trim()).filter(Boolean)
        : [],
    };
  }

  /**
   * Coerce a raw LLM class entry into the canonical DesignClassEntry shape,
   * accepting the alias field names the LLM (esp. on the repair path) drifts to:
   *   - name        ← name | className | class_name
   *   - kind         ← kind | type            (preserved verbatim; default "domain")
   *   - responsibility ← responsibility | responsibilities (array → joined)
   *   - attributes   ← attributes | keyAttributes
   *   - methods      ← methods | keyMethods
   *   - entityRef    ← entityRef | entity_ref | entity
   * Returns null for a nameless entry (a promoted/garbage stub) so it is dropped
   * rather than rendered as a blank table row.
   */
  private static _coerceClass(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const r = value as Record<string, unknown>;
    const name = String(r.name ?? r.className ?? r.class_name ?? "").trim();
    if (!name) return null;
    // Preserve the LLM's kind verbatim ("domain"/"service"/"helper"/...) — the
    // table just renders the string — and only default when it is truly absent.
    const kind = (String(r.kind ?? r.type ?? "").trim() || "domain") as "domain" | "helper";
    const respRaw = r.responsibility ?? r.responsibilities ?? "";
    const responsibility = Array.isArray(respRaw)
      ? respRaw.map((x) => String(x ?? "").trim()).filter(Boolean).join("；")
      : String(respRaw ?? "").trim();
    const entityRef = String(r.entityRef ?? r.entity_ref ?? r.entity ?? "").trim();
    return {
      name,
      kind,
      responsibility,
      attributes: SystemDesigner._coerceClassAttributes(r.attributes ?? r.keyAttributes),
      methods: SystemDesigner._coerceClassMethods(r.methods ?? r.keyMethods),
      ...(entityRef ? { entityRef } : {}),
    };
  }

  /**
   * Coerce a class attribute list into `[{name, type, description?}]`. Accepts
   * either objects ({name,type,description}) or strings ("userId (String)" /
   * "userId: String" / "userId"), the two forms the LLM uses for keyAttributes.
   */
  private static _coerceClassAttributes(
    value: unknown,
  ): Array<{ name: string; type: string; description?: string }> {
    if (!Array.isArray(value)) return [];
    const out: Array<{ name: string; type: string; description?: string }> = [];
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const r = item as Record<string, unknown>;
        const name = String(r.name ?? "").trim();
        if (!name) continue;
        const desc = r.description != null ? String(r.description).trim() : "";
        out.push({ name, type: String(r.type ?? "").trim(), ...(desc ? { description: desc } : {}) });
      } else if (typeof item === "string") {
        const s = item.trim();
        if (!s) continue;
        const m = s.match(/^(.+?)\s*[（(]\s*(.+?)\s*[）)]\s*$/) ?? s.match(/^(.+?)\s*[:：]\s*(.+?)\s*$/);
        if (m) out.push({ name: m[1].trim(), type: m[2].trim() });
        else out.push({ name: s, type: "" });
      }
    }
    return out;
  }

  /** Coerce a class method list into `string[]`, accepting strings or `{name}`. */
  private static _coerceClassMethods(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((m) => {
        if (typeof m === "string") return m.trim();
        if (m && typeof m === "object" && !Array.isArray(m)) {
          const r = m as Record<string, unknown>;
          return String(r.name ?? r.signature ?? "").trim();
        }
        return "";
      })
      .filter(Boolean);
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

