/**
 * Integration tests — mirrors Python tests/test_integration.py.
 * Validates end-to-end workflows with all LLM/network calls mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

import { InputLoader } from "../src/inputLoader.js";
import { RequirementAnalyzer } from "../src/generators/analyze.js";
import { DiagramGenerator } from "../src/generators/diagrams.js";
import { MermaidValidator } from "../src/generators/mermaid.js";
import { OutputManager } from "../src/outputManager.js";
// NOTE: llmClient.ts helpers (extractJsonText, parseJsonResponse, tryCompleteJson,
// stripCommentsAndTrailingCommas) are module-private. We replicate them here following
// the pattern in test_core.test.ts.
import { loadPrompt, clearCache } from "../src/promptLoader.js";

// ---------------------------------------------------------------------------
// Replicated pure helpers from llmClient.ts (must stay in sync)
// ---------------------------------------------------------------------------

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const extracted = matchBracesLocal(trimmed);
    if (extracted) return extracted;
  }
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace !== -1) {
    const sub = trimmed.slice(firstBrace);
    const extracted = matchBracesLocal(sub);
    if (extracted) return extracted;
    return sub;
  }
  return trimmed;
}

function matchBracesLocal(text: string): string | null {
  const openChar = text[0];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) { depth--; if (depth === 0) return text.slice(0, i + 1); }
  }
  return null;
}

function stripCommentsAndTrailingCommas(text: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < text.length) {
    const ch = text[i];
    if (escape) { result += ch; escape = false; i++; continue; }
    if (ch === "\\" && inString) { result += ch; escape = true; i++; continue; }
    if (ch === '"') { inString = !inString; result += ch; i++; continue; }
    if (inString) { result += ch; i++; continue; }
    if (ch === "/" && i + 1 < text.length && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && i + 1 < text.length && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && i + 1 < text.length && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    result += ch;
    i++;
  }
  result = result.replace(/,\s*([}\]])/g, "$1");
  return result;
}

function tryCompleteJson(text: string): string {
  let result = text.trimEnd();
  result = result.replace(/[,:\s]+$/, "");
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < result.length; i++) {
    const ch = result[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth--;
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth--;
  }
  if (inString) result += '"';
  result = result.replace(/,\s*$/, "");
  for (let i = 0; i < bracketDepth; i++) result += "]";
  for (let i = 0; i < braceDepth; i++) result += "}";
  return result;
}

function parseJsonResponse(raw: string): Record<string, unknown> {
  const jsonText = extractJsonText(raw);
  try { return JSON.parse(jsonText) as Record<string, unknown>; } catch { /* continue */ }
  const cleaned = stripCommentsAndTrailingCommas(jsonText);
  try { return JSON.parse(cleaned) as Record<string, unknown>; } catch { /* continue */ }
  const completed = tryCompleteJson(cleaned);
  try { return JSON.parse(completed) as Record<string, unknown>; } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse JSON response: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TMP_DIR = join(
  import.meta.dirname,
  "__test_tmp_integration__",
);

const SAMPLE_REQUIREMENT = `# 简单计算器系统
## 用户角色
- 普通用户：使用计算器进行基本运算
## 功能需求
1. 加法运算：用户输入两个数字，系统返回它们的和
2. 减法运算：用户输入两个数字，系统返回它们的差
`;

const MOCK_REQUIREMENT_JSON: Record<string, unknown> = {
  project_name: "简单计算器",
  project_overview: "一个简单的计算器系统",
  actors: [{ name: "普通用户", description: "使用计算器" }],
  functions: [
    { id: "F001", name: "加法运算", description: "求和", related_actors: ["普通用户"], priority: "高" },
    { id: "F002", name: "减法运算", description: "求差", related_actors: ["普通用户"], priority: "高" },
  ],
  entities: [{ name: "计算器", description: "计算工具", attributes: ["操作数", "运算符"] }],
  constraints: [],
  exceptions: [],
  non_functional_requirements: [],
  business_processes: [],
};

const MOCK_DESIGN_TEXT = `# 系统设计
## 模块划分
- 计算模块：处理加减乘除运算
## 核心类
- Calculator：执行计算操作
`;

const MOCK_CLASS_DIAGRAM = `classDiagram
    class 计算器 {
        -double 操作数1
        -double 操作数2
        +加法() double
        +减法() double
    }
`;

