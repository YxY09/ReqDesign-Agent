/**
 * Benchmark v2 — Direct-LLM baseline runner.
 *
 * A *strong* baseline: give the LLM a carefully-crafted SINGLE-turn prompt and
 * let it produce a complete design in one shot. This is what a smart person
 * would do with one conversation turn — NOT the Agent's multi-stage pipeline
 * (analyze → design → diagrams → tests → review → repair). The baseline's
 * strength comes ONLY from prompt quality (explicit requirements + output
 * schema + quality guidance); it deliberately gets NO pipeline scaffolding.
 *
 * The resulting artifacts are written in the SAME on-disk layout the Agent
 * produces (requirement/analysis.json, design/system_design.md,
 * diagrams/*.mmd, tests/test_cases.json) so the SAME {@link judgeAgainstGold}
 * scorer can grade both sides symmetrically.
 *
 * Output schema (single LLM response, JSON):
 *   {
 *     "reasoning":            "<optional private thinking — not graded>",
 *     "requirement_analysis": <analysis.json object>,
 *     "system_design":        "<markdown>",
 *     "diagrams":             { "<name>": "<mermaid src>", ... },  // ≥3 expected
 *     "test_cases":           [ { id, title, target, steps[], expected_result }, ... ]
 *   }
 *
 * The prompt instructs: cover ALL constraints, handle exceptions, make design
 * decisions concrete, align tests to constraints — but gives no staged process.
 *
 * @module benchmark/baselineRunner
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentConfig } from "../config.js";
import { LLMClient } from "../llmClient.js";
import { setupLogger } from "../logger.js";
import { buildMatrix } from "../shared/traceabilityMatrix.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The structured single-turn output the baseline LLM must produce. */
export interface BaselineOutput {
  /** Optional private thinking — NOT graded, kept only for audit. */
  reasoning?: string;
  /** The requirement/analysis.json object (actors/functions/entities/constraints/...). */
  requirement_analysis: Record<string, unknown>;
  /** The design/system_design.md content (markdown). */
  system_design: string;
  /** Diagram name → mermaid source (≥3 expected: class, activity, state). */
  diagrams: Record<string, string>;
  /** Test cases aligned to the constraints / exceptions. */
  test_cases: BaselineTestCase[];
}

/** One test case in the baseline output. */
export interface BaselineTestCase {
  id?: string;
  title?: string;
  target?: string;
  steps?: string[];
  expected_result?: string;
  [k: string]: unknown;
}

