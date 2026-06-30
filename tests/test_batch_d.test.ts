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
// PlanningTool._capAnalyzeShards: smart section-based shard capping
// ---------------------------------------------------------------------------

describe("PlanningTool._capAnalyzeShards", () => {
  const req = "x".repeat(100);

  function makeSections(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `s${i + 1}`, depth: 2, title: `Section ${i + 1}`, body: "content", charRange: [0, 10] as [number, number],
    }));
  }

  function shardedPlan(shardCount = 2) {
    const tasks = Array.from({ length: shardCount }, (_, i) =>
      createTask({ id: `analyze-${i + 1}`, type: "analyze", description: `a${i + 1}`, contextHints: { assignedSections: [`s${i + 1}`] } }),
    );
    tasks.push(createTask({ id: "design-1", type: "design", description: "d", dependsOn: tasks.map((t) => t.id) }));
    return createExecutionPlan({ tasks, goal: "design", reasoning: "test" });
  }

  it("collapses to single shard for simple docs (≤ SINGLE_SHARD_SECTION_LIMIT sections)", () => {
    const sections = makeSections(15);
    const result = PlanningTool._capAnalyzeShards(shardedPlan(), req, sections);
    const analyze = result.tasks.filter((t) => t.type === "analyze");
    expect(analyze).toHaveLength(1);
    expect(analyze[0].id).toBe("analyze-1");
    expect(analyze[0].contextHints?.assignedSections).toBeUndefined();
  });

  it("repoints dependents of removed shards to the kept analyze task", () => {
    const sections = makeSections(10);
    const result = PlanningTool._capAnalyzeShards(shardedPlan(), req, sections);
    const design = result.tasks.find((t) => t.id === "design-1")!;
    expect(design.dependsOn).toEqual(["analyze-1"]);
  });

  it("keeps multi-shard for complex docs (> SINGLE_SHARD_SECTION_LIMIT sections)", () => {
    const sections = makeSections(50);
    const plan = shardedPlan(2);
    const result = PlanningTool._capAnalyzeShards(plan, req, sections);
    expect(result).toBe(plan);
    expect(result.tasks.filter((t) => t.type === "analyze")).toHaveLength(2);
  });

  it("caps excessive shards based on section count", () => {
    const sections = makeSections(30);
    // 30 sections / 20 per shard = ceil → 2 max, but plan has 4
    const plan = shardedPlan(4);
    const result = PlanningTool._capAnalyzeShards(plan, req, sections);
    expect(result.tasks.filter((t) => t.type === "analyze")).toHaveLength(2);
    // Removed shards' deps repointed
    const design = result.tasks.find((t) => t.id === "design-1")!;
    expect(design.dependsOn).toContain("analyze-2");
    expect(design.dependsOn).not.toContain("analyze-3");
  });

  it("falls back to regex counting when no sectionIndex provided", () => {
    const mdText = Array.from({ length: 10 }, (_, i) => `### Section ${i}`).join("\n");
    const result = PlanningTool._capAnalyzeShards(shardedPlan(), mdText);
    const analyze = result.tasks.filter((t) => t.type === "analyze");
    expect(analyze).toHaveLength(1);
  });

  it("is a no-op when there is a single analyze task", () => {
    const plan = createExecutionPlan({
      tasks: [createTask({ id: "analyze-1", type: "analyze", description: "a" })],
      goal: "design", reasoning: "test",
    });
    const result = PlanningTool._capAnalyzeShards(plan, req, makeSections(5));
    expect(result).toBe(plan);
  });
});

// ---------------------------------------------------------------------------
// PlanningTool._allocateAnalyzeShards: section-based shard allocation
// ---------------------------------------------------------------------------

