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
import {
  findDuplicateCandidates,
  applyDeterministicMerges,
  type DedupConfig,
} from "../shared/semanticDeduper.js";
import { extractContentTerms, jaccardSimilarity as jaccard } from "../shared/testAlignment.js";
import { setupLogger, type Logger } from "../logger.js";

export class TestCaseGenerator extends BaseGenerator<string> {
  private promptTemplate: string;
  private taskPromptTemplate: string;
  private readonly logger: Logger = setupLogger("reqdesign.TestCaseGenerator");

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
    this.logger.info(`generate: test plan targets=${testPlan.length}, groups=${groups.length}`);

    let safeDesign = this.sanitizePlaceholder(designText, "requirement_json");
    safeDesign = this.sanitizePlaceholder(safeDesign, "design_text");
    safeDesign = this.sanitizePlaceholder(safeDesign, "test_tasks");

    for (const [index, group] of groups.entries()) {
      const taskText = formatTaskGroupForPrompt(group);
      let taskPrompt = this.taskPromptTemplate.replace(/\{test_tasks\}/g, taskText);
      taskPrompt = taskPrompt.replace(
        /\{design_text\}/g,
        `${TestCaseGenerator.buildTestContract(requirementJson)}\n\n${safeDesign}`,
      );

      this.logger.info(`generate: group ${index + 1}/${groups.length} targets=${group.tasks.length} 开始`);
      const result = await this.withStreamTag(
        `[Generator:tests:group-${index + 1}-of-${groups.length}]`,
        () => this.llm.generateText(taskPrompt, systemPrompt ?? ""),
      );
      this.logger.info(`generate: group ${index + 1}/${groups.length} 完成，chars=${result.length}`);
      allRawResults.push(result);
    }

    // Merge all group results into a single test_cases array
    const allTestCases = TestCaseGenerator.mergeGroupResults(allRawResults);

    if (allTestCases.length === 0) {
      // All groups failed to parse — fall back to single-shot
      return this.generateSingleShot(requirementJson, designText, systemPrompt);
    }

    // Phase 3a: semantic deduplication across tests that share a target.
    // Reuses the shared semanticDeduper (same_source / normalized_text /
    // glossary / token-overlap layers) and adds a CJK bigram Jaccard fallback
    // because tokenize() collapses unsegmented CJK into a single token.
    const dedupedTestCases = TestCaseGenerator._dedupTestCases(allTestCases, requirementJson);

    // Phase 3b: Quality validation
    const issues = validateTestQuality(dedupedTestCases, requirementJson);
    const rejectedIds = new Set(
      issues.filter((i) => i.severity === "reject").map((i) => i.testId),
    );
    const goodCases = dedupedTestCases.filter(
      (tc) => !rejectedIds.has(String(tc.id ?? "").trim()),
    );

    // Log quality summary
    if (issues.length > 0) {
      const rejectCount = issues.filter((i) => i.severity === "reject").length;
      const warnCount = issues.filter((i) => i.severity === "warning").length;
      this.logger.warn(
        `generate: quality validation passed=${goodCases.length}, rejected=${rejectCount}, warnings=${warnCount}`,
      );
    }

    // If all cases were rejected, fall back to single-shot as safety net
    if (goodCases.length === 0) {
      this.logger.warn("generate: all test cases rejected by quality validator, falling back to single-shot generation");
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

    const result = await this.withStreamTag("[Generator:tests:single-shot]", () =>
      this.llm.generateText(prompt, systemPrompt ?? "")
    );
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
    return TestCaseGenerator.normalizeStructuredTestCaseRecords(allCases);
  }

  static normalizeStructuredTestCaseRecords(
    cases: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    const normalized = TestCaseGenerator.normalizeStructuredTestCaseIds(
      JSON.stringify({ test_cases: cases }),
    );
    return normalized
      ? TestCaseGenerator.parseStructuredTestCases(normalized) ?? cases
      : cases;
  }

