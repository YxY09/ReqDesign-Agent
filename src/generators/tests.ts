/**
 * TestCaseGenerator — 正常/异常/边界测试用例生成。
 *
 * 使用 task-first 架构：
 *   Phase 1: buildTestPlan (程序化规划)
 *   Phase 2: grouped LLM calls (按模块分组生成)
 *   Phase 3: quality validation (程序化质量校验)
 */

import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";
import { minimizeForPrompt } from "../shared/minimizeJsonForPrompt.js";
import { RequirementIndex } from "../shared/requirementIndex.js";
import { createToolError } from "../tools/types.js";
import { BaseGenerator } from "./base.js";
import { buildTestPlan, groupByModule, formatTaskGroupForPrompt } from "./testPlanBuilder.js";
import { validateTestCases as validateTestQuality } from "./testQualityValidator.js";

export class TestCaseGenerator extends BaseGenerator<string> {
  private promptTemplate: string;
  private taskPromptTemplate: string;

  constructor(llm: LLMClient) {
    super(llm);
    this.promptTemplate = loadPrompt(
      "test_case.md",
      "请根据以下需求和设计生成测试用例：\n\n{requirement_json}\n\n{design_text}",
    );
    this.taskPromptTemplate = loadPrompt(
      "test_case_task.md",
      "请根据以下测试任务生成测试用例：\n\n{test_tasks}\n\n{design_text}",
    );
  }

  async generate(input: unknown): Promise<string> {
    let { requirementJson, designText, systemPrompt, requirementText = "" } = input as {
      requirementJson: Record<string, unknown>;
      designText: string;
      systemPrompt?: string;
      requirementText?: string;
    };
    if (!requirementJson && requirementText) {
      requirementJson = { _direct_mode: true, raw_requirement: requirementText };
    } else if (!requirementJson || typeof requirementJson !== "object") {
      throw createToolError("TESTS_EMPTY_INPUT", "需求JSON不能为空且必须是字典类型", { recoverable: false });
    }
    designText = designText || "";

    // --- Task-first architecture ---

    // Phase 1: Programmatic test plan
    const testPlan = buildTestPlan(requirementJson);
    if (testPlan.length === 0) {
      // No coverage targets — fall back to single-shot
      return this.generateSingleShot(requirementJson, designText, systemPrompt);
    }

    // Phase 2: Group tasks and generate with LLM per group
    const groups = groupByModule(testPlan);
    const allRawResults: string[] = [];

    let safeDesign = this.sanitizePlaceholder(designText, "requirement_json");
    safeDesign = this.sanitizePlaceholder(safeDesign, "design_text");
    safeDesign = this.sanitizePlaceholder(safeDesign, "test_tasks");

    for (const group of groups) {
      const taskText = formatTaskGroupForPrompt(group);
      let taskPrompt = this.taskPromptTemplate.replace(/\{test_tasks\}/g, taskText);
      taskPrompt = taskPrompt.replace(
        /\{design_text\}/g,
        `${TestCaseGenerator.buildTestContract(requirementJson)}\n\n${safeDesign}`,
      );

      const result = await this.llm.generateText(taskPrompt, systemPrompt ?? "");
      allRawResults.push(result);
    }

    // Merge all group results into a single test_cases array
    const allTestCases = TestCaseGenerator.mergeGroupResults(allRawResults);

    if (allTestCases.length === 0) {
      // All groups failed to parse — fall back to single-shot
      return this.generateSingleShot(requirementJson, designText, systemPrompt);
    }

    // Phase 3: Quality validation
    const issues = validateTestQuality(allTestCases, requirementJson);
    const rejectedIds = new Set(
      issues.filter((i) => i.severity === "reject").map((i) => i.testId),
    );
    const goodCases = allTestCases.filter(
      (tc) => !rejectedIds.has(String(tc.id ?? "").trim()),
    );

    // Log quality summary
    if (issues.length > 0) {
      const rejectCount = issues.filter((i) => i.severity === "reject").length;
      const warnCount = issues.filter((i) => i.severity === "warning").length;
      console.warn(
        `[TestCaseGenerator] Quality validation: ${goodCases.length} passed, ${rejectCount} rejected, ${warnCount} warnings`,
      );
    }

    // If all cases were rejected, fall back to single-shot as safety net
    if (goodCases.length === 0) {
      console.warn("[TestCaseGenerator] All test cases rejected by quality validator, falling back to single-shot generation");
      return this.generateSingleShot(requirementJson, designText, systemPrompt);
    }

    const mergedJson = JSON.stringify({ test_cases: goodCases }, null, 2);
    return TestCaseGenerator.normalizeStructuredTestCases(mergedJson, requirementJson) ?? mergedJson;
  }

