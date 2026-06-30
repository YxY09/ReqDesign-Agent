/**
 * RepairTool — 接收 EvaluationTool 的结构化评审问题 → 生成修复后的产物。
 * 使用专用的 repair.md prompt。异步 LLM 调用。
 */

import type { LLMClient } from "../llmClient.js";
import { SystemDesigner } from "../generators/design.js";
import { TestCaseGenerator } from "../generators/tests.js";
import { BaseTool } from "./base.js";
import type { ToolCapabilities } from "./types.js";
import { isDesignModel, type Task, type DesignModel } from "../shared/types.js";
import { isRecord } from "../utils/isRecord.js";
import { isTemplateLike, validateTestCases as validateTestCaseQuality } from "../generators/testQualityValidator.js";
import { isRelationLine } from "../shared/mermaidRelations.js";
import { extractDesignClassDefinitions } from "../shared/designClassExtractor.js";
import { DomainModelGenerator } from "../generators/domainModel.js";

export class RepairTool extends BaseTool {
  constructor(llm: LLMClient) {
    super(llm);
  }

  get name(): string { return "RepairTool"; }

  get capabilities(): ToolCapabilities {
    return { requiresLlm: true, supportedTaskTypes: ["repair"] };
  }

  async repair(
    task: Task,
    currentContent: unknown,
    fixInstructions: Array<Record<string, unknown>>,
    context: Record<string, unknown>,
  ): Promise<unknown | null> {
    this.logger.info(`repair: 开始修复 task=${task.id}, type=${task.type}，修复指令=${fixInstructions.length}条`);

    // 步骤 1：尝试基于规则的确定性修复
    const detResult = this._tryDeterministicFix(task, currentContent, fixInstructions, context);
    if (detResult !== null) {
      this.logger.info(`repair: task=${task.id} 确定性修复成功，跳过LLM调用`);
      return detResult;
    }

    // 步骤 2：对于其他情况，使用 LLM 修复
    const system = await this._loadRepairPrompt(task);
    const userPrompt = this._buildRepairPrompt(task, currentContent, fixInstructions, context);

    let content: unknown = null;
    try {
      if (task.type === "analyze") {
        // analyze: full rewrite for structured JSON data.
        const response = await this.llm.generateJson(userPrompt, system);
        content = this._parseResponse(response as Record<string, unknown>, task);
      } else if (task.type === "design") {
        // design: keep the structured DesignModel contract end-to-end.
        const response = await this.llm.generateJson(userPrompt, system);
        content = this._parseDesignRepairResponse(response as Record<string, unknown>, task);
      } else {
        // diagrams/tests: direct full-artifact replacement.
        const text = await this.llm.generateText(userPrompt, system);
        content = this._applyFullRepairResponse(task, currentContent, text);
      }
    } catch (e) {
      this.logger.error(`repair: task=${task.id} 修复失败: ${e instanceof Error ? e.message : String(e)}`);
      content = null;
    }

    if (content != null && task.type === "design") {
      content = this._normalizeStructuredDesignRepair(content, context);
    }

    // Design-fidelity gate (FIX 2): a repaired design that REGRESSES on
    // coverage (drops a previously-referenced domain concept D-ID, drops a
    // previously-covered function F###, or leaves a module with an empty
    // name/responsibility after coercion) is REJECTED and the pre-repair
    // (better) design is kept. This AUGMENTS the size heuristic below (kept
    // as a final truncation guard). General/set-based: works on IDs and
    // field-population, never on hardcoded names.
    if (
      content != null &&
      task.type === "design" &&
      isDesignModel(currentContent)
    ) {
      const postModel = isDesignModel(content) ? content : null;
      const preModel = this._normalizeStructuredDesignRepair(currentContent, context);
      if (postModel && isDesignModel(preModel)) {
        const gate = RepairTool._designFidelityGate(postModel, preModel);
        if (!gate.accept) {
          this.logger.warn(
            `repair: task=${task.id} design fidelity gate rejected repair (keeping pre-repair): ${gate.reasons.join("; ")}`,
          );
          content = preModel;
        }
      }
    }

    if (content != null && task.type === "tests") {
      content = this._mergeTestRepairWithCurrent(task, currentContent, content);
      content = this._normalizeAndValidateTestRepair(task, content, context);
      if (content != null) {
        content = this._rejectTemplateLikeRepair(task, content);
      }
    }

    // 保护机制：如果输出小于原始内容的 50%，则丢弃
    if (content != null && currentContent != null) {
      const origStr = task.type === "diagrams" ? JSON.stringify(currentContent) : String(currentContent);
      const newStr = task.type === "diagrams" ? JSON.stringify(content) : String(content);
      if (origStr.length > 0 && newStr.length < origStr.length * 0.5) {
        this.logger.warn(`repair: 修复结果过短（${newStr.length} < ${Math.round(origStr.length * 0.5)}），丢弃`);
        content = null;
      }
    }

    if (content != null) {
      this.logger.info(`repair: task=${task.id} 修复成功`);
    } else {
      this.logger.warn(`repair: task=${task.id} 修复返回空结果`);
    }
    return content;
  }

  private _mergeTestRepairWithCurrent(
    task: Task,
    currentContent: unknown,
    repairedContent: unknown,
  ): unknown {
    const currentCases = TestCaseGenerator.parseStructuredTestCases(
      RepairTool._contentToText(currentContent),
    );
    const repairedCases = TestCaseGenerator.parseStructuredTestCases(
      RepairTool._contentToText(repairedContent),
    );
    if (!currentCases || currentCases.length === 0 || !repairedCases) {
      return repairedContent;
    }
    if (repairedCases.length === 0) {
      return repairedContent;
    }

    const mergeResult = TestCaseGenerator.mergeStructuredTestCaseRecords(
      currentCases,
      repairedCases,
    );

    this.logger.info(
      `repair: task=${task.id} merged test repair with current content (kept=${currentCases.length - mergeResult.replaced}, replaced=${mergeResult.replaced}, added=${mergeResult.added})`,
    );
    return JSON.stringify({ test_cases: mergeResult.cases }, null, 2);
  }