  static mergeStructuredTestCaseRecords(
    currentCases: Array<Record<string, unknown>>,
    incomingCases: Array<Record<string, unknown>>,
  ): {
    cases: Array<Record<string, unknown>>;
    replaced: number;
    added: number;
  } {
    const merged = [...currentCases];
    const idToIndex = new Map<string, number>();
    for (let i = 0; i < merged.length; i++) {
      const id = String(merged[i].id ?? "").trim();
      if (id && !idToIndex.has(id)) idToIndex.set(id, i);
    }

    let replaced = 0;
    let added = 0;
    for (const incomingCase of incomingCases) {
      const id = String(incomingCase.id ?? "").trim();
      const existingIndex = id ? idToIndex.get(id) : undefined;
      if (existingIndex !== undefined) {
        merged[existingIndex] = incomingCase;
        replaced++;
        continue;
      }
      merged.push(incomingCase);
      if (id) idToIndex.set(id, merged.length - 1);
      added++;
    }

    return {
      cases: TestCaseGenerator.normalizeStructuredTestCaseRecords(merged),
      replaced,
      added,
    };
  }

  /**
   * Semantic deduplication of test cases that share a target constraint/ID.
   *
   * Layer 1: reuse shared semanticDeduper.findDuplicateCandidates +
   * applyDeterministicMerges — catches identical source, normalized text,
   * glossary-equivalent and high-overlap token pairs deterministically.
   *
   * Layer 2 (CJK fallback): the shared tokenize() collapses unsegmented CJK
   * into one token, so token_overlap is unreliable for Chinese tests. For
   * same-target pairs not already merged by layer 1, compute Jaccard over
   * CJK character bigrams (via extractContentTerms) and merge when ≥ 0.7.
   * Field completeness breaks ties: the case with more non-empty required
   * fields survives.
   *
   * Returns the de-duplicated case list (order preserved).
   */
  static _dedupTestCases(
    cases: Array<Record<string, unknown>>,
    requirementJson?: Record<string, unknown>,
  ): Array<Record<string, unknown>> {
    if (cases.length < 2) return cases;

    const getId = (tc: Record<string, unknown>, i: number) => String(tc.id ?? `idx-${i}`).trim();
    const getText = (tc: Record<string, unknown>) => {
      const steps = Array.isArray(tc.steps) ? (tc.steps as string[]).map(String) : [];
      return [String(tc.title ?? ""), ...steps, String(tc.expected_result ?? "")].join(" ");
    };
    // NOTE: getSourceText is intentionally omitted from config. Many test
    // cases legitimately share the same target constraint ID; passing `target`
    // as sourceText would collapse ALL same-target tests via the
    // same_source layer (score 1.0). Same-target near-dupes are handled
    // by the explicit CJK bigram fallback in Layer 2 below.
    const config: DedupConfig<Record<string, unknown>> = {
      items: cases,
      getId,
      getText,
    };

    const candidates = findDuplicateCandidates(config);
    const { kept: layer1Kept, merged: layer1Merged } = applyDeterministicMerges(cases, candidates, config);

    // Collect the survivor set after layer 1.
    const survivors: Array<Record<string, unknown>> = [...layer1Kept, ...layer1Merged.map((g) => g.survivors[0])];
    if (survivors.length < 2) return survivors;

    // Layer 2: CJK bigram Jaccard fallback for same-target pairs.
    const REQUIRED_FIELDS = ["title", "steps", "expected_result", "preconditions", "target"];
    const fieldScore = (tc: Record<string, unknown>) =>
      REQUIRED_FIELDS.reduce((acc, f) => {
        const v = tc[f];
        const present = Array.isArray(v) ? v.length > 0 : !!v && String(v).trim() !== "";
        return acc + (present ? 1 : 0);
      }, 0);

    // Resolve target key: when requirementJson is provided, use
    // RequirementIndex.idMapFor("constraint") to normalize displayId→canonicalId
    // so that tests targeting the same constraint via different ID forms match.
    // Fallback: simple string comparison on tc.target.
    let constraintIdMap: Map<string, string> | null = null;
    if (requirementJson) {
      const ri = RequirementIndex.fromRequirementJson(requirementJson);
      constraintIdMap = ri.idMapFor("constraint");
    }
    const getTargetKey = (tc: Record<string, unknown>): string => {
      const raw = String(tc.target ?? "").trim();
      if (!constraintIdMap || constraintIdMap.size === 0) return raw;
      // Try each displayId→canonicalId mapping; if any matches, return canonicalId
      for (const [dispId, canonId] of constraintIdMap) {
        if (raw.includes(dispId)) return canonId;
      }
      // Also try constraint canonical ID extraction from the raw string
      const m = raw.match(/CON_[A-Za-z0-9_]+/);
      if (m) return m[0];
      return raw;
    };

    const absorbed = new Set<string>();
    const ids = survivors.map((tc, i) => getId(tc, i));
    const targetKeys = survivors.map((tc) => getTargetKey(tc));
    for (let i = 0; i < survivors.length; i++) {
      if (absorbed.has(ids[i])) continue;
      const aTerms = extractContentTerms(getText(survivors[i]));
      if (aTerms.size === 0) continue;
      for (let j = i + 1; j < survivors.length; j++) {
        if (absorbed.has(ids[j])) continue;
        // Only compare tests that share the same target (by normalized ID set,
        // so a displayId test and a canonicalId test for one constraint match).
        if (targetKeys[i] !== targetKeys[j]) continue;
        const bTerms = extractContentTerms(getText(survivors[j]));
        if (bTerms.size === 0) continue;
        const sim = jaccard(aTerms, bTerms);
        if (sim >= 0.7) {
          // Break ties by field completeness; keep the more complete case.
          const loser = fieldScore(survivors[i]) >= fieldScore(survivors[j]) ? j : i;
          absorbed.add(ids[loser]);
        }
      }
    }

    if (absorbed.size === 0) return survivors;
    return survivors.filter((_tc, i) => !absorbed.has(ids[i]));
  }