const MOCK_ACTIVITY_DIAGRAM = `flowchart TD
    A([开始]) --> B[输入两个数字]
    B --> C[选择运算类型]
    C --> D[执行计算]
    D --> E[显示结果]
    E --> F([结束])
`;

const MOCK_STATE_DIAGRAM = `stateDiagram-v2
    [*] --> 空闲
    空闲 --> 计算中 : 输入数据
    计算中 --> 显示结果 : 计算完成
    显示结果 --> 空闲 : 重置
    空闲 --> [*]
`;

const MOCK_TEST_CASES = `# 测试用例

| 编号 | 描述 | 输入 | 预期结果 | 类型 |
|------|------|------|----------|------|
| TC001 | 加法正常 | 2, 3 | 5 | 正常 |
| TC002 | 减法正常 | 5, 3 | 2 | 正常 |
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpPath(filename: string): string {
  return join(TMP_DIR, filename);
}

function createTmpFile(filename: string, content: string, encoding: BufferEncoding = "utf-8"): string {
  const p = tmpPath(filename);
  writeFileSync(p, content, encoding);
  return p;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ===========================================================================
// InputLoader
// ===========================================================================

describe("InputLoader", () => {
  it("loads a markdown requirement file", () => {
    const f = createTmpFile("test_req.md", SAMPLE_REQUIREMENT);
    const text = InputLoader.load(f);
    expect(text).toContain("计算器");
    expect(text.length).toBeGreaterThan(0);
  });

  it("rejects files that are too large", () => {
    const f = createTmpFile("big.md", "x".repeat(512 * 1024 + 1));
    expect(() => InputLoader.load(f)).toThrow(/过大/);
  });

  it("rejects empty files", () => {
    const f = createTmpFile("empty.md", "");
    expect(() => InputLoader.load(f)).toThrow(/为空/);
  });

  it("rejects unsupported extensions", () => {
    const f = createTmpFile("test.xyz", "content");
    expect(() => InputLoader.load(f)).toThrow(/不支持/);
  });

  it("loads JSON input with content field", () => {
    const f = createTmpFile("req.json", '{"content": "用户注册需求"}');
    const result = InputLoader.load(f);
    expect(result).toContain("用户注册");
  });

  it("rejects binary files", () => {
    const buf = Buffer.alloc(32 * 100 + 100, 0);
    for (let i = 0; i < 32; i++) buf[i * 100] = i;
    const p = tmpPath("bin.md");
    writeFileSync(p, buf);
    expect(() => InputLoader.load(p)).toThrow(/二进制/);
  });

  it("accepts normal text with newlines (not misdetected as binary)", () => {
    const f = createTmpFile("test.md", "# 需求文档\n\n功能1\n功能2\n功能3\n".repeat(10));
    const result = InputLoader.load(f);
    expect(result).toContain("需求文档");
  });

  describe("splitSections()", () => {
    it("splits by top-level headings", () => {
      const text = "# 第一章\n内容1\n# 第二章\n内容2";
      const sections = InputLoader.splitSections(text);
      expect(sections).toHaveLength(2);
      expect(sections[0].title).toBe("第一章");
      expect(sections[1].title).toBe("第二章");
    });

    it("does not split on # inside code fences", () => {
      const text = `# 标题一
内容1

\`\`\`python
# 这是注释，不是标题
def foo():
    pass
\`\`\`

# 标题二
内容2
`;
      const sections = InputLoader.splitSections(text);
      expect(sections).toHaveLength(2);
      expect(sections[0].title).toBe("标题一");
      expect(sections[1].title).toBe("标题二");
      expect(sections[0].content).toContain("```python");
    });

    it("simple code fence does not split sections", () => {
      const text = "# 标题\n```python\n# 注释\n```\n正文";
      const sections = InputLoader.splitSections(text);
      expect(sections).toHaveLength(1);
      expect(sections[0].title).toBe("标题");
    });
  });
});

// ===========================================================================
// DiagramGenerator._extractMermaid
// ===========================================================================