  private _normalizeAndValidateTestRepair(
    task: Task,
    content: unknown,
    context: Record<string, unknown>,
  ): unknown | null {
    const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    const requirementJson = isRecord(context.requirement_json)
      ? context.requirement_json
      : undefined;
    let normalized = TestCaseGenerator.normalizeStructuredTestCases(text, requirementJson)
      ?? TestCaseGenerator.normalizeStructuredTestCaseIds(text);
    if (normalized === null) {
      return content;
    }

    if (normalized !== text) {
      this.logger.info(`repair: task=${task.id} 已规范化结构化测试用例编号`);
    }

    if (!requirementJson) {
      return normalized;
    }

    let parsedCases = TestCaseGenerator.parseStructuredTestCases(normalized);
    const warnings = TestCaseGenerator.validateTestCases(normalized, requirementJson);
    const structuralWarnings = warnings.filter((warning) =>
      warning.includes("编号不合法") ||
      warning.includes("编号重复") ||
      warning.includes("缺少字段") ||
      warning.includes("type 必须") ||
      warning.includes("priority 必须") ||
      warning.includes("steps 必须") ||
      warning.includes("test_cases 数组为空"),
    );
    if (structuralWarnings.length > 0) {
      this.logger.warn(
        `repair: task=${task.id} 修复后的测试结构仍不合法: ${structuralWarnings.join("; ")}`,
      );
      const sanitized = parsedCases
        ? this._dropStructurallyInvalidTests(task, parsedCases)
        : null;
      if (sanitized === null) {
        return null;
      }
      normalized = TestCaseGenerator.normalizeStructuredTestCases(sanitized, requirementJson) ?? sanitized;
      parsedCases = TestCaseGenerator.parseStructuredTestCases(normalized);
    }

    if (parsedCases) {
      const qualityIssues = validateTestCaseQuality(parsedCases, requirementJson);
      const fatalIssues = qualityIssues.filter((issue) =>
        issue.severity === "reject" && issue.issue !== "target_content_alignment",
      );
      if (fatalIssues.length > 0) {
        this.logger.warn(
          `repair: task=${task.id} 修复后的测试质量仍不合法: ${fatalIssues.map((issue) => issue.detail).join("; ")}`,
        );
        const rejectedIds = new Set(
          fatalIssues
            .map((issue) => issue.testId)
            .map((id) => String(id ?? "").trim())
            .filter((id) => id && id !== "unknown"),
        );
        if (rejectedIds.size > 0) {
          const kept = parsedCases.filter((tc) => !rejectedIds.has(String(tc.id ?? "").trim()));
          if (kept.length > 0 && kept.length < parsedCases.length) {
            this.logger.warn(
              `repair: task=${task.id} 移除 ${parsedCases.length - kept.length} 条仍不合格测试，保留 ${kept.length} 条可用测试`,
            );
            const sanitized = JSON.stringify({ test_cases: kept }, null, 2);
            return TestCaseGenerator.normalizeStructuredTestCases(sanitized, requirementJson) ?? sanitized;
          }
        }
        return null;
      }
    }

    return normalized;
  }

  private _dropStructurallyInvalidTests(
    task: Task,
    cases: Array<Record<string, unknown>>,
  ): string | null {
    const seen = new Set<string>();
    const kept: Array<Record<string, unknown>> = [];
    const requiredFields = ["id", "title", "type", "target", "preconditions", "steps", "expected_result", "priority"];
    for (const tc of cases) {
      const id = String(tc.id ?? "").trim();
      const type = String(tc.type ?? "").trim();
      const priority = String(tc.priority ?? "").trim();
      const missingRequired = requiredFields.some((field) => {
        const value = tc[field];
        return value === undefined || value === null || value === "" ||
          (Array.isArray(value) && value.length === 0);
      });
      const invalid =
        missingRequired ||
        !/^TC-[NEB]-\d{3,}$/.test(id) ||
        seen.has(id) ||
        !["正常", "异常", "边界"].includes(type) ||
        !/^P[012]$/.test(priority) ||
        !Array.isArray(tc.steps) ||
        tc.steps.length === 0;
      if (invalid) {
        if (id) seen.add(id);
        continue;
      }
      seen.add(id);
      kept.push(tc);
    }

    if (kept.length === 0 || kept.length === cases.length) {
      return null;
    }
    this.logger.warn(
      `repair: task=${task.id} 移除 ${cases.length - kept.length} 条结构不合法测试，保留 ${kept.length} 条可用测试`,
    );
    return JSON.stringify({ test_cases: kept }, null, 2);
  }

  private _normalizeStructuredDesignRepair(
    content: unknown,
    context: Record<string, unknown>,
  ): unknown | null {
    if (!isDesignModel(content)) return content;

    const requirementJson = isRecord(context.requirement_json)
      ? context.requirement_json
      : {};
    const reconciled = SystemDesigner.reconcileDesignModel(content, requirementJson);
    reconciled.coverageMatrix = SystemDesigner.buildCoverageMatrix(reconciled, requirementJson);
    return reconciled;
  }