describe("PlanningTool._allocateAnalyzeShards", () => {
  function makeSections(specs: Array<{ parentId: string; leafCount: number }>) {
    const result: Array<{ id: string; depth: number; title: string; body: string; charRange: [number, number] }> = [];
    let leafIdx = 0;
    for (const { parentId, leafCount } of specs) {
      result.push({ id: parentId, depth: 1, title: `Parent ${parentId}`, body: "", charRange: [0, 0] });
      for (let i = 0; i < leafCount; i++) {
        leafIdx++;
        result.push({ id: `s${leafIdx}`, depth: 2, title: `Section ${leafIdx}`, body: "x", charRange: [0, 1] });
      }
    }
    return result;
  }

  it("returns empty for no sectionIndex", () => {
    expect(PlanningTool._allocateAnalyzeShards()).toEqual([]);
    expect(PlanningTool._allocateAnalyzeShards([])).toEqual([]);
  });

  it("returns empty (single shard) for ≤ SINGLE_SHARD_SECTION_LIMIT leaf sections", () => {
    const sections = makeSections([{ parentId: "p1", leafCount: 15 }]);
    expect(PlanningTool._allocateAnalyzeShards(sections)).toEqual([]);
  });

  it("creates multiple shards for > SINGLE_SHARD_SECTION_LIMIT leaf sections", () => {
    const sections = makeSections([{ parentId: "p1", leafCount: 25 }, { parentId: "p2", leafCount: 25 }]);
    const shards = PlanningTool._allocateAnalyzeShards(sections);
    expect(shards.length).toBeGreaterThanOrEqual(2);
    // All leaf IDs covered, no duplicates
    const all = shards.flat();
    expect(all).toHaveLength(50);
    expect(new Set(all).size).toBe(50);
  });

  it("snaps cut points to parent boundaries", () => {
    // 30 leafs: parent A has 14, parent B has 16
    // Ideal cut at 15, but parent boundary is at 14 — should snap to 14
    const sections = makeSections([{ parentId: "A", leafCount: 14 }, { parentId: "B", leafCount: 16 }]);
    const shards = PlanningTool._allocateAnalyzeShards(sections);
    expect(shards).toHaveLength(2);
    expect(shards[0]).toHaveLength(14);
    expect(shards[1]).toHaveLength(16);
  });

  it("handles promise-style docs (2 parents, many leafs)", () => {
    // 93 leafs across 2 parent groups — like promise_p08
    const sections = makeSections([{ parentId: "A", leafCount: 46 }, { parentId: "B", leafCount: 47 }]);
    const shards = PlanningTool._allocateAnalyzeShards(sections);
    // ceil(93/20) = 5 shards
    expect(shards.length).toBe(5);
    // All covered
    expect(shards.flat()).toHaveLength(93);
    // Reasonably balanced (no shard should be > 25 or < 10)
    for (const shard of shards) {
      expect(shard.length).toBeGreaterThanOrEqual(10);
      expect(shard.length).toBeLessThanOrEqual(25);
    }
  });

  it("handles many small parent groups", () => {
    // 6 parents with 5 leafs each = 30 leafs → ceil(30/20) = 2 shards
    const sections = makeSections(
      Array.from({ length: 6 }, (_, i) => ({ parentId: `p${i}`, leafCount: 5 })),
    );
    const shards = PlanningTool._allocateAnalyzeShards(sections);
    expect(shards).toHaveLength(2);
    expect(shards.flat()).toHaveLength(30);
  });
});

// ---------------------------------------------------------------------------
// PlanningTool.buildDeterministicPlan: standard design workflow
// ---------------------------------------------------------------------------