  /**
   * Fallback single-shot generation using the original prompt template.
   */
  private async generateSingleShot(
    requirementJson: Record<string, unknown>,
    designText: string,
    systemPrompt?: string,
  ): Promise<string> {
    let reqStr = JSON.stringify(minimizeForPrompt(requirementJson), null, 2);
    reqStr = this.sanitizePlaceholder(reqStr, "design_text");
    let safeDesign = this.sanitizePlaceholder(designText, "requirement_json");
    safeDesign = this.sanitizePlaceholder(safeDesign, "design_text");
    let prompt = this.promptTemplate.replace(/\{requirement_json\}/g, reqStr);
    prompt = prompt.replace(
      /\{design_text\}/g,
      `${TestCaseGenerator.buildTestContract(requirementJson)}\n\n${safeDesign}`,
    );

    const result = await this.llm.generateText(prompt, systemPrompt ?? "");
    return TestCaseGenerator.normalizeStructuredTestCases(result, requirementJson) ?? result;
  }

  /**
   * Merge raw LLM results from multiple groups into a single test_cases array.
   */
  private static mergeGroupResults(rawResults: string[]): Array<Record<string, unknown>> {
    const allCases: Array<Record<string, unknown>> = [];
    for (const raw of rawResults) {
      const normalized = TestCaseGenerator.normalizeStructuredTestCaseIds(raw);
      const text = normalized ?? raw;
      const parsed = TestCaseGenerator.parseStructuredTestCases(text);
      if (parsed) {
        allCases.push(...parsed);
      }
    }
    return allCases;
  }

  static buildTestContract(requirementJson: Record<string, unknown>): string {
    const functions = BaseGenerator.formatContractList(requirementJson.functions, ["displayId", "id", "name", "description"]);
    const exceptions = BaseGenerator.formatContractList(requirementJson.exceptions, ["displayId", "id", "description", "trigger"]);
    const constraints = BaseGenerator.formatContractList(requirementJson.constraints, ["displayId", "id", "description", "source_text", "related_functions"]);

    return [
      "## 测试生成合同（硬性约束）",
      "以下 ID 是唯一可信来源。测试对象和测试步骤只能引用这些真实 ID，禁止重新编号或改前缀。",
      functions.length > 0 ? `### 必须覆盖的功能 ID\n${functions.map((item) => `- ${item}`).join("\n")}` : "",
      exceptions.length > 0 ? `### 必须覆盖的异常 ID\n${exceptions.map((item) => `- ${item}`).join("\n")}` : "",
      constraints.length > 0 ? `### 必须覆盖的约束 ID\n${constraints.map((item) => `- ${item}`).join("\n")}` : "",
      "- 每个功能 ID 至少出现在一个测试对象中。",
      "- 每个异常 ID 至少出现在一个异常测试的测试对象或测试步骤中。",
      "- 如果异常 ID 是 X001，就必须写 X001；禁止改写为 E001。",
      constraints.length > 0 ? "- 每个约束 ID 至少出现在一个边界测试或约束验证测试的测试对象或测试步骤中。约束的 source_text 描述了具体规则，related_functions 描述了涉及的功能，测试用例应基于这些信息编写。" : "",
      "- 输出必须是合法 JSON 根对象，且包含 `test_cases` 数组；禁止输出 Markdown、表格、代码围栏或解释文本。",
      "- 每个测试用例对象必须包含 id/title/type/target/preconditions/steps/expected_result/priority。",
      "- 优先级必须使用 P0/P1/P2。",
    ].filter(Boolean).join("\n\n");
  }

