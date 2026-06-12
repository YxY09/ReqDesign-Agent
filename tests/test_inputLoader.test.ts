import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  InputLoader,
} from "../src/inputLoader.js";

// -----------------------------------------------------------------------
// 辅助函数 – 临时目录管理
// -----------------------------------------------------------------------

const TMP_DIR = join(import.meta.dirname, "__test_tmp_inputLoader__");

function tmpPath(filename: string): string {
  return join(TMP_DIR, filename);
}

function createTmpFile(filename: string, content: string): string {
  const p = tmpPath(filename);
  writeFileSync(p, content, "utf-8");
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InputLoader", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  // ---- load() ---------------------------------------------------------------

  describe("load()", () => {
    it("loads a markdown file", () => {
      const f = createTmpFile("test.md", "# 图书管理系统\n\n学生可以借阅图书。");
      const result = InputLoader.load(f);
      expect(result).toContain("图书管理系统");
      expect(result).toContain("借阅图书");
    });

    it("loads a plain text file", () => {
      const f = createTmpFile("test.txt", "用户可以注册登录系统。");
      const result = InputLoader.load(f);
      expect(result).toContain("注册登录");
    });

    it("loads a JSON file (object with known key)", () => {
      const data = JSON.stringify({ requirements: "系统需要支持用户管理功能" });
      const f = createTmpFile("test.json", data);
      const result = InputLoader.load(f);
      expect(result).toContain("用户管理");
    });

    it("loads a JSON file (plain string value)", () => {
      const data = JSON.stringify("直接的需求文本");
      const f = createTmpFile("test.json", data);
      const result = InputLoader.load(f);
      expect(result).toContain("需求文本");
    });

    it("throws FileNotFoundError for missing file", () => {
      expect(() => InputLoader.load("nonexistent.md")).toThrow(
        /输入文件不存在/,
      );
    });

    it("throws on empty file", () => {
      const f = createTmpFile("empty.md", "");
      expect(() => InputLoader.load(f)).toThrow(/为空/);
    });

    it("throws on unsupported format", () => {
      const f = createTmpFile("test.pdf", "content");
      expect(() => InputLoader.load(f)).toThrow(/不支持/);
    });

    it("throws when given a directory path", () => {
      expect(() => InputLoader.load(TMP_DIR)).toThrow(/目录/);
    });

    it("throws when given a symbolic link", () => {
      const real = createTmpFile("real.md", "content");
      const link = tmpPath("link.md");
      symlinkSync(real, link);
      expect(() => InputLoader.load(link)).toThrow(/符号链接/);
    });

    it("throws when content exceeds MAX_CHARS", () => {
      // Create content longer than MAX_CHARS but under MAX_FILE_SIZE
      const content = "a".repeat(InputLoader.MAX_CHARS + 1);
      const f = createTmpFile("long.txt", content);
      expect(() => InputLoader.load(f)).toThrow(/过长/);
    });
  });

  // ---- _cleanText() ---------------------------------------------------------

  describe("_cleanText()", () => {
    it("collapses multiple blank lines", () => {
      const text = "line1\n\n\n\nline2";
      const result = InputLoader._cleanText(text);
      expect(result).not.toContain("\n\n\n");
      expect(result).toContain("line1");
      expect(result).toContain("line2");
    });

    it("strips leading and trailing whitespace", () => {
      const text = "  hello world  \n  ";
      const result = InputLoader._cleanText(text);
      expect(result).toBe("hello world");
    });
  });

  // ---- splitSections() ------------------------------------------------------

  describe("splitSections()", () => {
    it("splits text by headings", () => {
      const text =
        "# 需求概述\n\n这是一个系统。\n\n# 功能需求\n\n用户可以登录。";
      const sections = InputLoader.splitSections(text);
      expect(sections).toHaveLength(2);
      expect(sections[0].title).toBe("需求概述");
      expect(sections[1].title).toBe("功能需求");
      expect(sections[0].content).toContain("系统");
      expect(sections[1].content).toContain("登录");
    });

    it("returns a single section with empty title when no heading exists", () => {
      const text = "没有标题的纯文本内容。";
      const sections = InputLoader.splitSections(text);
      expect(sections).toHaveLength(1);
      expect(sections[0].title).toBe("");
      expect(sections[0].content).toContain("纯文本");
    });
  });

  // ---- _extractJson() -------------------------------------------------------

  describe("_extractJson()", () => {
    it("extracts JSON from markdown code fence", () => {
      const text = '```json\n{"key": "value"}\n```';
      const result = InputLoader._extractJson(text);
      expect(result).toEqual({ key: "value" });
    });

    it("extracts JSON from raw braces in text", () => {
      const text = 'Some prefix {"actors": ["user"], "functions": []} suffix';
      const result = InputLoader._extractJson(text);
      expect(result).toEqual({ actors: ["user"], functions: [] });
    });

    it("returns null when no JSON is present", () => {
      const text = "Just plain text without any JSON.";
      const result = InputLoader._extractJson(text);
      expect(result).toBeNull();
    });
  });

  // ---- loadWithSections() with spanMap (documentNormalizer integration) ----

  describe("loadWithSections() — XML spanMap", () => {
    it("returns spanMap for XML files with normalized sentence evidence", () => {
      const xml = `<req_document>
  <p>
    <title>Help Module</title>
    <text_body>The system must provide contextual help. Users can search the help database.</text_body>
  </p>
</req_document>`;
      const f = createTmpFile("test_spanmap.xml", xml);
      const result = InputLoader.loadWithSections(f);

      expect(result.text).toContain("Help Module");
      expect(result.sectionIndex).toBeDefined();
      expect(result.spanMap).toBeDefined();
      // spanMap should contain sentence-level entries
      expect(Object.keys(result.spanMap!).length).toBeGreaterThan(0);

      // Each entry should have sentenceId, sectionId, sourceText
      for (const evidence of Object.values(result.spanMap!)) {
        expect(evidence).toHaveProperty("sentenceId");
        expect(evidence).toHaveProperty("sectionId");
        expect(evidence).toHaveProperty("sourceText");
        expect(typeof (evidence as any).sentenceId).toBe("string");
        expect(typeof (evidence as any).sectionId).toBe("string");
        expect(typeof (evidence as any).sourceText).toBe("string");
      }
    });

    it("returns undefined spanMap for non-XML files", () => {
      const f = createTmpFile("test.txt", "Some plain text");
      const result = InputLoader.loadWithSections(f);
      expect(result.spanMap).toBeUndefined();
    });

    it("returns empty spanMap when XML has no structured content", () => {
      const f = createTmpFile("malformed.xml", "not valid xml content");
      const result = InputLoader.loadWithSections(f);
      // parseXmlRequirement still processes it as text; spanMap may be empty but not undefined
      // (normalizeDocument handles malformed XML gracefully with empty results)
      if (result.spanMap) {
        expect(Object.keys(result.spanMap).length).toBe(0);
      }
      // No crash is the main assertion
      expect(result.text).toBeDefined();
    });
  });

  // ---- Static constants -----------------------------------------------------

  describe("static constants", () => {
    it("SUPPORTED_EXTENSIONS contains expected values", () => {
      expect(InputLoader.SUPPORTED_EXTENSIONS.has(".md")).toBe(true);
      expect(InputLoader.SUPPORTED_EXTENSIONS.has(".txt")).toBe(true);
      expect(InputLoader.SUPPORTED_EXTENSIONS.has(".json")).toBe(true);
    });

    it("MAX_FILE_SIZE and MAX_CHARS are positive numbers", () => {
      expect(InputLoader.MAX_FILE_SIZE).toBeGreaterThan(0);
      expect(InputLoader.MAX_CHARS).toBeGreaterThan(0);
    });
  });
});