  /**
   * Design-fidelity acceptance gate (FIX 2). Compares a post-repair DesignModel
   * against the pre-repair DesignModel and REJECTS the repair when it
   * regresses on coverage. Both inputs are assumed to be already reconciled
   * (reconcileDesignModel + buildCoverageMatrix). All three checks are
   * general/set-based — they operate on IDs and field-population only, never
   * on hardcoded names, so they generalize to any domain.
   *
   *   (a) D-ID retention: the union of `domainRefs` across all domain classes
   *       post-repair must be a superset of the union pre-repair. Dropping a
   *       previously-referenced domain concept (e.g. D010) is a coverage
   *       regression. `domainRefs` is untyped on DesignClassEntry so it is read
   *       defensively with an Array.isArray guard (exactly like
   *       domainModel.ts:201).
   *   (b) Module completeness: after coercion, no module may have an empty
   *       name or responsibility. A blank module row is the corruption symptom
   *       (drifted aliases render as blank cells).
   *   (c) Function retention: the union of `functionIds` across modules
   *       post-repair must cover the union pre-repair. Dropping a previously-
   *       covered F### is a coverage regression.
   *
   * Returns `{ accept: true }` when no regression is detected, otherwise
   * `{ accept: false, reasons }` listing every failed check.
   */
  static _designFidelityGate(
    post: DesignModel,
    pre: DesignModel,
  ): { accept: boolean; reasons: string[] } {
    const reasons: string[] = [];

    // (a) Domain-concept D-ID retention.
    const collectDomainRefs = (model: DesignModel): Set<string> => {
      const ids = new Set<string>();
      for (const cls of model.classes ?? []) {
        const refs = (cls as unknown as Record<string, unknown>).domainRefs;
        if (Array.isArray(refs)) {
          for (const ref of refs) {
            const id = String(ref ?? "").trim();
            if (id) ids.add(id);
          }
        }
      }
      return ids;
    };
    const preDIds = collectDomainRefs(pre);
    const postDIds = collectDomainRefs(post);
    const droppedDIds = [...preDIds].filter((id) => !postDIds.has(id));
    if (droppedDIds.length > 0) {
      reasons.push(`domain concept refs dropped: ${droppedDIds.join(", ")}`);
    }

    // (b) Module completeness (post-repair only, after coercion).
    const blankModules: string[] = [];
    for (const mod of post.modules ?? []) {
      const name = String(mod.name ?? "").trim();
      const responsibility = String(mod.responsibility ?? "").trim();
      if (!name || !responsibility) {
        const id = String(mod.id ?? "").trim() || `(index ${post.modules.indexOf(mod)})`;
        blankModules.push(id);
      }
    }
    if (blankModules.length > 0) {
      reasons.push(`modules with empty name/responsibility: ${blankModules.join(", ")}`);
    }

    // (c) Function retention.
    const collectFunctionIds = (model: DesignModel): Set<string> => {
      const ids = new Set<string>();
      for (const mod of model.modules ?? []) {
        for (const fid of mod.functionIds ?? []) {
          const id = String(fid ?? "").trim();
          if (id) ids.add(id);
        }
      }
      return ids;
    };
    const preFIds = collectFunctionIds(pre);
    const postFIds = collectFunctionIds(post);
    const droppedFIds = [...preFIds].filter((id) => !postFIds.has(id));
    if (droppedFIds.length > 0) {
      reasons.push(`function coverage dropped: ${droppedFIds.join(", ")}`);
    }

    return { accept: reasons.length === 0, reasons };
  }

  /**
   * Post-repair check: reject the repair result if any test cases are still
   * template-like. Returns null to reject, or the original content if acceptable.
   */
  private _rejectTemplateLikeRepair(task: Task, content: unknown): unknown | null {
    // Parse test cases from content
    let tests: Array<Record<string, unknown>> = [];
    try {
      if (typeof content === "string") {
        const clean = content.trim();
        if (clean.startsWith("{")) {
          const doc = JSON.parse(clean);
          if (Array.isArray(doc.test_cases)) {
            tests = doc.test_cases.filter(
              (tc: unknown) => typeof tc === "object" && tc !== null,
            ) as Array<Record<string, unknown>>;
          }
        }
      }
    } catch {
      // Cannot parse; skip check
      return content;
    }

    if (tests.length === 0) return content;

    let templateCount = 0;
    for (const tc of tests) {
      if (isTemplateLike(tc)) {
        templateCount++;
        this.logger.warn(
          `repair: task=${task.id} post-repair test ${String(tc.id ?? "?")} is still template-like`,
        );
      }
    }

    if (templateCount > 0 && templateCount >= tests.length) {
      // All tests are template-like; reject entirely
      this.logger.warn(
        `repair: task=${task.id} all ${templateCount} repaired tests are template-like, rejecting repair`,
      );
      return null;
    }

    // Some tests are template-like but not all; log warning but keep result
    if (templateCount > 0) {
      this.logger.warn(
        `repair: task=${task.id} ${templateCount}/${tests.length} repaired tests are still template-like`,
      );
    }

    return content;
  }

  // ------------------------------------------------------------------
  // 确定性修复（无需 LLM）
  // ------------------------------------------------------------------

  /**
   * 尝试在不调用 LLM 的情况下确定性地修复问题。
   * 如果所有问题都能确定性地修复，则返回修复后的内容；否则返回 null。
   */
  private _tryDeterministicFix(
    task: Task,
    currentContent: unknown,
    fixInstructions: Array<Record<string, unknown>>,
    context: Record<string, unknown>,
  ): unknown | null {
    if (fixInstructions.length === 0) return null;

    // 仅在所有问题都能确定性修复时才尝试确定性修复
    const fixResults: Array<{ fixed: boolean; content: unknown }> = [];
    let workingContent = currentContent;

    for (const issue of fixInstructions) {
      const desc = String(issue.description ?? "");
      const result = this._trySingleDeterministicFix(task, workingContent, issue, desc, context);
      if (result === null) {
        // 这个问题无法确定性修复——中止
        return null;
      }
      workingContent = result;
      fixResults.push({ fixed: true, content: result });
    }

    // 所有问题都已被确定性修复
    return workingContent;
  }