describe("PlanningTool.buildDeterministicPlan", () => {
  function makeSections(leafCount: number) {
    const result: Array<{ id: string; depth: number; title: string; body: string; charRange: [number, number] }> = [];
    result.push({ id: "p1", depth: 1, title: "Parent", body: "", charRange: [0, 0] });
    for (let i = 0; i < leafCount; i++) {
      result.push({ id: `s${i + 1}`, depth: 2, title: `Section ${i + 1}`, body: "x", charRange: [0, 1] });
    }
    return result;
  }

  it("creates standard task chain: analyze → design → diagrams + tests", () => {
    const plan = PlanningTool.buildDeterministicPlan("design");
    const types = plan.tasks.map((t) => t.type);
    expect(types).toContain("analyze");
    expect(types).toContain("design");
    expect(types).toContain("diagrams");
    expect(types).toContain("tests");
  });

  it("creates 3 separate diagram tasks", () => {
    const plan = PlanningTool.buildDeterministicPlan("design");
    const diagrams = plan.tasks.filter((t) => t.type === "diagrams");
    expect(diagrams).toHaveLength(3);
    const kinds = diagrams.map((t) => t.contextHints?.diagram_kind);
    expect(kinds).toContain("class_diagram");
    expect(kinds).toContain("activity_diagram");
    expect(kinds).toContain("state_diagram");
  });

  it("design depends on all domain_model shards", () => {
    const sections = makeSections(50);
    const plan = PlanningTool.buildDeterministicPlan("design", sections);
    const design = plan.tasks.find((t) => t.type === "design")!;
    const domainModelIds = plan.tasks.filter((t) => t.type === "domain_model").map((t) => t.id);
    expect(domainModelIds.length).toBeGreaterThan(0);
    for (const id of domainModelIds) {
      expect(design.dependsOn).toContain(id);
    }
  });

  it("class diagram depends on domain_model; other diagrams and tests depend on design", () => {
    const plan = PlanningTool.buildDeterministicPlan("design");
    for (const t of plan.tasks) {
      if (t.type === "diagrams" || t.type === "tests") {
        if (t.contextHints?.diagram_kind === "class_diagram") {
          expect(t.dependsOn).toContain("domain-model-1");
        } else {
          expect(t.dependsOn).toContain("design-1");
        }
      }
    }
  });

  it("analyze-only mode produces only analyze tasks", () => {
    const plan = PlanningTool.buildDeterministicPlan("analyze");
    expect(plan.tasks.every((t) => t.type === "analyze")).toBe(true);
  });

  it("single shard has no assignedSections", () => {
    const sections = makeSections(10);
    const plan = PlanningTool.buildDeterministicPlan("design", sections);
    const analyze = plan.tasks.filter((t) => t.type === "analyze");
    expect(analyze).toHaveLength(1);
    expect(analyze[0].contextHints?.assignedSections).toBeUndefined();
  });

  it("multi-shard tasks have assignedSections", () => {
    const sections = makeSections(50);
    const plan = PlanningTool.buildDeterministicPlan("design", sections);
    const analyze = plan.tasks.filter((t) => t.type === "analyze");
    expect(analyze.length).toBeGreaterThan(1);
    for (const t of analyze) {
      expect(Array.isArray(t.contextHints?.assignedSections)).toBe(true);
      expect((t.contextHints.assignedSections as string[]).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// plan() integration: deterministic mode end-to-end
// ---------------------------------------------------------------------------

describe("PlanningTool.plan() deterministic mode", () => {
  function makeSectionIndex(leafCount: number) {
    const result: Array<{ id: string; depth: number; title: string; body: string; charRange: [number, number] }> = [];
    result.push({ id: "p1", depth: 1, title: "Parent", body: "", charRange: [0, 0] });
    for (let i = 0; i < leafCount; i++) {
      result.push({ id: `s${i + 1}`, depth: 2, title: `Sec ${i + 1}`, body: "content", charRange: [0, 7] });
    }
    return result;
  }

  it("does not call LLM planner in deterministic mode", async () => {
    let llmCalled = false;
    const fakeLlm = {
      generateJson: async () => { llmCalled = true; return { entities: [], functions: [] }; },
      generateText: async () => "",
      streamTag: "",
    } as any;

    const planner = new PlanningTool(fakeLlm);
    expect(planner.plannerMode).toBe("deterministic");

    const plan = await planner.plan("## 需求\n### 功能A\n用户登录", "design", makeSectionIndex(5));

    // generateJson IS called for registry/constraint extraction, but NOT for planner
    // The plan should have deterministic structure regardless of LLM output
    expect(plan.tasks.find((t) => t.type === "analyze")).toBeDefined();
    expect(plan.tasks.find((t) => t.type === "design")).toBeDefined();
    expect(plan.reasoning).toContain("deterministic");
  });

  it("still injects constraint candidates into analyze tasks", async () => {
    let callCount = 0;
    const fakeLlm = {
      generateJson: async () => {
        callCount++;
        if (callCount === 1) {
          // RegistryExtractor.extract → unwrapContent → .entities/.functions
          return { entities: [{ id: "E001", canonicalName: "User", aliases: [] }], functions: [{ id: "F001", name: "Login" }] };
        }
        // ConstraintExtractor.extractCandidates → unwrapContent → .constraints
        return { constraints: [{ description: "must authenticate", sourceText: "原文", sectionId: "s1" }] };
      },
      generateText: async () => "",
      streamTag: "",
    } as any;

    const planner = new PlanningTool(fakeLlm);
    const plan = await planner.plan("## 需求\n### 功能\n用户登录", "design", makeSectionIndex(5));

    const analyzeTask = plan.tasks.find((t) => t.type === "analyze")!;
    const constraints = analyzeTask.contextHints?.availableConstraints as Array<Record<string, unknown>> | undefined;
    expect(constraints).toBeDefined();
    expect(constraints!.length).toBeGreaterThan(0);
    expect(constraints![0].constraintRef).toMatch(/^C\d{3}$/);
  });

  it("attaches registry to plan", async () => {
    const fakeRegistry = { entities: [{ id: "E001", canonicalName: "User", aliases: [] }], functions: [] };
    const fakeLlm = {
      generateJson: async () => fakeRegistry,
      generateText: async () => "",
      streamTag: "",
    } as any;

    const planner = new PlanningTool(fakeLlm);
    const plan = await planner.plan("## Req\n### F1\nSome requirement", "design");
    expect(plan.registry).toBeDefined();
    expect(plan.registry!.entities[0].canonicalName).toBe("User");
  });

  it("multi-shard plan covers all sections without duplicates", async () => {
    const fakeLlm = {
      generateJson: async () => ({ entities: [], functions: [] }),
      generateText: async () => "",
      streamTag: "",
    } as any;

    const planner = new PlanningTool(fakeLlm);
    const sections = makeSectionIndex(50);
    const plan = await planner.plan("x".repeat(100), "design", sections);

    const analyzeTasks = plan.tasks.filter((t) => t.type === "analyze");
    expect(analyzeTasks.length).toBeGreaterThan(1);

    const allSectionIds = analyzeTasks.flatMap((t) => (t.contextHints?.assignedSections as string[]) ?? []);
    const leafIds = sections.filter((s) => s.depth >= 2).map((s) => s.id);

    // All covered
    expect(new Set(allSectionIds)).toEqual(new Set(leafIds));
    // No duplicates
    expect(allSectionIds.length).toBe(new Set(allSectionIds).size);
    // Contiguous order preserved
    expect(allSectionIds).toEqual(leafIds);
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
