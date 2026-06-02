/**
 * Batch D tests: Section slicing + concurrency config.
 *
 * Step 8: Concurrency config — maxConcurrency is configurable via constructor, default 5.
 * Step 6a: xmlParser — extractSectionIndex + sliceBySections.
 * Step 6b: inputLoader — loadWithSections returns sectionIndex for XML.
 * Step 6c: planner — _buildUserPrompt generates TOC when sectionIndex present;
 *          _parseResponse reads assignedSections into contextHints.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionBackend } from "../src/execution/backend.js";
import {
  parseXmlString,
  extractSectionIndex,
  sliceBySections,
  type SectionIndex,
} from "../src/xmlParser.js";
import { InputLoader } from "../src/inputLoader.js";
import { PlanningTool } from "../src/tools/planning.js";
import { createExecutionPlan, createTask } from "../src/shared/types.js";
import { buildSectionToc } from "../src/runtime.js";

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

const TMP_DIR = join(import.meta.dirname, "__test_tmp_batch_d__");

function tmpPath(filename: string): string {
  return join(TMP_DIR, filename);
}

function createTmpFile(filename: string, content: string): string {
  const p = tmpPath(filename);
  writeFileSync(p, content, "utf-8");
  return p;
}

// ---------------------------------------------------------------------------
// Step 8: Concurrency Configuration
// ---------------------------------------------------------------------------

describe("Step 8: Concurrency Configuration", () => {
  it("default maxConcurrency is 5", () => {
    const backend = new SessionBackend({ heartbeatInterval: 0 });
    // Access private field via cast
    const max = (backend as unknown as { maxConcurrency: number }).maxConcurrency;
    expect(max).toBe(5);
  });

  it("maxConcurrency can be set via constructor options", () => {
    const backend = new SessionBackend({ heartbeatInterval: 0, maxConcurrency: 10 });
    const max = (backend as unknown as { maxConcurrency: number }).maxConcurrency;
    expect(max).toBe(10);
  });

  it("maxConcurrency uses default when options.maxConcurrency is undefined", () => {
    const backend = new SessionBackend({ heartbeatInterval: 0 });
    const max = (backend as unknown as { maxConcurrency: number }).maxConcurrency;
    expect(max).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Step 6a: xmlParser — extractSectionIndex + sliceBySections
// ---------------------------------------------------------------------------

describe("Step 6a: extractSectionIndex", () => {
  const sampleXml = `<req_document>
  <p>
    <title>用户管理</title>
    <text_body>系统应支持用户注册和登录。</text_body>
    <p>
      <title>注册功能</title>
      <text_body>用户可以通过邮箱注册账号。</text_body>
    </p>
  </p>
  <p>
    <title>订单管理</title>
    <text_body>用户可以创建和查看订单。</text_body>
  </p>
</req_document>`;

  it("extracts section index with correct structure", () => {
    const sections = extractSectionIndex(sampleXml);
    expect(sections.length).toBeGreaterThanOrEqual(3);
    // Check first section
    expect(sections[0].title).toBe("用户管理");
    expect(sections[0].depth).toBe(1);
    expect(sections[0].id).toMatch(/^s\d+-\d+$/);
    expect(sections[0].charRange).toHaveLength(2);
    expect(sections[0].charRange[0]).toBeLessThan(sections[0].charRange[1]);
  });

  it("generates stable IDs based on depth and counter", () => {
    const sections = extractSectionIndex(sampleXml);
    // First depth-1 section should be s1-1, second s1-2
    const depth1 = sections.filter((s) => s.depth === 1);
    expect(depth1[0].id).toBe("s1-1");
    expect(depth1[1].id).toBe("s1-2");
  });

  it("extracts nested sections with depth > 1", () => {
    const sections = extractSectionIndex(sampleXml);
    const nested = sections.filter((s) => s.depth === 2);
    expect(nested.length).toBeGreaterThanOrEqual(1);
    expect(nested[0].title).toBe("注册功能");
  });

  it("returns empty array for empty XML", () => {
    const sections = extractSectionIndex("<req_document></req_document>");
    expect(sections).toEqual([]);
  });

  it("charRanges point to valid positions in the markdown output", () => {
    const md = parseXmlString(sampleXml);
    const sections = extractSectionIndex(sampleXml);
    for (const s of sections) {
      const [start, end] = s.charRange;
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(md.length);
      expect(end).toBeGreaterThan(start);
      // The slice should contain the section title
      const slice = md.slice(start, end);
      expect(slice).toContain(s.title);
    }
  });
});

describe("Step 6a: sliceBySections", () => {
  const sampleXml = `<req_document>
  <p>
    <title>用户管理</title>
    <text_body>系统应支持用户注册和登录功能。</text_body>
    <p>
      <title>注册功能</title>
      <text_body>用户可以通过邮箱注册账号。</text_body>
    </p>
  </p>
  <p>
    <title>订单管理</title>
    <text_body>用户可以创建和查看订单。</text_body>
  </p>
</req_document>`;

  it("returns full markdown when sectionIds is undefined", () => {
    const md = parseXmlString(sampleXml);
    const sections = extractSectionIndex(sampleXml);
    const result = sliceBySections(md, sections);
    expect(result).toBe(md);
  });

  it("returns full markdown when sectionIds is empty", () => {
    const md = parseXmlString(sampleXml);
    const sections = extractSectionIndex(sampleXml);
    const result = sliceBySections(md, sections, []);
    expect(result).toBe(md);
  });

  it("slices only the specified sections", () => {
    const md = parseXmlString(sampleXml);
    const sections = extractSectionIndex(sampleXml);
    // Get only the first section
    const firstId = sections[0].id;
    const result = sliceBySections(md, sections, [firstId]);
    expect(result).toContain("用户管理");
    expect(result).not.toContain("订单管理");
  });

  it("slices multiple specified sections", () => {
    const md = parseXmlString(sampleXml);
    const sections = extractSectionIndex(sampleXml);
    // Get depth-1 sections
    const depth1Ids = sections.filter((s) => s.depth === 1).map((s) => s.id);
    const result = sliceBySections(md, sections, depth1Ids);
    expect(result).toContain("用户管理");
    expect(result).toContain("订单管理");
  });
});

// ---------------------------------------------------------------------------
// Step 6b: InputLoader.loadWithSections
// ---------------------------------------------------------------------------

describe("Step 6b: InputLoader.loadWithSections", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("returns text and sectionIndex for XML files", () => {
    const xml = `<req_document>
  <p>
    <title>功能概述</title>
    <text_body>系统应支持用户登录。</text_body>
  </p>
</req_document>`;
    const f = createTmpFile("test.xml", xml);
    const result = InputLoader.loadWithSections(f);
    expect(result.text).toContain("功能概述");
    expect(result.sectionIndex).toBeDefined();
    expect(result.sectionIndex!.length).toBeGreaterThanOrEqual(1);
    expect(result.sectionIndex![0].title).toBe("功能概述");
  });

  it("returns text without sectionIndex for non-XML files", () => {
    const f = createTmpFile("test.md", "# 需求\n\n用户可以注册。");
    const result = InputLoader.loadWithSections(f);
    expect(result.text).toContain("需求");
    expect(result.sectionIndex).toBeUndefined();
  });

  it("returns text with empty sectionIndex for malformed XML", () => {
    const f = createTmpFile("bad.xml", "this is not valid xml <><>");
    const result = InputLoader.loadWithSections(f);
    // Should still return text (non-fatal)
    expect(result.text).toBeDefined();
    // Malformed XML parses leniently, returning empty array
    expect(result.sectionIndex).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Step 6c: planner — _buildUserPrompt with sectionIndex
// ---------------------------------------------------------------------------

describe("Step 6c: PlanningTool._buildUserPrompt with sectionIndex", () => {
  it("generates TOC when sectionIndex is provided", () => {
    const sections: SectionIndex[] = [
      { id: "s1-1", depth: 1, title: "用户管理", body: "注册和登录", charRange: [0, 10] },
      { id: "s1-2", depth: 1, title: "订单管理", body: "创建和查看订单", charRange: [10, 20] },
    ];
    const prompt = PlanningTool._buildUserPrompt("some text", "design", sections);
    expect(prompt).toContain("章节目录");
    expect(prompt).toContain("s1-1");
    expect(prompt).toContain("用户管理");
    expect(prompt).toContain("s1-2");
    expect(prompt).toContain("订单管理");
    expect(prompt).toContain("assignedSections");
  });

  it("keeps the full requirement text when no sectionIndex is available", () => {
    const longText = "a".repeat(10000);
    const prompt = PlanningTool._buildUserPrompt(longText, "design");
    expect(prompt).toContain("需求文档");
    expect(prompt).not.toContain("章节目录");
    expect(prompt).toContain(longText);
    expect(prompt).not.toContain("后续内容已截断");
  });
});

describe("Step 6c: PlanningTool._parseResponse reads assignedSections", () => {
  it("parses assignedSections into contextHints", () => {
    const fakeLlm = {
      generateJson: async () => ({}),
      generateText: async () => "",
      streamTag: "",
    } as any;
    const planner = new PlanningTool(fakeLlm);

    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-1",
          type: "analyze",
          description: "test task",
          depends_on: [],
          assignedSections: ["s1-1", "s1-2"],
          context_hints: {},
        },
      ],
    };

    const plan = planner._parseResponse(response, "design");
    expect(plan.tasks.length).toBeGreaterThanOrEqual(1);
    const task = plan.tasks.find((t) => t.id === "analyze-1");
    expect(task).toBeDefined();
    expect(task!.contextHints).toBeDefined();
    expect(task!.contextHints!.assignedSections).toEqual(["s1-1", "s1-2"]);
  });

  it("parses assigned_sections (snake_case) into contextHints", () => {
    const fakeLlm = {
      generateJson: async () => ({}),
      generateText: async () => "",
      streamTag: "",
    } as any;
    const planner = new PlanningTool(fakeLlm);

    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-1",
          type: "analyze",
          description: "test task",
          depends_on: [],
          assigned_sections: ["s2-1"],
          context_hints: {},
        },
      ],
    };

    const plan = planner._parseResponse(response, "design");
    const task = plan.tasks.find((t) => t.id === "analyze-1");
    expect(task!.contextHints!.assignedSections).toEqual(["s2-1"]);
  });

  it("does not set assignedSections when field is missing", () => {
    const fakeLlm = {
      generateJson: async () => ({}),
      generateText: async () => "",
      streamTag: "",
    } as any;
    const planner = new PlanningTool(fakeLlm);

    const response = {
      reasoning: "test",
      tasks: [
        {
          id: "analyze-1",
          type: "analyze",
          description: "test task",
          depends_on: [],
          context_hints: {},
        },
      ],
    };

    const plan = planner._parseResponse(response, "design");
    const task = plan.tasks.find((t) => t.id === "analyze-1");
    expect(task!.contextHints!.assignedSections).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Step 6d: planner — _ensureSectionCoverage
// ---------------------------------------------------------------------------

describe("Step 6d: PlanningTool._ensureSectionCoverage", () => {
  it("appends unassigned sections to the analyze task with fewest assigned sections", () => {
    const sectionIndex: SectionIndex[] = [
      { id: "s1-1", depth: 1, title: "用户管理", body: "注册和登录", charRange: [0, 10] },
      { id: "s1-2", depth: 1, title: "订单管理", body: "创建和查看订单", charRange: [10, 20] },
      { id: "s1-3", depth: 1, title: "支付管理", body: "支付和退款", charRange: [20, 30] },
    ];

    // s1-3 is missing from all tasks
    const plan = createExecutionPlan({
      tasks: [
        createTask({ id: "analyze-1", type: "analyze", description: "first", contextHints: { assignedSections: ["s1-1"] } }),
        createTask({ id: "analyze-2", type: "analyze", description: "second", contextHints: { assignedSections: ["s1-2"] } }),
      ],
      goal: "design",
      reasoning: "test",
    });

    const result = PlanningTool._ensureSectionCoverage(plan, sectionIndex);

    // s1-3 should be appended to the task with fewest sections (both have 1, pick first = analyze-1)
    const a1 = result.tasks.find((t) => t.id === "analyze-1")!;
    const a2 = result.tasks.find((t) => t.id === "analyze-2")!;
    expect(a1.contextHints!.assignedSections).toContain("s1-3");
    expect(a2.contextHints!.assignedSections).not.toContain("s1-3");
  });

  it("returns plan unchanged when all sections are covered", () => {
    const sectionIndex: SectionIndex[] = [
      { id: "s1-1", depth: 1, title: "用户管理", body: "注册和登录", charRange: [0, 10] },
      { id: "s1-2", depth: 1, title: "订单管理", body: "创建和查看订单", charRange: [10, 20] },
    ];

    const plan = createExecutionPlan({
      tasks: [
        createTask({ id: "analyze-1", type: "analyze", description: "first", contextHints: { assignedSections: ["s1-1", "s1-2"] } }),
      ],
      goal: "design",
      reasoning: "test",
    });

    const result = PlanningTool._ensureSectionCoverage(plan, sectionIndex);
    const a1 = result.tasks.find((t) => t.id === "analyze-1")!;
    expect(a1.contextHints!.assignedSections).toEqual(["s1-1", "s1-2"]);
  });

  it("handles analyze tasks with no assignedSections by treating them as empty", () => {
    const sectionIndex: SectionIndex[] = [
      { id: "s1-1", depth: 1, title: "用户管理", body: "注册和登录", charRange: [0, 10] },
    ];

    const plan = createExecutionPlan({
      tasks: [
        createTask({ id: "analyze-1", type: "analyze", description: "first", contextHints: {} }),
      ],
      goal: "design",
      reasoning: "test",
    });

    const result = PlanningTool._ensureSectionCoverage(plan, sectionIndex);
    const a1 = result.tasks.find((t) => t.id === "analyze-1")!;
    expect(a1.contextHints!.assignedSections).toEqual(["s1-1"]);
  });

  it("does nothing when sectionIndex is undefined", () => {
    const plan = createExecutionPlan({
      tasks: [
        createTask({ id: "analyze-1", type: "analyze", description: "first", contextHints: { assignedSections: ["s1-1"] } }),
      ],
      goal: "design",
      reasoning: "test",
    });

    const result = PlanningTool._ensureSectionCoverage(plan, undefined);
    expect(result).toBe(plan);
  });

  it("does nothing when there are no analyze tasks", () => {
    const sectionIndex: SectionIndex[] = [
      { id: "s1-1", depth: 1, title: "用户管理", body: "注册和登录", charRange: [0, 10] },
    ];

    const plan = createExecutionPlan({
      tasks: [
        createTask({ id: "design-1", type: "design", description: "design task" }),
      ],
      goal: "design",
      reasoning: "test",
    });

    const result = PlanningTool._ensureSectionCoverage(plan, sectionIndex);
    expect(result).toBe(plan);
  });

  it("appends multiple unassigned sections to the lightest task", () => {
    const sectionIndex: SectionIndex[] = [
      { id: "s1-1", depth: 1, title: "A", body: "x", charRange: [0, 1] },
      { id: "s1-2", depth: 1, title: "B", body: "yy", charRange: [1, 3] },
      { id: "s1-3", depth: 1, title: "C", body: "zzz", charRange: [3, 6] },
      { id: "s1-4", depth: 1, title: "D", body: "w", charRange: [6, 7] },
    ];

    // Only s1-1 is assigned, s1-2, s1-3, s1-4 are missing
    const plan = createExecutionPlan({
      tasks: [
        createTask({ id: "analyze-1", type: "analyze", description: "first", contextHints: { assignedSections: ["s1-1"] } }),
        createTask({ id: "analyze-2", type: "analyze", description: "second", contextHints: {} }),
      ],
      goal: "design",
      reasoning: "test",
    });

    const result = PlanningTool._ensureSectionCoverage(plan, sectionIndex);

    // analyze-2 has 0 sections (fewest), so all unassigned go there
    const a2 = result.tasks.find((t) => t.id === "analyze-2")!;
    expect(a2.contextHints!.assignedSections).toEqual(expect.arrayContaining(["s1-2", "s1-3", "s1-4"]));
    expect(a2.contextHints!.assignedSections).toHaveLength(3);
  });

  it("appends unassigned sections to the lightest analyze task", () => {
    const sectionIndex: SectionIndex[] = [
      { id: "s1-1", depth: 1, title: "用户管理", body: "注册和登录", charRange: [0, 10] },
      { id: "s2-8", depth: 1, title: "帮助模块", body: "帮助中心功能", charRange: [10, 20] },
    ];

    // s2-8 (Help Module) is unassigned
    const plan = createExecutionPlan({
      tasks: [
        createTask({
          id: "analyze-1",
          type: "analyze",
          description: "domain analysis",
          analysisMode: "domain",
          contextHints: { assignedSections: ["s1-1"] },
        }),
        createTask({
          id: "analyze-2",
          type: "analyze",
          description: "extra analysis",
          analysisMode: "domain",
          contextHints: { assignedSections: [] },
        }),
      ],
      goal: "design",
      reasoning: "test",
    });

    const result = PlanningTool._ensureSectionCoverage(plan, sectionIndex);

    // s2-8 should go to the lighter task (analyze-2, which has 0 sections)
    const analyze2 = result.tasks.find((t) => t.id === "analyze-2")!;
    const analyze1 = result.tasks.find((t) => t.id === "analyze-1")!;
    expect(analyze2.contextHints!.assignedSections).toContain("s2-8");
    expect(analyze1.contextHints!.assignedSections).not.toContain("s2-8");
  });
});

// ---------------------------------------------------------------------------
// buildSectionToc: section TOC generation for global context
// ---------------------------------------------------------------------------

describe("buildSectionToc", () => {
  it("generates a TOC from sectionIndex with depth-based indentation", () => {
    const sectionIndex: SectionIndex[] = [
      { id: "s1", depth: 1, title: "用户管理", body: "", charRange: [0, 10] },
      { id: "s1-1", depth: 2, title: "注册", body: "", charRange: [10, 20] },
      { id: "s1-2", depth: 2, title: "登录", body: "", charRange: [20, 30] },
      { id: "s2", depth: 1, title: "订单管理", body: "", charRange: [30, 40] },
    ];

    const toc = buildSectionToc(sectionIndex);
    expect(toc).toContain("[文档章节目录]");
    expect(toc).toContain("- 用户管理");
    expect(toc).toContain("  - 注册");
    expect(toc).toContain("  - 登录");
    expect(toc).toContain("- 订单管理");
  });

  it("returns empty string for empty sectionIndex", () => {
    expect(buildSectionToc([])).toBe("");
  });

  it("handles single-level sections with no nesting", () => {
    const sectionIndex: SectionIndex[] = [
      { id: "s1", depth: 1, title: "A", body: "", charRange: [0, 1] },
      { id: "s2", depth: 1, title: "B", body: "", charRange: [1, 2] },
    ];
    const toc = buildSectionToc(sectionIndex);
    expect(toc).toContain("- A");
    expect(toc).toContain("- B");
  });
});