  /**
   * 尝试确定性地修复单个问题。
   * 如果修复成功则返回新内容；否则返回 null。
   */
  private _trySingleDeterministicFix(
    task: Task,
    currentContent: unknown,
    _issue: Record<string, unknown>,
    description: string,
    context: Record<string, unknown>,
  ): unknown | null {
    // 模式 1：实体命名不一致 — "命名不一致: 需求分析中为 'X'，设计中使用了 'Y'"
    const namingMatch = description.match(/命名不一致.*为\s*'([\w]+)'.*使用了\s*'([\w]+)'/);
    if (namingMatch) {
      const [, correctName, wrongName] = namingMatch;
      if (correctName && wrongName && correctName !== wrongName) {
        // FIX 1: refuse to rename an authoritative domain-model concept name.
        // `wrongName` is the name actually used in the class diagram / design.
        // If it is one of the domain model's concept names, that name is
        // authoritative for the artifact and must NOT be overwritten by the
        // analysis entity name — defer to LLM repair (or no-op) instead of
        // corrupting a faithful concept name. GENERAL: any concept name.
        const domainModelJson = context.domain_model_json as
          | Record<string, unknown>
          | undefined;
        const conceptNames = new Set(
          DomainModelGenerator.extractConceptNames(domainModelJson ?? {}),
        );
        if (conceptNames.has(wrongName)) {
          this.logger.info(
            `deterministic: refusing to rename authoritative domain concept '${wrongName}' -> '${correctName}' (concept name preserved)`,
          );
          return null;
        }
        return this._fixNamingMismatch(task, currentContent, correctName, wrongName);
      }
    }

    // 模式 2：类图中缺少实体 — broadened to match diverse LLM issue descriptions
    // Matches patterns like:
    //   - "类图缺少需求分析中的核心实体: X, Y"
    //   - "类图未包含核心业务类 X"
    //   - "缺失设计文本中定义的核心业务类 X 及模块结构"
    //   - "类图中仅包含了 A，缺失了 B"
    if (task.type === "diagrams") {
      let entityNames: string[] = [];

      // Sub-pattern 2a: canonical form
      const canonicalMatch = description.match(/类图缺少需求分析中的核心实体:\s*(.+)/);
      if (canonicalMatch) {
        entityNames = canonicalMatch[1].split(", ").map((s) => s.trim()).filter(Boolean);
      }

      // Sub-pattern 2b: "缺失/未包含核心业务类 X" or "缺失了 X 类"
      if (entityNames.length === 0) {
        const missingClassMatch = description.matchAll(/(?:未包含|缺失了?)(?:核心业务类|核心类)?\s*([A-Z][A-Za-z0-9]*)/g);
        for (const m of missingClassMatch) {
          if (m[1] && !entityNames.includes(m[1])) entityNames.push(m[1]);
        }
      }

      // Sub-pattern 2c: "类图中仅包含/仅有 A，缺失/缺少 B"
      if (entityNames.length === 0) {
        const onlyContainsMatch = description.match(/仅(?:包含|有)\s*[A-Za-z]+.*?(?:缺失|缺少|遗漏)\s*[了]?(?:核心业务类\s*)?([A-Z][A-Za-z0-9]*(?:\s*(?:[,、]|以及)\s*[A-Z][A-Za-z0-9]*)*)/);
        if (onlyContainsMatch) {
          entityNames = onlyContainsMatch[1].split(/\s*(?:[,、]|以及)\s*/).map((s) => s.trim()).filter(Boolean);
        }
      }

      // Sub-pattern 2d: any capitalized class name after "缺失" or "遗漏"
      if (entityNames.length === 0) {
        const genericMissingMatch = description.matchAll(/(?:缺失|遗漏)(?:了?\s*(?:核心\w*\s*)?)([A-Z][A-Za-z0-9]+)/g);
        for (const m of genericMissingMatch) {
          if (m[1] && !entityNames.includes(m[1])) entityNames.push(m[1]);
        }
      }

      // Sub-pattern 2e: "类图关系引用了未定义的类: X, Y" (dangling relationship
      // endpoints emitted by evaluation._checkClassDiagramEntities). Route
      // to the same synthesizer that builds missing classes from entities /
      // design definitions.
      if (entityNames.length === 0) {
        const danglingMatch = description.match(/类图关系引用了未定义的类:\s*(.+)/);
        if (danglingMatch) {
          entityNames = danglingMatch[1]
            .split(/,\s*/)
            .map((s) => s.trim())
            .filter((s) => /^[A-Z][A-Za-z0-9_]*$/.test(s));
        }
      }

      if (entityNames.length > 0) {
        return this._fixMissingClassDiagramEntities(task, currentContent, entityNames, context);
      }
    }

    // 模式 3a：单个约束未被测试覆盖 — "约束 X 未被测试用例覆盖"
    const constraintMatch = description.match(/^约束\s+([A-Za-z0-9_-]+)\s+未被测试用例覆盖$/);
    if (constraintMatch && task.type === "tests") {
      return this._fixMissingConstraintTest(task, currentContent, constraintMatch[1], context);
    }

    // 模式 4：幽灵功能 ID — "功能ID不一致: ...引用了分析中不存在的功能ID: F009, F010"
    const ghostIdMatch = description.match(/功能ID不一致.*不存在的功能ID:\s*([F\d, ]+)/);
    if (ghostIdMatch) {
      const ghostIds = ghostIdMatch[1].split(/,\s*/).filter((s) => /^F\d+$/.test(s.trim()));
      if (ghostIds.length > 0) {
        return this._fixGhostFunctionIds(task, currentContent, ghostIds, context);
      }
    }

    return null;
  }