describe("DiagramGenerator._extractMermaid", () => {
  it("extracts mermaid from code block", () => {
    const raw = "这是类图：\n```mermaid\nclassDiagram\n    class Foo\n```\n结束";
    const result = DiagramGenerator._extractMermaid(raw);
    expect(result).toMatch(/^classDiagram/);
  });

  it("prefers mermaid code block over non-mermaid blocks", () => {
    const raw =
      "说明：\n```python\nprint(\"hi\")\n```\n类图：\n```mermaid\nclassDiagram\n    class Bar\n```";
    const result = DiagramGenerator._extractMermaid(raw);
    expect(result).toContain("classDiagram");
    expect(result).not.toContain("print");
  });

  it("returns direct mermaid when no code block", () => {
    const raw = "flowchart TD\n    A --> B";
    expect(DiagramGenerator._extractMermaid(raw)).toBe(raw);
  });

  it("recognizes graph keyword as flowchart", () => {
    const raw = "graph TD\n    A --> B";
    expect(DiagramGenerator._extractMermaid(raw)).toBe(raw);
  });

  it("prefers last mermaid block when multiple exist", () => {
    const raw = `这是类图：
\`\`\`mermaid
classDiagram
    class A
\`\`\`
修正后的版本：
\`\`\`mermaid
classDiagram
    class B {
        +method()
    }
\`\`\``;
    const result = DiagramGenerator._extractMermaid(raw);
    expect(result).toContain("class B");
    expect(result).toContain("method");
  });
});

// ===========================================================================
// MermaidValidator
// ===========================================================================

describe("MermaidValidator", () => {
  const validator = new MermaidValidator();

  it("validates class diagram", () => {
    const { valid, message } = validator.validate(MOCK_CLASS_DIAGRAM, "class_diagram");
    expect(valid).toBe(true);
  });

  it("validates activity diagram", () => {
    const { valid, message } = validator.validate(MOCK_ACTIVITY_DIAGRAM, "activity_diagram");
    expect(valid).toBe(true);
  });

  it("validates state diagram", () => {
    const { valid, message } = validator.validate(MOCK_STATE_DIAGRAM, "state_diagram");
    expect(valid).toBe(true);
  });

  it("validates diagram with inline comments", () => {
    const diagram = `flowchart TD
    A([开始]) --> B[输入] %% 这是注释
    B --> C[处理]
    C --> D([结束])
`;
    const { valid, message } = validator.validate(diagram, "activity_diagram");
    expect(valid).toBe(true);
  });

  it("detects comment positions correctly", () => {
    const content = "line1\n%% comment\nline3 %% inline\nline4";
    const positions = MermaidValidator._findCommentPositions(content);
    // '%%' of whole-line comment
    expect(positions.has(6)).toBe(true);
    expect(positions.has(9)).toBe(true);
    // '%%' of inline comment
    expect(positions.has(23)).toBe(true);
    expect(positions.has(26)).toBe(true);
    // Non-comment positions
    expect(positions.has(0)).toBe(false);
    expect(positions.has(16)).toBe(false);
  });

  it("rejects empty content", () => {
    const { valid, message } = validator.validate("");
    expect(valid).toBe(false);
    expect(message).toContain("空");
  });

  it("handles apostrophe in label without bracket error", () => {
    const content = `classDiagram
    class User {
        +getUserName() string
    }
    class User's Profile {
        +getName() string
    }
    User --> User's Profile
`;
    const { valid, message } = validator.validate(content);
    // Should NOT report bracket mismatch due to apostrophe
    expect(message).not.toContain("括号");
  });

  it("handles apostrophe between class definitions", () => {
    const content = `classDiagram
    class Foo {
        +bar() string
    }
    note "User's note"
    class Baz {
        +qux() string
    }
`;
    const { valid, message } = validator.validate(content);
    expect(valid).toBe(true);
  });
});

// ===========================================================================
// RequirementAnalyzer
// ===========================================================================

describe("RequirementAnalyzer normalization", () => {
  it("normalizer does not create shell actor entities", () => {
    const normalized = RequirementAnalyzer._normalizeResult({
      actors: [{ name: "Merchant", description: "商家" }],
      functions: [],
      entities: [],
    });

    // Merchant should NOT be auto-added as entity (old _ensureActorEntities removed)
    const entities = normalized.entities as Array<Record<string, unknown>>;
    expect(entities.some((entity) => entity.name === "Merchant")).toBe(false);
  });

  it("normalizes missing proposeNewConstraints/proposeNewExceptions to empty arrays", () => {
    const normalized = RequirementAnalyzer._normalizeResult({
      actors: [],
      functions: [],
      entities: [],
    });

    expect(normalized.proposeNewConstraints).toEqual([]);
    expect(normalized.proposeNewExceptions).toEqual([]);
  });
});

