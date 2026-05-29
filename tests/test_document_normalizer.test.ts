import { describe, it, expect } from "vitest";
import { normalizeDocument } from "../src/shared/documentNormalizer.js";
import type { SpanEvidence, DocumentSection } from "../src/shared/documentNormalizer.js";

describe("normalizeDocument", () => {
  // ---------------------------------------------------------------------------
  // Test 1: Basic XML parsing
  // ---------------------------------------------------------------------------
  it("parses basic XML with a single section containing title and text_body", () => {
    const xml = `<req_document>
  <p>
    <title>Help Module</title>
    <text_body>The system must provide contextual help. Users can search the help database.</text_body>
  </p>
</req_document>`;

    const result = normalizeDocument(xml);

    expect(result.sections).toHaveLength(1);
    const section = result.sections[0];
    expect(section.sectionId).toBe("SEC_HELP_MODULE");
    expect(section.title).toBe("Help Module");
    expect(section.paragraphs).toHaveLength(1);

    // Sentences should be split on periods
    const sentences = section.paragraphs[0].sentences;
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences.every(s => s.sentenceId.startsWith("SEC_HELP_MODULE_"))).toBe(true);

    // spanMap should have entries for each sentence
    expect(result.spanMap.size).toBe(sentences.length);
    for (const s of sentences) {
      const evidence = result.spanMap.get(s.sentenceId);
      expect(evidence).toBeDefined();
      expect(evidence!.sentenceId).toBe(s.sentenceId);
      expect(evidence!.sectionId).toBe("SEC_HELP_MODULE");
      expect(typeof evidence!.sourceText).toBe("string");
      expect(evidence!.sourceText.length).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 2: Nested sections (sub-sections)
  // ---------------------------------------------------------------------------
  it("handles nested <p> sections with different depth levels", () => {
    const xml = `<req_document>
  <p>
    <title>Module A</title>
    <text_body>Top level description.</text_body>
    <p>
      <title>Sub Feature 1</title>
      <text_body>Sub feature details here.</text_body>
    </p>
    <p>
      <title>Sub Feature 2</title>
      <text_body>Another sub feature.</text_body>
    </p>
  </p>
</req_document>`;

    const result = normalizeDocument(xml);

    expect(result.sections.length).toBeGreaterThanOrEqual(3);

    const sectionIds = result.sections.map(s => s.sectionId);
    expect(sectionIds).toContain("SEC_MODULE_A");
    expect(sectionIds).toContain("SEC_SUB_FEATURE_1");
    expect(sectionIds).toContain("SEC_SUB_FEATURE_2");

    // Each section should have sentences
    for (const section of result.sections) {
      expect(section.paragraphs.length).toBeGreaterThan(0);
      const allSentences = section.paragraphs.flatMap(p => p.sentences);
      expect(allSentences.length).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 3: <req> child elements as paragraphs
  // ---------------------------------------------------------------------------
  it("treats <req> child elements as paragraphs within a section", () => {
    const xml = `<req_document>
  <p>
    <title>Requirements</title>
    <req id="1">
      <text_body>The system must validate inputs before processing.</text_body>
    </req>
    <req id="2">
      <text_body>The system must log all validation failures.</text_body>
    </req>
  </p>
</req_document>`;

    const result = normalizeDocument(xml);

    expect(result.sections).toHaveLength(1);
    const section = result.sections[0];
    expect(section.sectionId).toBe("SEC_REQUIREMENTS");
    expect(section.paragraphs.length).toBeGreaterThanOrEqual(2);

    // Each <req> should produce a paragraph with sentences
    const allTexts = section.paragraphs.flatMap(p => p.sentences.map(s => s.text)).join(" ");
    expect(allTexts).toContain("validate");
    expect(allTexts).toContain("log");
  });

  // ---------------------------------------------------------------------------
  // Test 4: Sentence splitting on various delimiters
  // ---------------------------------------------------------------------------
  it("splits text into sentences on periods, newlines, and CJK punctuation", () => {
    const xml = `<req_document>
  <p>
    <title>Multi Sentence</title>
    <text_body>First sentence. Second sentence. Third sentence!
    Fourth line
    Fifth line</text_body>
  </p>
</req_document>`;

    const result = normalizeDocument(xml);
    const sentences = result.sections[0].paragraphs[0].sentences;

    // Should have multiple sentences
    expect(sentences.length).toBeGreaterThanOrEqual(3);

    // Each sentence should have a unique sentenceId
    const sentenceIds = sentences.map(s => s.sentenceId);
    const uniqueIds = new Set(sentenceIds);
    expect(uniqueIds.size).toBe(sentenceIds.length);

    // Text should be cleaned (no extra whitespace)
    for (const s of sentences) {
      expect(s.text).toBe(s.text.trim());
      expect(s.text.length).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 5: sentenceId uniqueness across the entire document
  // ---------------------------------------------------------------------------
  it("generates globally unique sentenceIds across all sections", () => {
    const xml = `<req_document>
  <p>
    <title>Section A</title>
    <text_body>Content A one. Content A two.</text_body>
  </p>
  <p>
    <title>Section B</title>
    <text_body>Content B one. Content B two.</text_body>
  </p>
</req_document>`;

    const result = normalizeDocument(xml);

    const allSentenceIds: string[] = [];
    for (const section of result.sections) {
      for (const para of section.paragraphs) {
        for (const s of para.sentences) {
          allSentenceIds.push(s.sentenceId);
        }
      }
    }

    const uniqueIds = new Set(allSentenceIds);
    expect(uniqueIds.size).toBe(allSentenceIds.length);
    expect(allSentenceIds.length).toBeGreaterThan(0);

    // spanMap should have same number of entries
    expect(result.spanMap.size).toBe(allSentenceIds.length);
  });

  // ---------------------------------------------------------------------------
  // Test 6: Section without title gets auto-generated sectionId
  // ---------------------------------------------------------------------------
  it("handles sections without a title by generating a fallback sectionId", () => {
    const xml = `<req_document>
  <p>
    <text_body>Untitled section content.</text_body>
  </p>
</req_document>`;

    const result = normalizeDocument(xml);

    expect(result.sections).toHaveLength(1);
    const section = result.sections[0];
    expect(section.sectionId).toMatch(/^SEC_\d+$/);
    expect(section.title).toBe("");
    expect(section.paragraphs.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Test 7: Empty input
  // ---------------------------------------------------------------------------
  it("returns empty sections and empty spanMap for empty XML", () => {
    const result = normalizeDocument("<req_document></req_document>");
    expect(result.sections).toHaveLength(0);
    expect(result.spanMap.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 8: Text with CJK characters (no Latin punctuation)
  // ---------------------------------------------------------------------------
  it("splits CJK text on line breaks when no period punctuation is present", () => {
    const xml = `<req_document>
  <p>
    <title>中文需求</title>
    <text_body>系统应支持用户登录功能
系统应支持用户注销功能
数据必须加密存储</text_body>
  </p>
</req_document>`;

    const result = normalizeDocument(xml);
    const sentences = result.sections[0].paragraphs[0].sentences;

    expect(sentences.length).toBeGreaterThanOrEqual(2);

    // spanMap covers all sentences
    for (const s of sentences) {
      expect(result.spanMap.has(s.sentenceId)).toBe(true);
    }
  });
});