  static validateTestCases(testCases: string, requirementJson: Record<string, unknown>): string[] {
    const warnings: string[] = [];

    if (!testCases?.trim()) {
      warnings.push("测试用例为空");
      return warnings;
    }
    if (!requirementJson || typeof requirementJson !== "object") {
      warnings.push("需求分析结果为空");
      return warnings;
    }

    const structured = TestCaseGenerator.parseStructuredTestCases(testCases);
    if (structured) {
      return TestCaseGenerator.validateStructuredTestCases(structured, requirementJson);
    }

    if (!/^##\s+TC-[A-Z]-\d{3,}/m.test(testCases)) {
      warnings.push("测试用例缺少项目宪法要求的标题格式: ## TC-{编号}: {用例名称}");
    }
    if (/^\s*\|.*\|\s*$/m.test(testCases)) {
      warnings.push("测试用例应使用 Markdown 列表格式，不能使用表格格式");
    }
    const invalidPriority = testCases.match(/优先级\*\*:\s*(高|中|低|High|Medium|Low)/i);
    if (invalidPriority) {
      warnings.push("测试用例优先级必须使用 P0/P1/P2，不能使用高/中/低");
    }
    const priorityLines = [...testCases.matchAll(/优先级\*\*:\s*([^\n\r]+)/g)];
    for (const line of priorityLines) {
      const value = line[1].trim();
      if (!/\bP[012]\b/.test(value)) {
        warnings.push(`测试用例优先级值不合法: ${value}`);
      }
    }

    if (!testCases.includes("正常")) warnings.push("缺少正常场景测试");
    if (!testCases.includes("异常")) warnings.push("缺少异常场景测试");
    if (!testCases.includes("边界")) warnings.push("缺少边界场景测试");

    const collectIds = (items: unknown): Array<{ id: string; name: string }> => {
      if (!Array.isArray(items)) return [];
      const results: Array<{ id: string; name: string }> = [];
      for (const item of items) {
        if (typeof item === "object" && item !== null) {
          const rec = item as Record<string, unknown>;
          const id = String(rec.id ?? "").trim();
          const name = String(rec.name ?? "").trim();
          if (id || name) results.push({ id, name });
        } else if (typeof item === "string" && item.trim()) {
          results.push({ id: "", name: item.trim() });
        }
      }
      return results;
    };

    const extractRefs = (text: string, prefix: string): string[] => {
      const refs = new Set<string>();
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}[A-Za-z0-9_]+\\b`, "g");
      for (const match of text.matchAll(re)) {
        refs.add(match[0]);
      }
      return [...refs];
    };

    const extractExactRefs = (text: string, ids: Set<string>): string[] => {
      const refs = new Set<string>();
      for (const id of ids) {
        if (id && new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) {
          refs.add(id);
        }
      }
      return [...refs];
    };

    const extractUnknownRequirementRefs = (text: string, allowedIds: Set<string>, prefixes: string[]): string[] => {
      const prefixGroup = prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      const re = new RegExp(`\\b(?:${prefixGroup})[A-Za-z0-9_]+\\b`, "g");
      return [...new Set(text.match(re) ?? [])].filter((id) => !allowedIds.has(id));
    };

    // Build sets containing BOTH displayId and canonicalId for validation
    const collectAllIdForms = (items: unknown): Set<string> => {
      const ids = new Set<string>();
      if (!Array.isArray(items)) return ids;
      for (const item of items) {
        if (typeof item === "object" && item !== null) {
          const rec = item as Record<string, unknown>;
          const displayId = String(rec.displayId ?? "").trim();
          const id = String(rec.id ?? "").trim();
          if (displayId) ids.add(displayId);
          if (id) ids.add(id);
        }
      }
      return ids;
    };

    const exceptionItems = collectIds(requirementJson["exceptions"]);
    const functionAllIds = collectAllIdForms(requirementJson["functions"]);
    const exceptionAllIds = collectAllIdForms(requirementJson["exceptions"]);
    const referencedFunctionIds = extractRefs(testCases, "F");
    const referencedExceptionIds = extractExactRefs(testCases, exceptionAllIds);

    const functions = requirementJson["functions"];
    if (Array.isArray(functions)) {
      for (const func of functions) {
        if (typeof func === "object" && func !== null) {
          const rec = func as Record<string, unknown>;
          const fid = String(rec.displayId ?? rec.id ?? "").trim();
          const canonicalId = String(rec.id ?? "").trim();
          const name = String(rec.name || "").trim();
          const idFound = fid && testCases.includes(fid);
          const canonicalFound = canonicalId && canonicalId !== fid && testCases.includes(canonicalId);
          if (fid && !idFound && !canonicalFound) {
            const label = `${fid} ${name}`.trim();
            warnings.push(`功能 ${label} 未被测试用例覆盖`);
          } else if (!fid && name && !testCases.includes(name)) {
            warnings.push(`功能 ${name} 未被测试用例覆盖`);
          }
        } else {
          const name = String(func);
          if (name && !testCases.includes(name)) {
            warnings.push(`功能 ${name} 未被测试用例覆盖`);
          }
        }
      }
    }

    for (const fid of referencedFunctionIds) {
      if (!functionAllIds.has(fid)) {
        warnings.push(`测试用例引用了未定义的功能 ID: ${fid}`);
      }
    }

    for (const eid of extractUnknownRequirementRefs(testCases, exceptionAllIds, ["E", "X"])) {
      warnings.push(`测试用例引用了未定义的异常 ID: ${eid}`);
    }

    if (exceptionItems.length > 0) {
      for (const item of exceptionItems) {
        if (!item.id) continue;
        const idFound = referencedExceptionIds.includes(item.id);
        const nameFound = item.name ? testCases.includes(item.name) : false;
        if (!idFound && !nameFound) {
          warnings.push(`异常 ${item.id}${item.name ? ` (${item.name})` : ""} 未被测试用例覆盖`);
        }
      }
    }

    return warnings;
  }

  static parseStructuredTestCases(testCases: string): Array<Record<string, unknown>> | null {
    const text = TestCaseGenerator.stripStructuredJsonText(testCases);
    if (!text.startsWith("{") && !text.startsWith("[")) return null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
        );
      }
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const cases = (parsed as Record<string, unknown>).test_cases;
        if (Array.isArray(cases)) {
          return cases.filter((item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null && !Array.isArray(item),
          );
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  static normalizeStructuredTestCaseIds(testCases: string): string | null {
    const text = TestCaseGenerator.stripStructuredJsonText(testCases);
    if (!text.startsWith("{") && !text.startsWith("[")) return null;

    try {
      const parsed = JSON.parse(text) as unknown;
      const root = Array.isArray(parsed)
        ? { test_cases: parsed }
        : typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? { ...(parsed as Record<string, unknown>) }
          : null;
      if (!root || !Array.isArray(root.test_cases)) return null;

      const cases = root.test_cases.filter((item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
      );
      const maxByPrefix: Record<string, number> = { N: 0, E: 0, B: 0 };
      for (const tc of cases) {
        const match = String(tc.id ?? "").trim().match(/^TC-([NEB])-(\d{3,})$/);
        if (!match) continue;
        const prefix = match[1];
        const value = Number.parseInt(match[2], 10);
        if (Number.isFinite(value)) {
          maxByPrefix[prefix] = Math.max(maxByPrefix[prefix] ?? 0, value);
        }
      }

      const used = new Set<string>();
      for (const tc of cases) {
        const currentId = String(tc.id ?? "").trim();
        if (/^TC-[NEB]-\d{3,}$/.test(currentId) && !used.has(currentId)) {
          used.add(currentId);
          continue;
        }

        const prefix = TestCaseGenerator.testIdPrefixForCase(tc);
        let next = (maxByPrefix[prefix] ?? 0) + 1;
        let id = `TC-${prefix}-${String(next).padStart(3, "0")}`;
        while (used.has(id)) {
          next += 1;
          id = `TC-${prefix}-${String(next).padStart(3, "0")}`;
        }
        maxByPrefix[prefix] = next;
        tc.id = id;
        used.add(id);
      }

      root.test_cases = cases;
      return JSON.stringify(root, null, 2);
    } catch {
      return null;
    }
  }

  static normalizeStructuredTestCases(
    testCases: string,
    requirementJson?: Record<string, unknown>,
  ): string | null {
    const normalizedIds = TestCaseGenerator.normalizeStructuredTestCaseIds(testCases);
    if (!requirementJson) return normalizedIds;

    const text = normalizedIds ?? TestCaseGenerator.stripStructuredJsonText(testCases);
    if (!text.startsWith("{") && !text.startsWith("[")) return normalizedIds;

    try {
      const parsed = JSON.parse(text) as unknown;
      const root = Array.isArray(parsed)
        ? { test_cases: parsed }
        : typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? { ...(parsed as Record<string, unknown>) }
          : null;
      if (!root || !Array.isArray(root.test_cases)) return normalizedIds;

      const contract = RequirementIndex.fromRequirementJson(requirementJson);
      const cases = root.test_cases.filter((item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
      );
      for (const tc of cases) {
        tc.target = contract.normalizeTargetReferences(
          String(tc.target ?? ""),
          tc,
        );
        for (const field of ["preconditions", "expected_result"]) {
          if (typeof tc[field] === "string") {
            tc[field] = contract.removeUnknownRefs(String(tc[field]));
          }
        }
        if (Array.isArray(tc.steps)) {
          tc.steps = tc.steps.map((step) =>
            contract.removeUnknownRefs(String(step)),
          );
        }
      }
      root.test_cases = cases;
      return JSON.stringify(root, null, 2);
    } catch {
      return normalizedIds;
    }
  }

  private static stripStructuredJsonText(testCases: string): string {
    let text = testCases.trim();
    if (text.startsWith("```")) {
      const firstNewline = text.indexOf("\n");
      const lastFence = text.lastIndexOf("```");
      if (firstNewline >= 0 && lastFence > firstNewline) {
        text = text.slice(firstNewline + 1, lastFence).trim();
      }
    }
    return text;
  }

  private static testIdPrefixForCase(testCase: Record<string, unknown>): "N" | "E" | "B" {
    const type = String(testCase.type ?? "").trim();
    if (type === "异常") return "E";
    if (type === "边界") return "B";
    const currentId = String(testCase.id ?? "").trim();
    const match = currentId.match(/^TC-([NEB])-/);
    if (match?.[1] === "E" || match?.[1] === "B") return match[1];
    return "N";
  }

  static renderStructuredTestCasesMarkdown(testCases: string): string {
    const cases = TestCaseGenerator.parseStructuredTestCases(testCases);
    if (!cases) return testCases;
    return cases.map((tc) => {
      const id = String(tc.id ?? "").trim();
      const title = String(tc.title ?? "").trim();
      const steps = Array.isArray(tc.steps)
        ? tc.steps.map((step, index) => `${index + 1}. ${String(step)}`).join(" ")
        : String(tc.steps ?? "");
      return [
        `## ${id}: ${title}`.trim(),
        `- **类型**: ${String(tc.type ?? "").trim()}`,
        `- **测试对象**: ${String(tc.target ?? "").trim()}`,
        `- **前置条件**: ${String(tc.preconditions ?? "").trim()}`,
        `- **测试步骤**: ${steps}`,
        `- **预期结果**: ${String(tc.expected_result ?? "").trim()}`,
        `- **优先级**: ${String(tc.priority ?? "").trim()}`,
      ].join("\n");
    }).join("\n\n");
  }

  private static validateStructuredTestCases(
    cases: Array<Record<string, unknown>>,
    requirementJson: Record<string, unknown>,
  ): string[] {
    const warnings: string[] = [];
    if (cases.length === 0) {
      warnings.push("test_cases 数组为空");
      return warnings;
    }

    const text = JSON.stringify(cases);
    const requiredFields = ["id", "title", "type", "target", "preconditions", "steps", "expected_result", "priority"];
    const seenCaseIds = new Set<string>();
    for (const tc of cases) {
      const id = String(tc.id ?? "").trim();
      if (id) {
        if (seenCaseIds.has(id)) {
          warnings.push(`测试用例编号重复: ${id}`);
        }
        seenCaseIds.add(id);
      }
      for (const field of requiredFields) {
        if (!(field in tc) || tc[field] === null || tc[field] === "") {
          warnings.push(`测试用例 ${id || "unknown"} 缺少字段: ${field}`);
        }
      }
      if (!/^TC-[NEB]-\d{3,}$/.test(id)) {
        warnings.push(`测试用例编号不合法: ${id || "empty"}`);
      }
      const type = String(tc.type ?? "").trim();
      if (!["正常", "异常", "边界"].includes(type)) {
        warnings.push(`测试用例 ${id || "unknown"} type 必须为 正常/异常/边界`);
      }
      const priority = String(tc.priority ?? "").trim();
      if (!/^P[012]$/.test(priority)) {
        warnings.push(`测试用例 ${id || "unknown"} priority 必须为 P0/P1/P2`);
      }
      if (!Array.isArray(tc.steps) || tc.steps.length === 0) {
        warnings.push(`测试用例 ${id || "unknown"} steps 必须为非空数组`);
      }
    }

    if (!cases.some((tc) => String(tc.type ?? "") === "正常")) warnings.push("缺少正常场景测试");
    if (!cases.some((tc) => String(tc.type ?? "") === "异常")) warnings.push("缺少异常场景测试");
    if (!cases.some((tc) => String(tc.type ?? "") === "边界")) warnings.push("缺少边界场景测试");

    const requirementIndex = RequirementIndex.fromRequirementJson(requirementJson);
    const functionIds = new Set(requirementIndex.idsFor("function"));
    const exceptionIds = new Set(requirementIndex.idsFor("exception"));
    const functionIdMap = requirementIndex.idMapFor("function");
    const exceptionIdMap = requirementIndex.idMapFor("exception");

    const isCovered = (text: string, displayId: string, idMap: Map<string, string>): boolean => {
      if (text.includes(displayId)) return true;
      const canonicalId = idMap.get(displayId);
      if (canonicalId && text.includes(canonicalId)) return true;
      return false;
    };

    for (const fid of functionIds) {
      if (!isCovered(text, fid, functionIdMap)) warnings.push(`功能 ${fid} 未被测试用例覆盖`);
    }
    for (const eid of exceptionIds) {
      if (!isCovered(text, eid, exceptionIdMap)) warnings.push(`异常 ${eid} 未被测试用例覆盖`);
    }

    // Collect all referenced IDs from structured test cases
    const referencedIds = new Set<string>();
    const pairWarnings = new Set<string>();
    for (const tc of cases) {
      // Extract from target field with triplet-aware parsing
      const target = String(tc.target ?? "");
      const targetRefs = requirementIndex.extractTargetRefs(target);
      if (targetRefs.length > 0) {
        for (const ref of targetRefs) {
          referencedIds.add(ref.displayId);
          referencedIds.add(ref.canonicalId);
        }
        for (const warning of requirementIndex.pairWarnings(targetRefs, `测试用例 ${String(tc.id ?? "unknown")}`)) {
          pairWarnings.add(warning);
        }
      } else {
        for (const id of requirementIndex.extractIds(target)) referencedIds.add(id);
      }
      // Extract from other text fields with standard regex
      for (const field of ["preconditions", "expected_result"]) {
        const val = String(tc[field] ?? "");
        for (const id of requirementIndex.extractIds(val)) referencedIds.add(id);
      }
      if (Array.isArray(tc.steps)) {
        for (const step of tc.steps) {
          for (const id of requirementIndex.extractIds(String(step))) referencedIds.add(id);
        }
      }
    }
    warnings.push(...pairWarnings);

    const unknownRefs = requirementIndex.unknownReferences(referencedIds);
    for (const id of unknownRefs) {
      const kind = requirementIndex.kindLabelForId(id);
      warnings.push(`测试用例引用了未定义的${kind} ID: ${id}`);
    }

    return warnings;
  }

  static countTestCases(testCases: string): Record<string, number> {
    const counts = { "正常场景": 0, "异常场景": 0, "边界场景": 0, "总计": 0 };
    if (!testCases?.trim()) return counts;

    const structured = TestCaseGenerator.parseStructuredTestCases(testCases);
    if (structured) {
      for (const tc of structured) {
        const type = String(tc.type ?? "");
        if (type === "正常") counts["正常场景"]++;
        else if (type === "异常") counts["异常场景"]++;
        else if (type === "边界") counts["边界场景"]++;
        else counts["总计"]++;
      }
      counts["总计"] += counts["正常场景"] + counts["异常场景"] + counts["边界场景"];
      return counts;
    }

    let other = 0;
    for (const line of testCases.split("\n")) {
      const trimmed = line.trim();
      if (/^##\s+TC-N-\d{3,}/.test(trimmed)) {
        counts["正常场景"]++;
        continue;
      }
      if (/^##\s+TC-E-\d{3,}/.test(trimmed)) {
        counts["异常场景"]++;
        continue;
      }
      if (/^##\s+TC-B-\d{3,}/.test(trimmed)) {
        counts["边界场景"]++;
        continue;
      }
      if (/^##\s+TC-[A-Z]-\d{3,}/.test(trimmed)) {
        other++;
        continue;
      }
      if (!trimmed || !trimmed.startsWith("|")) continue;
      const cells = trimmed.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const stripped = cells.join("").replace(/-/g, "").trim();
      if (!stripped) continue;

      if (line.includes("正常")) counts["正常场景"]++;
      else if (line.includes("异常")) counts["异常场景"]++;
      else if (line.includes("边界")) counts["边界场景"]++;
      else if (line.includes("TC-")) other++;
    }

    counts["总计"] = counts["正常场景"] + counts["异常场景"] + counts["边界场景"] + other;
    return counts;
  }
}