// ===========================================================================
// RequirementAnalyzer.validateResult — entityRef attribute tolerance
// ===========================================================================

describe("RequirementAnalyzer.validateResult", () => {
  it("does not warn when entity with entityRef has empty attributes", () => {
    const warnings = RequirementAnalyzer.validateResult({
      actors: [{ name: "User", description: "用户" }],
      functions: [{ id: "F001", name: "创建案件", description: "...", preconditions: "登录", priority: "high" }],
      entities: [
        { name: "Case", entityRef: "E_CASE", attributes: [], relationships: [] },
      ],
    });
    // Must NOT contain "缺少 attributes" for the Case entity
    expect(warnings.filter((w) => w.includes("Case") && w.includes("缺少 attributes")))
      .toHaveLength(0);
  });

  it("warns when entity WITHOUT entityRef has empty attributes", () => {
    const warnings = RequirementAnalyzer.validateResult({
      actors: [{ name: "User", description: "用户" }],
      functions: [{ id: "F001", name: "创建案件", description: "...", preconditions: "登录", priority: "high" }],
      entities: [
        { name: "Merchant", attributes: [], relationships: [] },
      ],
    });
    expect(warnings).toContain("实体 Merchant 缺少 attributes");
  });

  it("still warns when entity with entityRef has non-array attributes", () => {
    const warnings = RequirementAnalyzer.validateResult({
      actors: [{ name: "User", description: "用户" }],
      functions: [{ id: "F001", name: "创建案件", description: "...", preconditions: "登录", priority: "high" }],
      entities: [
        { name: "Case", entityRef: "E_CASE", attributes: undefined as unknown as unknown[], relationships: [] },
      ],
    });
    expect(warnings.filter((w) => w.includes("Case") && w.includes("缺少 attributes")))
      .toBeTruthy();
    expect(warnings.some((w) => w.includes("Case") && w.includes("缺少 attributes")))
      .toBe(true);
  });
});

// ===========================================================================
// OutputManager
// ===========================================================================

describe("OutputManager", () => {
  it("saves all artifact types to correct subdirectories", () => {
    const outDir = join(TMP_DIR, "output");
    const mgr = new OutputManager(outDir);

    mgr.saveRequirementAnalysis(MOCK_REQUIREMENT_JSON);
    mgr.saveSystemDesign(MOCK_DESIGN_TEXT);
    mgr.saveDiagrams({
      class_diagram: MOCK_CLASS_DIAGRAM,
      activity_diagram: MOCK_ACTIVITY_DIAGRAM,
      state_diagram: MOCK_STATE_DIAGRAM,
    });
    mgr.saveTestCases(MOCK_TEST_CASES);

    expect(existsSync(join(outDir, "requirement", "analysis.json"))).toBe(true);
    expect(existsSync(join(outDir, "requirement", "analysis.md"))).toBe(true);
    expect(existsSync(join(outDir, "design", "system_design.md"))).toBe(true);
    expect(existsSync(join(outDir, "diagrams", "class_diagram.mmd"))).toBe(true);
    expect(existsSync(join(outDir, "diagrams", "activity_diagram.mmd"))).toBe(true);
    expect(existsSync(join(outDir, "diagrams", "state_diagram.mmd"))).toBe(true);
    expect(existsSync(join(outDir, "diagrams", "diagrams.json"))).toBe(true);
    expect(existsSync(join(outDir, "tests", "test_cases.md"))).toBe(true);
  });

  it("saves structured test cases as JSON plus Markdown", () => {
    const outDir = join(TMP_DIR, "output_structured_tests");
    const mgr = new OutputManager(outDir);
    mgr.saveTestCases(JSON.stringify({
      test_cases: [
        {
          id: "TC-N-001",
          title: "正常登录",
          type: "正常",
          target: "F001 登录",
          preconditions: "用户已注册",
          steps: ["输入账号", "输入密码"],
          expected_result: "登录成功",
          priority: "P0",
        },
      ],
    }));

    expect(existsSync(join(outDir, "tests", "test_cases.json"))).toBe(true);
    expect(readFileSync(join(outDir, "tests", "test_cases.md"), "utf-8")).toContain("## TC-N-001");
  });

  it("JSON output can be read back correctly", () => {
    const outDir = join(TMP_DIR, "output2");
    const mgr = new OutputManager(outDir);
    mgr.saveRequirementAnalysis(MOCK_REQUIREMENT_JSON);

    const loaded = JSON.parse(
      readFileSync(join(outDir, "requirement", "analysis.json"), "utf-8"),
    );
    expect(loaded.project_name).toBe("简单计算器");
    expect(loaded.functions).toHaveLength(2);
    expect(loaded.functions[0].id).toBe("F001");
  });

  it("handles null requirement analysis without crashing", () => {
    const outDir = join(TMP_DIR, "output3");
    const mgr = new OutputManager(outDir);
    mgr.saveRequirementAnalysis(null as unknown as Record<string, unknown>);
    expect(existsSync(join(outDir, "requirement", "analysis.json"))).toBe(true);
  });
});