  private _fixNamingMismatch(
    task: Task,
    currentContent: unknown,
    correctName: string,
    wrongName: string,
  ): unknown | null {
    this.logger.info(`deterministic: fixing naming '${wrongName}' -> '${correctName}'`);

    if (task.type === "diagrams" && typeof currentContent === "object" && currentContent !== null) {
      const obj = currentContent as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === "string") {
          // Replace class name declarations: 'class WrongName {'
          let fixed = val.replace(
            new RegExp(`class ${this._escapeRegex(wrongName)}\\s*\\{`, "g"),
            `class ${correctName} {`,
          );
          // Replace relationship references: 'WrongName "1"'
          fixed = fixed.replace(
            new RegExp(`\\b${this._escapeRegex(wrongName)}\\b`, "g"),
            correctName,
          );
          result[key] = fixed;
        } else {
          result[key] = val;
        }
      }
      return result;
    }

    if (typeof currentContent === "string") {
      // For design/tests: replace word boundaries
      let fixed = currentContent;
      // Replace in bold markers: **WrongName**
      fixed = fixed.replace(
        new RegExp(`\\*\\*${this._escapeRegex(wrongName)}\\*\\*`, "g"),
        `**${correctName}**`,
      );
      // Replace as standalone word
      fixed = fixed.replace(
        new RegExp(`\\b${this._escapeRegex(wrongName)}\\b`, "g"),
        correctName,
      );
      return fixed;
    }

    return null;
  }


  private _fixMissingClassDiagramEntities(
    task: Task,
    currentContent: unknown,
    entityNames: string[],
    context: Record<string, unknown>,
  ): unknown | null {
    if (task.type !== "diagrams" || typeof currentContent !== "object" || currentContent === null) {
      return null;
    }

    const obj = currentContent as Record<string, unknown>;
    const classDiagram = String(obj.class_diagram ?? "");
    if (!classDiagram) return null;

    // Source 1: requirement entities (data entities)
    const reqEntities = (context.requirement_json as Record<string, unknown>)?.entities;
    const entityMap = new Map<string, Record<string, unknown>>();
    if (Array.isArray(reqEntities)) {
      for (const ent of reqEntities) {
        if (typeof ent === "object" && ent !== null) {
          entityMap.set(String((ent as Record<string, unknown>).name ?? "").trim(), ent as Record<string, unknown>);
        }
      }
    }

    // Source 2: design_text core class table (service classes like Calculator, OrderService)
    const designText = String(context.design_text ?? "");
    const designClassMap = extractDesignClassDefinitions(designText);

    const newClasses: string[] = [];
    for (const name of entityNames) {
      // Skip if class already exists in diagram
      if (new RegExp(`class\s+${this._escapeRegex(name)}\s*\{`).test(classDiagram)) continue;

      // Try requirement entity first
      const entity = entityMap.get(name);
      if (entity) {
        const attrs = Array.isArray((entity as Record<string, unknown>)?.attributes)
          ? ((entity as Record<string, unknown>).attributes as Array<Record<string, unknown>>).slice(0, 3).map(
              (a) => `        -String ${(a as Record<string, unknown>).name ?? "id"}`,
            ).join("\n")
          : `        -Long id`;
        newClasses.push(`    class ${name} {\n${attrs}\n    }`);
        continue;
      }

      // Try design text definition
      const designDef = designClassMap.get(name);
      if (designDef) {
        newClasses.push(designDef);
        continue;
      }

      // Not found in either source — cannot generate a meaningful class
      this.logger.info(`deterministic: class '${name}' not found in entities or design_text, cannot fix`);
      return null; // let LLM repair + safety net handle it
    }

    if (newClasses.length === 0) {
      return null;
    }

    // Insert before the first relationship line. The broadened pattern
    // covers associations (-->), inheritance (<|-- / --|>), composition
    // (*--), aggregation (o--) and dependency (..>), so newly-added
    // dangling-association classes land before their first reference.
    const lines = classDiagram.split("\n");
    const firstRelIdx = lines.findIndex((l) => isRelationLine(l));
    if (firstRelIdx === -1) {
      const fixed = classDiagram + "\n" + newClasses.join("\n");
      return { ...obj, class_diagram: fixed };
    }
    lines.splice(firstRelIdx, 0, ...newClasses);
    this.logger.info(`deterministic: added ${newClasses.length} class(es) to class_diagram`);
    return { ...obj, class_diagram: lines.join("\n") };
  }

  /**
   * 从设计/测试内容中移除幽灵功能 ID。
   * 策略：用分析结果中最接近的有效 ID 替换幽灵 Fxxx，或者移除该引用。
   */
  private _fixGhostFunctionIds(
    task: Task,
    currentContent: unknown,
    ghostIds: string[],
    context: Record<string, unknown>,
  ): unknown | null {
    // Get analysis function IDs for fallback
    const reqJson = context.requirement_json as Record<string, unknown> | undefined;
    const functions = Array.isArray(reqJson?.functions)
      ? (reqJson!.functions as Array<Record<string, unknown>>)
      : [];
    const analysisIds = functions.map(f => String(f.id ?? "").trim()).filter(id => /^F\d+$/.test(id));

    this.logger.info(`deterministic: removing ghost function IDs: ${ghostIds.join(", ")}`);

    if (task.type === "tests" && typeof currentContent === "string") {
      // 对于测试用例：移除引用了幽灵 ID 的整个测试用例块
      let fixed = currentContent;
      for (const ghostId of ghostIds) {
        // Remove test case entries like "## TC-N-xxx: ...\n- **测试对象**: F009\n..."
        // Strategy: replace the ghost ID with a note, or remove the test case block
        fixed = fixed.replace(
          new RegExp(`##[^\n]*\\n(?:-[^\n]*\\n)*\\s*-\\s\\*\\*测试对象\\*\\*:\\s*[^,]*\\b${this._escapeRegex(ghostId)}\\b[^\\n]*\\n(?:-[^\n]*\\n)*`, "g"),
          "",
        );
      }
      // If nothing changed, try simple replacement
      if (fixed === currentContent) {
        for (const ghostId of ghostIds) {
          fixed = fixed.replace(
            new RegExp(`\\b${this._escapeRegex(ghostId)}\\b`, "g"),
            analysisIds.length > 0 ? analysisIds[0] : "",
          );
        }
      }
      return fixed !== currentContent ? fixed : null;
    }

    if (task.type === "design" && typeof currentContent === "string") {
      // 对于设计：移除引用了幽灵 ID 的模块表行
      let fixed = currentContent;
      for (const ghostId of ghostIds) {
        // Remove table rows: | **ModuleName** | ... | F009 |
        fixed = fixed.replace(
          new RegExp(`\\|[^\n]*\\b${this._escapeRegex(ghostId)}\\b[^\n]*\\|\\n`, "g"),
          "",
        );
      }
      // 备选方案：简单的单词替换
      if (fixed === currentContent) {
        for (const ghostId of ghostIds) {
          fixed = fixed.replace(
            new RegExp(`\\b${this._escapeRegex(ghostId)}\\b`, "g"),
            "",
          );
        }
      }
      return fixed !== currentContent ? fixed : null;
    }

    return null;
  }

  private _fixMissingConstraintTest(
    _task: Task,
    currentContent: unknown,
    constraintId: string,
    context: Record<string, unknown>,
  ): unknown | null {
    if (typeof currentContent !== "string") return null;

    const reqJson = context.requirement_json as Record<string, unknown> | undefined;
    if (!reqJson) return null;

    const constraints = Array.isArray(reqJson.constraints)
      ? reqJson.constraints as Array<Record<string, unknown>>
      : [];
    const constraint = constraints.find((c) =>
      String(c.id ?? "").trim() === constraintId ||
      String(c.displayId ?? "").trim() === constraintId ||
      String(c.constraintRef ?? "").trim() === constraintId,
    );
    if (!constraint) return null;

    const desc = String(constraint.description ?? constraintId);
    const testNum = (currentContent.match(/## TC-B-/g) ?? []).length + 1;
    const testId = `TC-B-${String(testNum).padStart(3, "0")}`;

    const newTest = `\n\n## ${testId}: ${constraintId} 约束边界测试\n- **类型**: 边界\n- **测试对象**: ${constraintId}\n- **前置条件**: 系统已初始化，相关数据就绪\n- **测试步骤**: 1. 构造满足约束 ${constraintId}（${desc.slice(0, 60)}）边界值的数据 2. 触发对应业务操作 3. 验证系统对边界值的处理结果\n- **预期结果**: 系统在边界值处正确执行约束校验，边界内通过，边界外拒绝并给出提示\n- **优先级**: P1`;

    return currentContent + newTest;
  }

  private _escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ------------------------------------------------------------------
  // 完整产物修复响应解析
  // ------------------------------------------------------------------

  private _parseDesignRepairResponse(
    response: Record<string, unknown>,
    task: Task,
  ): unknown | null {
    if (!isRecord(response)) {
      this.logger.warn(`repair: task=${task.id} rejected empty design repair response`);
      return null;
    }
    if (RepairTool._isLegacyRepairEnvelope(response)) {
      this.logger.warn(`repair: task=${task.id} rejected legacy design repair envelope`);
      return null;
    }
    const designModel = RepairTool._extractDesignModelRepair(response);
    if (!designModel) {
      this.logger.warn(`repair: task=${task.id} rejected non-DesignModel design repair`);
      return null;
    }
    this.logger.info(`repair: task=${task.id} accepted full DesignModel repair`);
    return designModel;
  }

  private _applyFullRepairResponse(
    task: Task,
    currentContent: unknown,
    llmText: string,
  ): unknown | null {
    const cleanText = RepairTool._stripCodeFences(llmText);
    if (task.type === "tests") {
      return this._parseTestsRepairResponse(task, currentContent, cleanText);
    }
    if (task.type === "diagrams") {
      return this._parseDiagramRepairResponse(task, cleanText);
    }
    return cleanText;
  }

  private _parseTestsRepairResponse(
    task: Task,
    currentContent: unknown,
    cleanText: string,
  ): unknown | null {
    const currentIsJson = RepairTool._looksLikeJsonContent(currentContent);
    try {
      const parsed = JSON.parse(cleanText) as unknown;
      if (!isRecord(parsed)) {
        this.logger.warn(`repair: task=${task.id} rejected non-object test repair JSON`);
        return null;
      }
      if (RepairTool._isLegacyRepairEnvelope(parsed)) {
        this.logger.warn(`repair: task=${task.id} rejected legacy test repair envelope`);
        return null;
      }
      const inferred = RepairTool._inferContent(parsed, task);
      if (typeof inferred === "string") {
        return RepairTool._normalizeFullTextRepair(task, inferred, currentIsJson, this.logger);
      }
      if (isRecord(inferred) || Array.isArray(inferred)) {
        return JSON.stringify(inferred, null, 2);
      }
      this.logger.warn(`repair: task=${task.id} test repair missing full test_cases content`);
      return null;
    } catch {
      if (currentIsJson) {
        this.logger.warn(`repair: task=${task.id} rejected non-JSON repair for structured tests`);
        return null;
      }
      return cleanText;
    }
  }

  private _parseDiagramRepairResponse(task: Task, cleanText: string): unknown | null {
    try {
      const parsed = JSON.parse(cleanText) as unknown;
      if (!isRecord(parsed)) {
        this.logger.warn(`repair: task=${task.id} rejected non-object diagram repair JSON`);
        return null;
      }
      if (RepairTool._isLegacyRepairEnvelope(parsed)) {
        this.logger.warn(`repair: task=${task.id} rejected legacy diagram repair envelope`);
        return null;
      }
      const inferred = RepairTool._inferContent(parsed, task);
      if (isRecord(inferred)) return inferred;
      if (typeof inferred === "string") return RepairTool._wrapDiagramText(task, inferred);
      this.logger.warn(`repair: task=${task.id} diagram repair missing full diagram content`);
      return null;
    } catch {
      return RepairTool._wrapDiagramText(task, cleanText);
    }
  }

  private static _normalizeFullTextRepair(
    task: Task,
    text: string,
    currentIsJson: boolean,
    logger: { warn: (msg: string) => void },
  ): unknown | null {
    if (!currentIsJson) return text;
    try {
      const parsed = JSON.parse(RepairTool._stripCodeFences(text));
      return JSON.stringify(parsed, null, 2);
    } catch {
      logger.warn(`repair: task=${task.id} rejected string repair because current content is JSON`);
      return null;
    }
  }

  private static _looksLikeJsonContent(content: unknown): boolean {
    if (typeof content === "object" && content !== null) return true;
    if (typeof content !== "string") return false;
    const clean = RepairTool._stripCodeFences(content).trim();
    return clean.startsWith("{") || clean.startsWith("[");
  }

  private static _contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (content === null || content === undefined) return "";
    if (typeof content === "object") return JSON.stringify(content);
    return String(content);
  }

  private static _isLegacyRepairEnvelope(parsed: Record<string, unknown>): boolean {
    return (
      Array.isArray(parsed.ops) ||
      Array.isArray(parsed.patches) ||
      String(parsed.action ?? "") === "full_replace"
    );
  }

  private static _extractDesignModelRepair(parsed: Record<string, unknown>): unknown | null {
    for (const candidate of [parsed, parsed.content, parsed.design, parsed.result]) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const model = SystemDesigner.parseDesignModel(candidate as Record<string, unknown>);
      if (model) return model;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // 构建 Prompt
  // ------------------------------------------------------------------

  private _loadRepairPrompt(task: Task): Promise<string> {
    const queryCtx = `repair ${task.type}: ${task.description.slice(0, 200)}`;
    return this._loadPromptWithConstitution("repair.md", "", queryCtx);
  }

  private _buildRepairPrompt(
    task: Task,
    currentContent: unknown,
    fixInstructions: Array<Record<string, unknown>>,
    context: Record<string, unknown>,
  ): string {
    const sections: string[] = [];

    const hints = (task.contextHints ?? {}) as Record<string, unknown>;
    let taskInfo = `**类型**: ${task.type}\n**描述**: ${task.description}`;
    const diagramKind = String(hints.diagram_kind ?? "").trim();
    if (diagramKind) taskInfo += `\n**图表类型**: ${diagramKind}`;
    sections.push(`## 任务信息\n${taskInfo}`);

    const reqText = String(context.requirement_text ?? "").slice(0, 6000);
    if (reqText) sections.push(`## 原始需求\n${reqText}`);

    sections.push(`## Evaluator 发现的问题\n${RepairTool._formatIssues(fixInstructions)}`);

    sections.push(`## 当前产物\n${RepairTool._formatContent(currentContent)}`);

    // For tests: add test quality diagnostics identifying template-like tests
    if (task.type === "tests") {
      const requirementJson = isRecord(context.requirement_json)
        ? context.requirement_json
        : undefined;
      const diagSection = this._buildTestQualityDiagnostic(currentContent, requirementJson);
      if (diagSection) sections.push(diagSection);
    }

    const aux = RepairTool._formatAuxContext(context);
    if (aux) sections.push(`## 辅助上下文\n${aux}`);

    if (task.type === "design") {
      const requirementJson = isRecord(context.requirement_json)
        ? context.requirement_json
        : null;
      let designText: string;
      if (isDesignModel(currentContent)) {
        designText = SystemDesigner.renderDesignMarkdown(currentContent);
      } else {
        designText = typeof currentContent === "string" ? currentContent : String(currentContent ?? "");
      }
      const designWarnings = requirementJson
        ? SystemDesigner.validateDesign(designText, requirementJson)
        : [];

      if (designWarnings.length > 0) {
        sections.push(
          `## 当前设计全量校验结果\n${designWarnings.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
        );
      }
    }

    let fmtNote: string;
    if (task.type === "analyze") {
      fmtNote = '- 严格输出 JSON 格式：{"content": <修复后的完整产物>}';
    } else if (task.type === "tests") {
      fmtNote = '- 如果当前产物是 JSON 格式（{"test_cases": [...]}），直接输出修复后的完整 JSON 根对象，必须包含完整 `test_cases` 数组。\n- 如果当前产物是 Markdown 格式，直接输出修复后的完整 Markdown 文本。\n- 测试用例 id 使用 TC-N-###、TC-E-###、TC-B-###，分别对应正常/异常/边界。\n- target 字段使用显示 ID（F001/C001/X001）加当前约束/功能描述。\n- 需求 ID 写在 target、steps 或 expected_result 中。\n- 对低质量/模板化测试，直接保留原 id 并重写该测试用例内容；同一 target 保留一条高质量测试。';
    } else if (task.type === "design") {
      fmtNote = '- 直接输出修复后的完整 DesignModel JSON 根对象。\n- 根对象包含 `constraintImplementations`、`exceptionImplementations`、`modules`、`classes`、`dataFlows`、`coverageMatrix`、`supplementaryClasses`。\n- `classes[]` 每个类对象字段固定为：`name`（类名，英文，与需求实体名一致）、`kind`（"domain" 或 "helper"）、`responsibility`（职责描述）、`attributes`（[{name,type,description?}] 数组）、`methods`（方法名字符串数组）、`entityRef`（对应实体名，可选）。严禁改用 className/responsibilities/keyAttributes/keyMethods 等别名。\n- `modules[]` 每个模块对象字段固定为：`name`（模块名称）、`responsibility`（职责描述）、`id`（模块 ID）、`functionIds`（功能 ID 数组）。必须使用以上规范字段名，不得改用 moduleName/description/moduleId 等别名。\n- 每个 `constraintImplementations[].constraintId` 使用需求分析中的 display ID（C001/C002...），每条约束保留独立实现段落。\n- 每个 `exceptionImplementations[].exceptionId` 使用需求分析中的 display ID（X001/X002...）。\n- `modules[].functionIds` 使用需求分析中的 display ID（F001/F002...）。';
    } else if (task.type === "diagrams") {
      fmtNote = '- 直接输出修复后的完整 JSON 根对象，例如 {"class_diagram":"完整 Mermaid", "activity_diagram":"完整 Mermaid"}。\n- 只包含本任务负责的图表键；Mermaid 内容作为 JSON 字符串值。';
    } else {
      fmtNote = '- 直接输出修复后的完整产物。';
    }
    const repairRules = task.type === "analyze"
      ? "- 输出修复后的完整产物"
      : "- 输出修复后的完整产物\n- 只改变 Evaluator 指出的问题相关内容\n- 保留所有未被指出问题的正确内容";
    sections.push(`## 修复要求\n根据 Evaluator 发现的问题，精准修复当前产物。\n\n**要求**：\n${repairRules}\n${fmtNote}`);

    if (task.type === "diagrams" && diagramKind) {
      sections.push(`\n## 硬性约束\n本任务仅负责 ${diagramKind}，输出 JSON 只能包含 \`${diagramKind}\`。`);
    }

    return sections.join("\n\n");
  }

  /**
   * Build a diagnostic section identifying template-like tests and listing
   * their IDs, so the repair LLM knows which tests must be replaced.
   */
  private _buildTestQualityDiagnostic(
    currentContent: unknown,
    requirementJson?: Record<string, unknown>,
  ): string | null {
    let tests: Array<Record<string, unknown>> = [];
    try {
      if (typeof currentContent === "string") {
        const clean = currentContent.trim();
        if (clean.startsWith("{")) {
          const doc = JSON.parse(clean);
          if (Array.isArray(doc.test_cases)) {
            tests = doc.test_cases.filter(
              (tc: unknown) => typeof tc === "object" && tc !== null,
            ) as Array<Record<string, unknown>>;
          }
        }
      } else if (typeof currentContent === "object" && currentContent !== null) {
        const doc = currentContent as Record<string, unknown>;
        if (Array.isArray(doc.test_cases)) {
          tests = doc.test_cases.filter(
            (tc: unknown) => typeof tc === "object" && tc !== null,
          ) as Array<Record<string, unknown>>;
        }
      }
    } catch {
      return null;
    }

    if (tests.length === 0) return null;

    const templateIds: string[] = [];
    const repairIssueLines: string[] = [];
    const coveredTargets = new Set<string>();

    for (const tc of tests) {
      const id = String(tc.id ?? "").trim();
      if (isTemplateLike(tc)) {
        templateIds.push(id);
      }
      const target = String(tc.target ?? "").trim();
      if (target) coveredTargets.add(target);
    }

    if (requirementJson) {
      const qualityIssues = validateTestCaseQuality(tests, requirementJson);
      for (const issue of qualityIssues) {
        if (
          issue.issue === "target_content_alignment" ||
          issue.issue === "canonical_only_target" ||
          issue.issue === "fabricated_canonical_id" ||
          issue.issue === "wrong_target"
        ) {
          repairIssueLines.push(`- \`${issue.testId}\`: ${issue.detail}`);
        }
      }
    }

    if (templateIds.length === 0 && repairIssueLines.length === 0) return null;

    const lines: string[] = ["## 现有测试质量诊断"];
    lines.push("");
    if (templateIds.length > 0) {
      lines.push("以下测试用例被检测为模板化/低质量，必须在完整 test_cases 数组中保留原 id，并沿用原 target 的覆盖意图直接改写内容：");
      for (const id of templateIds) {
        lines.push(`- \`${id}\` ← 保留该 id，重写为高质量测试`);
      }
      lines.push("");
    }
    if (repairIssueLines.length > 0) {
      lines.push("以下测试用例的 target 或 target/content 对齐存在问题，必须在完整 JSON 中直接修正 target 与断言内容：");
      lines.push(...repairIssueLines);
      lines.push("");
    }
    lines.push(`已覆盖的 target: ${coveredTargets.size > 0 ? Array.from(coveredTargets).map(t => `\`${t}\``).join(", ") : "(无)"}`);
    lines.push("如果某个 target 已有测试（即使质量低），优先改写已有测试并保持 target 覆盖唯一。");

    return lines.join("\n");
  }

  // ------------------------------------------------------------------
  // 格式化
  // ------------------------------------------------------------------

  static _formatIssues(issues: Array<Record<string, unknown>>): string {
    if (issues.length === 0) return "(无问题)";
    return issues.map((iss, i) => {
      const severity = iss.severity ?? "major";
      const target = iss.target_field ?? iss.task_type ?? "";
      const desc = iss.description ?? "";
      const suggestion = iss.suggestion ?? "";
      let line = `### 问题 ${i + 1} [${severity}]`;
      if (target) line += ` — \`${target}\``;
      line += `\n**问题**: ${desc}`;
      if (suggestion) line += `\n**修复建议**: ${suggestion}`;
      return line;
    }).join("\n\n");
  }

  static _formatContent(content: unknown): string {
    if (content === null || content === undefined) return "(空)";
    if (typeof content === "string") {
      return content.length > 12000 ? content.slice(0, 12000) + "\n\n...(产物已截断)" : content;
    }
    if (typeof content === "object") {
      const serialized = JSON.stringify(content, null, 2);
      const truncated = serialized.length > 12000 ? serialized.slice(0, 12000) + "\n\n...(产物已截断)" : serialized;
      return "```json\n" + truncated + "\n```";
    }
    return String(content).slice(0, 12000);
  }

  static _formatAuxContext(context: Record<string, unknown>): string {
    const parts: string[] = [];
    const skipKeys = new Set([
      "previous_artifact",
      "previous_artifact_type",
      "artifact_summary",
      "artifact_snapshots",
    ]);
    for (const [key, val] of Object.entries(context)) {
      if (key.startsWith("_") || key === "requirement_text") continue;
      if (skipKeys.has(key)) continue;
      if (typeof val === "string") {
        parts.push(`### ${key}\n${val.slice(0, 3000)}`);
      } else if (typeof val === "object" && val !== null) {
        const serialized = JSON.stringify(val, null, 2);
        parts.push(`### ${key}\n\`\`\`json\n${serialized.slice(0, 4000)}\n\`\`\``);
      }
    }
    return parts.join("\n\n");
  }

  // ------------------------------------------------------------------
  // 图表辅助函数
  // ------------------------------------------------------------------

  static _wrapDiagramText(task: Task, text: string): unknown {
    if (task.type !== "diagrams") return text;
    const hints = (task.contextHints ?? {}) as Record<string, unknown>;
    let diagramKind = String(hints.diagram_kind ?? "").trim();
    if (!diagramKind) diagramKind = RepairTool._inferDiagramKind(task, text);
    if (diagramKind) return { [diagramKind]: text };
    return { diagram: text };
  }

  // ------------------------------------------------------------------
  // 解析响应
  // ------------------------------------------------------------------

  private _parseResponse(response: Record<string, unknown>, task: Task): unknown {
    let content = response.content;

    if (content === undefined && !("content" in response) && Object.keys(response).length > 0) {
      content = RepairTool._inferContent(response, task);
    }

    if (content !== undefined && task.type === "diagrams") {
      if (typeof content === "object" && content !== null && !Array.isArray(content)) {
        const maybeWrapped = content as Record<string, unknown>;
        if (
          typeof maybeWrapped.diagrams === "object" &&
          maybeWrapped.diagrams !== null &&
          !Array.isArray(maybeWrapped.diagrams)
        ) {
          content = maybeWrapped.diagrams;
        }
      }
      const hints = (task.contextHints ?? {}) as Record<string, unknown>;
      let diagramKind = String(hints.diagram_kind ?? "").trim();
      if (!diagramKind) diagramKind = RepairTool._inferDiagramKind(task, String(content));
      if (typeof content === "string" && diagramKind) {
        content = { [diagramKind]: content };
      }
      if (diagramKind && typeof content === "object" && content !== null && !Array.isArray(content)) {
        const c = content as Record<string, unknown>;
        const extra = Object.keys(c).filter((k) => k !== diagramKind);
        if (extra.length > 0) {
          content = { [diagramKind]: c[diagramKind] };
        }
      }
    }

    return content;
  }

  static _inferContent(response: Record<string, unknown>, task: Task): unknown {
    if (task.type === "analyze" && "actors" in response) return response;
    if (task.type === "diagrams" && ("class_diagram" in response || "activity_diagram" in response || "state_diagram" in response)) return response;
    if (task.type === "diagrams" && typeof response.diagrams === "object" && response.diagrams !== null) return response.diagrams;
    if (task.type === "design" && typeof response.system_design === "string") return response.system_design;
    if (task.type === "tests" && typeof response.test_cases === "string") return response.test_cases;
    if (task.type === "tests" && Array.isArray(response.test_cases)) return JSON.stringify({ test_cases: response.test_cases }, null, 2);
    if (Object.keys(response).length === 1) {
      const val = Object.values(response)[0];
      if (typeof val === "object" || typeof val === "string") return val;
    }
    return null;
  }

  static _stripCodeFences(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith("```")) {
      const firstNl = trimmed.indexOf("\n");
      const lastFence = trimmed.lastIndexOf("```");
      if (firstNl >= 0 && lastFence > firstNl) {
        return trimmed.slice(firstNl + 1, lastFence).trim();
      }
    }
    return trimmed;
  }

  static _inferDiagramKind(task: Task, text = ""): string {
    const haystack = `${task.id} ${task.description} ${text.slice(0, 200)}`.toLowerCase();
    if (haystack.includes("class") || haystack.includes("类图") || haystack.includes("classdiagram")) return "class_diagram";
    if (haystack.includes("activity") || haystack.includes("活动") || haystack.includes("flowchart") || haystack.includes("graph ")) return "activity_diagram";
    if (haystack.includes("state") || haystack.includes("状态") || haystack.includes("statediagram")) return "state_diagram";
    return "";
  }
}