  static buildTestContract(requirementJson: Record<string, unknown>): string {
    // 只暴露 displayId（或短式 id），不再暴露 canonicalId 哈希（FUN_/CON_/EXC_），
    // 避免 LLM 对同一约束同时生成 displayId 与 canonicalId 两套测试并混淆标签。
    const functions = BaseGenerator.formatContractList(
      BaseGenerator.itemsWithSafeDisplayId(requirementJson.functions),
      ["displayId", "name", "description"],
    );
    const exceptions = BaseGenerator.formatContractList(
      BaseGenerator.itemsWithSafeDisplayId(requirementJson.exceptions),
      ["displayId", "description", "trigger"],
    );
    const constraints = BaseGenerator.formatContractList(
      BaseGenerator.itemsWithSafeDisplayId(requirementJson.constraints),
      ["displayId", "description", "source_text", "related_functions"],
    );

    return [
      "## 测试生成合同（硬性约束）",
      "以下 ID 是唯一可信来源。测试对象和测试步骤只能引用这些真实 ID，禁止重新编号或改前缀。",
      functions.length > 0 ? `### 必须覆盖的功能 ID\n${functions.map((item) => `- ${item}`).join("\n")}` : "",
      exceptions.length > 0 ? `### 必须覆盖的异常 ID\n${exceptions.map((item) => `- ${item}`).join("\n")}` : "",
      constraints.length > 0 ? `### 必须覆盖的约束 ID（source_text 是断言基线）\n${constraints.map((item) => `- ${item}`).join("\n")}` : "",
      "- 每个功能 ID 至少出现在一个测试对象（target）中。",
      "- 每个异常 ID 至少出现在一个异常测试的测试对象或测试步骤中。",
      "- 如果异常 ID 是 X001，就必须写 X001；禁止改写为 E001。",
      constraints.length > 0 ? "- **每个约束 ID 必须至少出现在一个边界/约束测试的 target 字段中**，且 target 格式必须为 `<C编号> <约束描述前 30 字>`（例：`C003 复制的密码 10 秒后自动清除`）。约束的 source_text 是测试 expected_result 的断言基线——expected_result 必须验证 source_text 中的具体参数（算法/密钥长度/时限/数量限制等），禁止把约束测试写成普通功能流程。" : "",
      constraints.length > 0 ? "- **参数保真（关键）**：约束测试的 steps 与 expected_result 必须逐字使用 source_text 中的算法名、数值、单位、限制值。例如 N001 的 source_text 含 \"AES/Rijndael (256-bit key)\" 时，测试 expected_result 应写 \"数据库以 AES 256-bit 密钥加密\"，不能泛化为 \"数据库加密\"。" : "",
      constraints.length > 0 ? "- **测试只能引用 design 里出现过的术语**：测试的 target/steps/expected_result 中提到的算法名、产品代号、版本号、机制名，**必须**已经出现在上方「系统设计」的 `## 约束实现` 或 `## 异常实现` 段落中。**严禁虚构**：禁止写出像 `CON_FUNC_xxx`、`E3K31 加密算法`、`KDB_K28M 加密算法` 这类 design/analysis 里**从未出现**的代号或机制名。如果某条约束在 design 里只描述到 \"AES 加密\" 这个层级，你的测试也只能停在这个层级——不允许凭空发明新概念。" : "",
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