/** Result of {@link runBaseline}. */
export interface BaselineRunResult {
  case_id: string;
  output_dir: string;
  /** Raw LLM response text (for debugging truncation). */
  raw_response: string;
  /** Whether the structured output parsed successfully. */
  parsed: boolean;
  /** Parse error message when `parsed === false`. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Prompt construction (strong but NO pipeline scaffolding)
// ---------------------------------------------------------------------------

/**
 * Build the single-turn baseline prompt. It is "strong" (explicit deliverables
 * + output schema + quality guidance) but contains NO mention of a staged
 * analyze→design→diagrams→tests→review→repair process — otherwise the
 * comparison would be unfair to the baseline (it would be using the Agent's
 * mechanism).
 */
export function buildBaselinePrompt(params: {
  caseId: string;
  requirementText: string;
}): string {
  const { caseId, requirementText } = params;
  const lines: string[] = [];
  lines.push("# 任务：从需求文档推导完整的系统设计");
  lines.push("");
  lines.push(`Case: ${caseId}`);
  lines.push("");
  lines.push("在这一次响应中，你是一名资深系统架构师，请基于下面的需求文档，直接产出一份**完整且具体**的系统设计。");
  lines.push("你的目标是：在不依赖任何外部工具、多阶段流程或评审修复机制的前提下，仅凭这一次对话尽力把设计做到最好。");
  lines.push("");
  lines.push("## 质量要求（重要）");
  lines.push("- **覆盖全部约束**：需求中出现的每一条业务约束/数值限制/状态规则，都要在系统设计里有对应的、可被测试的具体处理规则，而不能只复述约束编号。");
  lines.push("- **处理异常**：需求中明确的异常/失败流程（触发条件 + 处理方式）必须在设计中给出具体的检测与处置行为。");
  lines.push("- **设计决策要具体**：给出可落地的服务/模块、字段、状态机、校验规则与触发条件，避免“设计了 XX 模块”这类空泛表述。");
  lines.push("- **测试要对齐约束**：测试用例必须针对约束与异常编写，给出可断言的“输入→预期结果”，而不是泛泛的“验证功能正常”。");
  lines.push("");
  lines.push("## 交付物（一次响应中全部产出，按以下结构组织）");
  lines.push("1. **requirement_analysis**：结构化需求分析对象（用原始需求语言），覆盖 角色 / 功能 / 实体 / 约束 / 异常 / 关键流程。");
  lines.push("2. **system_design**：系统设计（Markdown），包含 架构概览、核心模块/服务、关键数据模型、状态流转、校验与拦截规则、异常处理策略。");
  lines.push("   - 其中必须包含一个 **## 约束覆盖矩阵** 小节（Markdown 表格），对识别到的每一条约束列出：约束ID（如 C001、C002）、约束描述（一句话）、实现模块/类、触发条件、处理行为。约束ID 要与 requirement_analysis.constraints 中使用的编号一致，实现模块/类要与上文核心模块/服务中出现的名称保持一致。");
  lines.push("3. **diagrams**：至少 3 个 Mermaid 图（class_diagram 类图、activity_diagram 关键流程活动图、state_diagram 关键状态机图），键为图名、值为 Mermaid 源码。");
  lines.push("4. **test_cases**：测试用例数组，每条包含 id/title/target（针对哪个约束或异常）/steps（步骤数组）/expected_result（可断言的预期结果），覆盖约束边界与异常路径。");
  lines.push("");
  lines.push("## 原始需求文档");
  lines.push("```");
  lines.push(requirementText);
  lines.push("```");
  lines.push("");
  lines.push("## 输出格式（仅输出一个 JSON 对象，不要输出其它内容，不要使用多轮或多阶段流程）");
  lines.push("```json");
  lines.push("{");
  lines.push('  "reasoning": "<可选：你的内部分析，不会被评分>",');
  lines.push('  "requirement_analysis": {');
  lines.push('    "actors": ["..."],');
  lines.push('    "functions": ["..."],');
  lines.push('    "entities": ["..."],');
  lines.push('    "constraints": ["..."],');
  lines.push('    "exceptions": ["..."]');
  lines.push('  },');
  lines.push('  "system_design": "<Markdown 系统设计，含架构/模块/数据模型/状态流转/校验规则/异常处理，并包含一个 ## 约束覆盖矩阵 表格：约束ID | 约束描述 | 实现模块/类 | 触发条件 | 处理行为>",');
  lines.push('  "diagrams": {');
  lines.push('    "class_diagram": "classDiagram\\n  ...",');
  lines.push('    "activity_diagram": "flowchart TD\\n  ...",');
  lines.push('    "state_diagram": "stateDiagram-v2\\n  ..."');
  lines.push('  },');
  lines.push('  "test_cases": [');
  lines.push('    {');
  lines.push('      "id": "TC-...",');
  lines.push('      "title": "...",');
  lines.push('      "target": "<针对的约束或异常>",');
  lines.push('      "steps": ["..."],');
  lines.push('      "expected_result": "<可断言的预期结果>"');
  lines.push('    }');
  lines.push('  ]');
  lines.push("}");
  lines.push("```");
  return lines.join("\n");
}

/** System prompt: senior systems architect. */
export const BASELINE_SYSTEM_PROMPT =
  "你是一名资深系统架构师，擅长从需求文档推导系统设计。你会在一次响应中产出完整、具体、可测试的设计与测试，" +
  "覆盖所有约束与异常，并给出可落地的设计决策。只输出一个 JSON 对象。";

// ---------------------------------------------------------------------------
// Fairness guard — the prompt must NOT leak the Agent's pipeline structure
// ---------------------------------------------------------------------------

/**
 * Phrases that would reveal the Agent's multi-stage scaffolding. The baseline
 * prompt must avoid them so the comparison stays fair: if the Agent still wins,
 * the multi-stage mechanism has real value rather than just being name-dropped.
 *
 * Matches against the lowercased prompt + system prompt. Word-boundary variants
 * only — we don't want to ban the ordinary word "test" inside "test_cases".
 */
const SCAFFOLDING_PHRASES: readonly { phrase: string; note: string }[] = [
  { phrase: "analyze → design", note: "stage sequence" },
  { phrase: "design → diagrams", note: "stage sequence" },
  { phrase: "diagrams → tests", note: "stage sequence" },
  { phrase: "tests → review", note: "stage sequence" },
  { phrase: "review → repair", note: "stage sequence" },
  { phrase: "multi-stage", note: "staged process" },
  { phrase: "pipeline", note: "pipeline mention" },
  { phrase: "scaffold", note: "scaffold mention" },
  { phrase: "repair phase", note: "repair stage" },
  { phrase: "review phase", note: "review stage" },
];

/**
 * Assert the baseline prompt does NOT leak pipeline scaffolding. Returns the
 * list of violations (empty = fair). Exposed for tests.
 */
export function findScaffoldingLeaks(prompt: string, system: string): string[] {
  const haystack = `${prompt}\n${system}`.toLowerCase();
  const leaks: string[] = [];
  for (const { phrase, note } of SCAFFOLDING_PHRASES) {
    if (haystack.includes(phrase)) leaks.push(`'${phrase}' (${note})`);
  }
  return leaks;
}

// ---------------------------------------------------------------------------
// Response parsing (defensive — partial output is still written, flagged)
// ---------------------------------------------------------------------------

/**
 * Parse a single LLM response into a {@link BaselineOutput}. Defensive: never
 * throws — strips ```json fences, extracts the largest balanced {...} block,
 * and tolerates a truncated tail. Returns `{ parsed: false }` on total failure
 * so the caller can still record what the LLM emitted.
 */
export function parseBaselineResponse(raw: string): { parsed: true; output: BaselineOutput } | { parsed: false; error: string } {
  const text = stripCodeFences(String(raw ?? "")).trim();
  if (!text) return { parsed: false, error: "empty response" };

  // Try a direct JSON.parse first (the happy path when the model obeys).
  try {
    const obj = JSON.parse(text) as unknown;
    return { parsed: true, output: coerceOutput(obj) };
  } catch {
    // fall through to balanced-brace extraction
  }

  const extracted = extractLargestJsonObject(text);
  if (extracted === null) {
    return { parsed: false, error: "no parseable JSON object found in response" };
  }
  try {
    const obj = JSON.parse(extracted) as unknown;
    return { parsed: true, output: coerceOutput(obj) };
  } catch (err: unknown) {
    return {
      parsed: false,
      error: `JSON parse failed after extraction: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Strip a leading ``` / ```json fence if present. */
function stripCodeFences(text: string): string {
  let t = text.trim();
  const fence = /^```(?:json)?\s*\n?/i;
  if (fence.test(t)) {
    t = t.replace(fence, "");
    // Remove a trailing fence.
    t = t.replace(/\n?```\s*$/s, "");
  }
  return t;
}

/**
 * Extract the largest balanced top-level `{...}` object from `text`. Handles
 * strings with escaped quotes so braces inside strings don't break the scan.
 * Returns `null` when no balanced object is found.
 */
function extractLargestJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  // Truncated object (unbalanced) — best effort: return from start to end.
  return text.slice(start);
}

/** Coerce an unknown parsed value into a {@link BaselineOutput} shape. */
function coerceOutput(value: unknown): BaselineOutput {
  const rec = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const diagrams = rec.diagrams && typeof rec.diagrams === "object"
    ? Object.fromEntries(
        Object.entries(rec.diagrams as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string")
          .map(([k, v]) => [k, v as string]),
      )
    : {};
  const testCases = Array.isArray(rec.test_cases)
    ? rec.test_cases.filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
    : [];
  return {
    reasoning: typeof rec.reasoning === "string" ? rec.reasoning : undefined,
    requirement_analysis:
      rec.requirement_analysis && typeof rec.requirement_analysis === "object"
        ? (rec.requirement_analysis as Record<string, unknown>)
        : {},
    system_design: typeof rec.system_design === "string" ? rec.system_design : "",
    diagrams,
    test_cases: testCases as BaselineTestCase[],
  };
}

// ---------------------------------------------------------------------------
// Baseline → matrix normalization (fairness: align key-space with the agent)
// ---------------------------------------------------------------------------

interface LooseItem {
  /** Original id stripped from the loose string (e.g. "N001", "F001"), or "". */
  id: string;
  /** The human-readable name/description text. */
  text: string;
}

/**
 * Coerce one loose baseline item (string or partial object) into `{id, text}`.
 *
 * Recognizes, in priority order:
 *   - objects with description/text/name (+ optional id)
 *   - `"N001: description"` / `"F001：name"` (leading id + separator)
 *   - `"Register (F001)"` (trailing paren id → kept as id, stripped from text)
 *   - bare text (no id)
 */
function normalizeStringItem(raw: unknown): LooseItem | null {
  if (raw !== null && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    const text = String(rec.description ?? rec.text ?? rec.name ?? "").trim();
    const id = String(rec.id ?? rec.displayId ?? "").trim();
    if (text || id) return { id, text };
    return null;
  }
  const s = String(raw ?? "").trim();
  if (!s) return null;

  const led = s.match(/^\s*([A-Z]{1,3}\d{1,4})\s*[:：、]\s*(.+)$/);
  if (led) return { id: led[1], text: led[2].trim() };

  const embedded = s.match(/\b([A-Z]{1,3}\d{1,4})\b/);
  const text = s.replace(/\s*\(([A-Z]{1,3}\d{1,4})\)\s*$/, "").trim();
  return { id: embedded ? embedded[1] : "", text };
}

function normalizeStringItems(val: unknown): LooseItem[] {
  if (!Array.isArray(val)) return [];
  const out: LooseItem[] = [];
  for (const raw of val) {
    const item = normalizeStringItem(raw);
    if (item) out.push(item);
  }
  return out;
}

/**
 * Rewrite loose id tokens in a test-case target using an oldId→displayId map.
 * Tokens not in the map are left untouched.
 */
function rewriteTarget(target: string, idMap: Map<string, string>): string {
  if (!target || idMap.size === 0) return target;
  return String(target).replace(/\b([A-Z]{1,3}\d{1,4})\b/g, (m, g1) => idMap.get(g1) ?? m);
}

/**
 * Heuristically link a constraint to the baseline functions whose name/keywords
 * appear in the constraint text. Mirrors the agent's
 * {@link constraintCanonicalizer.linkFunctions} keyword pass, but adapted to the
 * baseline's single-turn output (loose strings, no canonical ids): it emits
 * `related_functions` as **displayId strings** (F001/F002…) so that
 * {@link buildMatrix} can bridge constraint → function → module on tier 2.
 *
 * Matching rules (intentionally lenient, like the agent's 0.7-confidence pass):
 *   - the full lowercased function name is a substring of the constraint text, OR
 *   - any significant (>3 chars) token of the function name (split on
 *     spaces / camelCase / underscores) appears in the constraint text.
 *
 * Returns an array of displayIds. May be empty (a real possibility for a
 * single-turn baseline — that is what makes the comparison fair: a baseline
 * with weak constraint↔function linking will also score lower on
 * traceability, truthfully reflecting its quality).
 *
 * Exposed for tests.
 */
export function linkBaselineFunctions(
  constraintText: string,
  functions: Array<{ displayId: string; name: string }>,
): string[] {
  const text = String(constraintText ?? "").toLowerCase();
  if (!text || functions.length === 0) return [];

  const linked: string[] = [];
  for (const fn of functions) {
    const name = String(fn.name ?? "").trim();
    if (!name) continue;
    const nameLower = name.toLowerCase();

    let matched = false;

    // CJK function names: extract ≥2-char consecutive CJK substrings (bigrams)
    // from each maximal CJK run and check if any appear in the constraint text.
    // Single-CJK-char names are too ambiguous, so runs of length 1 contribute
    // nothing. This mirrors the CJK bigram approach in shared/testAlignment.ts.
    if (/[\u4e00-\u9fff]/.test(name)) {
      const cjkRuns = name.match(/[\u4e00-\u9fff]+/g) ?? [];
      for (const run of cjkRuns) {
        if (run.length < 2) continue;
        for (let i = 0; i <= run.length - 2; i++) {
          if (text.includes(run.slice(i, i + 2))) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      // Fallback: full CJK name (≥2 chars) appears verbatim in constraint.
      if (!matched && name.length >= 2) {
        matched = text.includes(nameLower);
      }
    } else {
      // English: split on whitespace, camelCase boundaries and underscores;
      // drop short tokens (<4 chars).
      const tokens = name
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 3);

      matched =
        (nameLower.length > 0 && text.includes(nameLower)) ||
        tokens.some((t) => text.includes(t));
    }

    if (matched && !linked.includes(fn.displayId)) {
      linked.push(fn.displayId);
    }
  }
  return linked;
}

/**
 * Normalize the baseline's loose `requirement_analysis` (string arrays like
 * `["N001: AES encryption"]`, `["Register (F001)"]`, `["Invalid key"]`) into
 * the object shape {@link buildMatrix} expects (constraints/functions/exceptions
 * carrying `displayId` + `description`/`name`), aligned to the agent's C/F/X
 * displayId scheme.
 *
 * The baseline prompt deliberately emits loose strings (no staged
 * canonicalization), so without this alignment buildMatrix — which keys on
 * `C\d{3}`/`F\d{3}`/`X\d{3}` — would yield an all-empty matrix and the
 * comparison would remain unfair (just in the opposite direction: traceability
 * stuck at 0).
 *
 * - Constraints get C001/C002… in source order (any leading old id is mapped).
 * - Functions keep an embedded F-id when present, else get F001/F002…
 * - Exceptions get X001/X002…
 *
 * Returns the normalized analysis plus an oldId→displayId map so callers can
 * rewrite test-case `target` tokens to the new displayIds.
 */
export function normalizeBaselineAnalysisForMatrix(analysis: Record<string, unknown>): {
  normalized: Record<string, unknown>;
  idMap: Map<string, string>;
} {
  const idMap = new Map<string, string>();
  const constraints = normalizeStringItems(analysis["constraints"]);
  const functions = normalizeStringItems(analysis["functions"]);
  const exceptions = normalizeStringItems(analysis["exceptions"]);

  // Keep the original constraint text around so we can keyword-match it
  // against function names AFTER the function displayIds are known.
  const cOut: Record<string, unknown>[] = [];
  const cRawText: string[] = [];
  let cCounter = 1;
  for (const { id, text } of constraints) {
    const displayId = `C${String(cCounter++).padStart(3, "0")}`;
    if (id) idMap.set(id, displayId);
    cOut.push({ id: id || displayId, displayId, description: text });
    cRawText.push(text);
  }

  const fOut: Record<string, unknown>[] = [];
  const usedFids = new Set<string>();
  let fCounter = 1;
  const nextFid = (): string => {
    while (usedFids.has(`F${String(fCounter).padStart(3, "0")}`)) fCounter++;
    const displayId = `F${String(fCounter++).padStart(3, "0")}`;
    return displayId;
  };
  for (const { id, text } of functions) {
    let displayId: string;
    if (id && /^F\d{3}$/.test(id) && !usedFids.has(id)) {
      displayId = id;
    } else {
      displayId = nextFid();
      if (id && !/^F\d{3}$/.test(id)) idMap.set(id, displayId);
    }
    usedFids.add(displayId);
    fOut.push({ id: displayId, displayId, name: text });
  }

  // --- related_functions: link each constraint to the functions whose name/
  // keywords appear in the constraint text. This is the bridge that lets
  // buildMatrix tier-2 (constraint → function → module) populate
  // constraintToDesign for the baseline — putting it on the SAME key-space as
  // the agent (whose constraints carry related_functions from
  // constraintCanonicalizer.linkFunctions). Emitted as displayId strings so
  // resolveDisplayFunctionId keys them directly. May be empty when no function
  // name overlaps the constraint text (fair: weak linking → low traceability).
  const fnLinkInputs = fOut.map((f) => ({
    displayId: String(f.displayId ?? ""),
    name: String(f.name ?? ""),
  }));
  cOut.forEach((c, idx) => {
    const related = linkBaselineFunctions(cRawText[idx] ?? "", fnLinkInputs);
    if (related.length > 0) c["related_functions"] = related;
  });

  const xOut: Record<string, unknown>[] = [];
  let xCounter = 1;
  for (const { id, text } of exceptions) {
    const displayId = `X${String(xCounter++).padStart(3, "0")}`;
    if (id) idMap.set(id, displayId);
    xOut.push({ id: id || displayId, displayId, description: text });
  }

  const normalized: Record<string, unknown> = { ...analysis };
  normalized["constraints"] = cOut;
  normalized["functions"] = fOut;
  normalized["exceptions"] = xOut;
  return { normalized, idMap };
}

// ---------------------------------------------------------------------------
// Artifact writing (Agent-aligned layout)
// ---------------------------------------------------------------------------

/**
 * Write the parsed baseline output into an Agent-aligned directory layout so
 * the SAME {@link judgeAgainstGold} scorer can grade both sides:
 *
 *   {outputDir}/
 *   ├── requirement/analysis.json
 *   ├── design/system_design.md
 *   ├── diagrams/<name>.mmd        (only non-empty diagrams)
 *   └── tests/test_cases.json      ({ test_cases: [...] })
 *
 * Defensive: writes whatever parsed (even if incomplete) so a truncated
 * baseline still produces a scannable (if failing) artifact set.
 */
export function writeBaselineArtifacts(outputDir: string, output: BaselineOutput): void {
  const requirementDir = join(outputDir, "requirement");
  const designDir = join(outputDir, "design");
  const diagramsDir = join(outputDir, "diagrams");
  const testsDir = join(outputDir, "tests");
  mkdirSync(requirementDir, { recursive: true });
  mkdirSync(designDir, { recursive: true });
  mkdirSync(diagramsDir, { recursive: true });
  mkdirSync(testsDir, { recursive: true });

  writeFileSync(
    join(requirementDir, "analysis.json"),
    JSON.stringify(output.requirement_analysis ?? {}, null, 2),
    "utf8",
  );
  writeFileSync(
    join(designDir, "system_design.md"),
    String(output.system_design ?? ""),
    "utf8",
  );
  for (const [name, src] of Object.entries(output.diagrams ?? {})) {
    if (src && String(src).trim()) {
      const safe = name.replace(/[^A-Za-z0-9_-]/g, "_");
      writeFileSync(join(diagramsDir, `${safe}.mmd`), String(src), "utf8");
    }
  }
  writeFileSync(
    join(testsDir, "test_cases.json"),
    JSON.stringify({ test_cases: output.test_cases ?? [] }, null, 2),
    "utf8",
  );

  // --- Traceability matrix (audit artifact, not scoring prerequisite) ---
  // The quality judge now uses a content-based traceability formula
  // (has_concrete_rule && has_test_alignment) so this matrix does NOT affect
  // the traceability_truthfulness score. It is generated for audit/inspection:
  // the compare report can show which constraints the baseline linked to which
  // design elements, and judgeTraceChain() still evaluates chain truthfulness
  // and stores it on each verdict for debugging. Best-effort: a failed matrix
  // build must NOT invalidate the artifact set.
  try {
    const { normalized, idMap } = normalizeBaselineAnalysisForMatrix(
      output.requirement_analysis ?? {},
    );
    const rewrittenTests = (output.test_cases ?? []).map((tc) => ({
      ...tc,
      target: tc.target ? rewriteTarget(String(tc.target), idMap) : tc.target,
    }));
    const matrix = buildMatrix(
      normalized,
      String(output.system_design ?? ""),
      JSON.stringify({ test_cases: rewrittenTests }),
    );
    const tracesDir = join(outputDir, "traces");
    mkdirSync(tracesDir, { recursive: true });
    writeFileSync(
      join(tracesDir, "traceability_matrix.json"),
      JSON.stringify(matrix, null, 2),
      "utf8",
    );
  } catch {
    // Ignore — the rest of the artifact set is still valid for judging.
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the direct-LLM baseline for one case.
 *
 *   1. Read the requirement `.md`.
 *   2. Build the single-turn strong prompt (no scaffolding).
 *   3. Call the configured LLM provider ONCE (same provider as the Agent).
 *   4. Parse + write the Agent-aligned artifacts under `outputDir`.
 *
 * Never throws on parse/truncation — writes whatever parsed and flags
 * `parsed: false` so the compare runner can score it as 0 honestly.
 *
 * @param config    Agent config (uses `config.llm` provider/model — fair).
 * @param casePath  Path to the case `.md` requirement file.
 * @param outputDir Where to write the Agent-aligned artifacts.
 * @param llm       Optional injected LLM client (test hook; defaults to a real
 *                  {@link LLMClient} built from `config`).
 */
export async function runBaseline(params: {
  config: AgentConfig;
  casePath: string;
  outputDir: string;
  llm?: { generateJson(prompt: string, system?: string): Promise<Record<string, unknown>> };
}): Promise<BaselineRunResult> {
  const { config, casePath, outputDir } = params;
  const logger = setupLogger("reqdesign.benchmark.baseline");
  const caseId = caseIdFromPath(casePath);

  if (!existsSync(casePath)) {
    throw new Error(`baseline case file not found: ${casePath}`);
  }
  const requirementText = readFileSync(casePath, "utf8");
  const prompt = buildBaselinePrompt({ caseId, requirementText });

  const leaks = findScaffoldingLeaks(prompt, BASELINE_SYSTEM_PROMPT);
  if (leaks.length > 0) {
    // Defensive: should never fire (the prompt is authored here). Surface it
    // loudly so a future edit cannot silently break the fairness guarantee.
    throw new Error(`baseline prompt leaked pipeline scaffolding: ${leaks.join(", ")}`);
  }

  const llm = params.llm ?? new LLMClient(config);
  let rawResponse: Record<string, unknown>;
  try {
    rawResponse = await llm.generateJson(prompt, BASELINE_SYSTEM_PROMPT);
  } catch (err: unknown) {
    // LLM failure: still return a result so the compare runner records it.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`baseline LLM call failed for ${caseId}: ${message}`);
    return {
      case_id: caseId,
      output_dir: outputDir,
      raw_response: "",
      parsed: false,
      error: `llm error: ${message}`,
    };
  }

  // The LLMClient.generateJson already parses JSON, but the model may have
  // returned an object with stringified nested fields or a truncated body.
  // Re-serialize to text so parseBaselineResponse's extraction can rescue it.
  const rawText = JSON.stringify(rawResponse);

  const parsed = parseBaselineResponse(rawText);

  if (parsed.parsed) {
    writeBaselineArtifacts(outputDir, parsed.output);
    return {
      case_id: caseId,
      output_dir: outputDir,
      raw_response: rawText,
      parsed: true,
    };
  }

  // Best effort: write whatever we got so the sanity/judge gates run honestly
  // (they will report an incomplete artifact set → low/zero quality).
  writeBaselineArtifacts(outputDir, {
    requirement_analysis: {},
    system_design: "",
    diagrams: {},
    test_cases: [],
  });
  return {
    case_id: caseId,
    output_dir: outputDir,
    raw_response: rawText,
    parsed: false,
    error: parsed.error,
  };
}

/** Derive a case id from a `.md` path (filename without extension). */
function caseIdFromPath(casePath: string): string {
  const base = casePath.split(/[/\\]/).pop() ?? casePath;
  return base.replace(/\.md$/i, "");
}