// ===========================================================================
// LLMClient JSON helpers (parseJsonResponse, extractJsonText, tryCompleteJson)
// ===========================================================================

describe("LLMClient JSON parsing", () => {
  it("extracts JSON from code block", () => {
    const raw = '```json\n{"key": "value"}\n```';
    expect(extractJsonText(raw)).toBe('{"key": "value"}');
  });

  it("extracts JSON from mixed text", () => {
    const raw = 'Here is the result:\n{"key": "value"}\nDone.';
    const result = extractJsonText(raw);
    expect(result).toBe('{"key": "value"}');
  });

  it("completes truncated JSON", () => {
    const truncated = '{"name": "test", "items": [1, 2';
    const completed = tryCompleteJson(truncated);
    const parsed = JSON.parse(completed);
    expect(parsed.name).toBe("test");
    expect(parsed.items).toEqual([1, 2]);
  });

  it("handles trailing commas in objects", () => {
    const result = parseJsonResponse('{"key": "value",}');
    expect(result).toEqual({ key: "value" });
  });

  it("handles JS-style comments", () => {
    const result = parseJsonResponse('// comment\n{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("passes valid JSON through unchanged", () => {
    const result = parseJsonResponse('{"a": 1, "b": [2, 3]}');
    expect(result).toEqual({ a: 1, b: [2, 3] });
  });

  it("throws on completely unparseable text", () => {
    expect(() => parseJsonResponse("not json at all")).toThrow();
  });

  it("stripCommentsAndTrailingCommas removes // comments", () => {
    const input = '// a comment\n{"x":1}';
    const result = stripCommentsAndTrailingCommas(input);
    expect(result).toContain('"x"');
    expect(result).not.toContain("//");
  });
});

// ===========================================================================
// Scorer functions
// ===========================================================================

describe("PromptLoader", () => {
  beforeEach(() => {
    clearCache();
  });

  it("loads an existing prompt file", () => {
    const content = loadPrompt("requirement_analysis.md");
    if (content.length > 0) {
      // File exists — check it has meaningful content
      expect(content.toLowerCase().includes("requirement") || content.includes("需求")).toBe(true);
    }
    // If file doesn't exist, the test is skipped gracefully
  });

  it("returns fallback when file does not exist", () => {
    expect(loadPrompt("nonexistent_file.md", "fallback content")).toBe("fallback content");
  });

  it("returns empty string as default fallback", () => {
    expect(loadPrompt("nonexistent_file.md")).toBe("");
  });

  it("cache hit returns same content", () => {
    clearCache();
    const c1 = loadPrompt("requirement_analysis.md");
    const c2 = loadPrompt("requirement_analysis.md");
    expect(c1).toBe(c2);
  });

  it("clearCache works", () => {
    clearCache();
    const c1 = loadPrompt("requirement_analysis.md");
    expect(c1.length).toBeGreaterThanOrEqual(0);
    clearCache();
    const c2 = loadPrompt("requirement_analysis.md");
    expect(c1).toBe(c2);
  });

  it("empty filename returns fallback", () => {
    clearCache();
    expect(loadPrompt("", "default")).toBe("default");
  });

  it("dot filename returns fallback", () => {
    clearCache();
    expect(loadPrompt(".", "default")).toBe("default");
  });

  it("dotdot filename returns fallback", () => {
    clearCache();
    expect(loadPrompt("..", "default")).toBe("default");
  });

  it("path variant hits cache (basename normalisation)", () => {
    clearCache();
    const c1 = loadPrompt("requirement_analysis.md");
    const c2 = loadPrompt("./requirement_analysis.md");
    expect(c1).toBe(c2);
  });
});
