import { describe, it, expect } from "vitest";
import { ArtifactPatcher } from "../src/tools/artifactPatcher.js";

describe("ArtifactPatcher.parseSections", () => {
  it("splits markdown by ## headings", () => {
    const md = `# Title\n\nIntro text\n\n## Section A\n\nContent A\n\n## Section B\n\nContent B`;
    const sections = ArtifactPatcher.parseSections(md, "design");
    expect(sections).toHaveLength(3);
    expect(sections[0].key).toBe("Title");
    expect(sections[1].key).toBe("Section A");
    expect(sections[2].key).toBe("Section B");
    expect(sections[1].content).toContain("Content A");
  });

  it("splits markdown by ### when no ## present", () => {
    const md = `### Module 1\n\nMod1 content\n\n### Module 2\n\nMod2 content`;
    const sections = ArtifactPatcher.parseSections(md, "design");
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections[0].key).toBe("Module 1");
  });

  it("splits diagrams dict by diagram type keys", () => {
    const diagrams = {
      class_diagram: "classDiagram\nclass Order",
      activity_diagram: "flowchart TD\n  A-->B",
      state_diagram: "stateDiagram-v2\n  [*] --> Created",
    };
    const sections = ArtifactPatcher.parseSections(diagrams, "diagrams");
    expect(sections).toHaveLength(3);
    expect(sections[0].key).toBe("class_diagram");
    expect(sections[1].key).toBe("activity_diagram");
    expect(sections[2].key).toBe("state_diagram");
  });

  it("handles string diagram as single section", () => {
    const sections = ArtifactPatcher.parseSections("flowchart TD\n  A-->B", "diagrams");
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe("diagram");
  });

  it("handles tests markdown string", () => {
    const md = "## TC-001 Login\n\nTest login\n\n## TC-002 Logout\n\nTest logout";
    const sections = ArtifactPatcher.parseSections(md, "tests");
    expect(sections.length).toBeGreaterThanOrEqual(2);
  });

  it("returns single section for plain text", () => {
    const sections = ArtifactPatcher.parseSections("plain text without headings", "design");
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe("full");
  });

  it("handles null/undefined content", () => {
    const sections = ArtifactPatcher.parseSections(null, "design");
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe("full");
    expect(sections[0].content).toBe("");
  });
});

describe("ArtifactPatcher.applyPatches", () => {
  it("replaces a section by key", () => {
    const sections = [
      { key: "A", content: "old A" },
      { key: "B", content: "old B" },
    ];
    const patched = ArtifactPatcher.applyPatches(sections, [
      { op: "replace_section", section: "A", content: "new A" },
    ]);
    expect(patched).toContain("new A");
    expect(patched).toContain("old B");
    expect(patched).not.toContain("old A");
  });

  it("replaces section by case-insensitive partial match", () => {
    const sections = [
      { key: "3.2 Module Design", content: "old content" },
    ];
    const patched = ArtifactPatcher.applyPatches(sections, [
      { op: "replace_section", section: "Module Design", content: "new content" },
    ]);
    expect(patched).toContain("new content");
    expect(patched).not.toContain("old content");
  });

  it("inserts after a section", () => {
    const sections = [
      { key: "A", content: "content A" },
      { key: "B", content: "content B" },
    ];
    const patched = ArtifactPatcher.applyPatches(sections, [
      { op: "insert_after", section: "A", content: "## A-Plus\n\ninserted content" },
    ]);
    expect(patched).toContain("content A");
    expect(patched).toContain("inserted content");
    expect(patched).toContain("content B");
  });

  it("removes a section", () => {
    const sections = [
      { key: "A", content: "content A" },
      { key: "B", content: "content B" },
    ];
    const patched = ArtifactPatcher.applyPatches(sections, [
      { op: "remove_section", section: "A" },
    ]);
    expect(patched).not.toContain("content A");
    expect(patched).toContain("content B");
  });

  it("ignores patch for non-existent section", () => {
    const sections = [
      { key: "A", content: "content A" },
    ];
    const patched = ArtifactPatcher.applyPatches(sections, [
      { op: "replace_section", section: "Z", content: "new Z" },
    ]);
    expect(patched).toContain("content A");
  });

  it("handles multiple patches in sequence", () => {
    const sections = [
      { key: "A", content: "old A" },
      { key: "B", content: "old B" },
      { key: "C", content: "old C" },
    ];
    const patched = ArtifactPatcher.applyPatches(sections, [
      { op: "replace_section", section: "A", content: "new A" },
      { op: "remove_section", section: "B" },
    ]);
    expect(patched).toContain("new A");
    expect(patched).not.toContain("old A");
    expect(patched).not.toContain("old B");
    expect(patched).toContain("old C");
  });
});

describe("ArtifactPatcher.reconstruct", () => {
  it("reconstructs markdown with ## headings", () => {
    const sections = [
      { key: "Title", content: "# Title\n\nIntro" },
      { key: "Section A", content: "## Section A\n\nContent A" },
      { key: "Section B", content: "## Section B\n\nContent B" },
    ];
    const result = ArtifactPatcher.reconstruct(sections, "design");
    expect(result).toContain("## Section A");
    expect(result).toContain("## Section B");
    expect(result).toContain("Content A");
  });

  it("reconstructs diagrams as dict", () => {
    const sections = [
      { key: "class_diagram", content: "classDiagram\nclass Order" },
      { key: "state_diagram", content: "stateDiagram-v2\n  [*] --> S1" },
    ];
    const result = ArtifactPatcher.reconstruct(sections, "diagrams");
    expect(result).toEqual({
      class_diagram: "classDiagram\nclass Order",
      state_diagram: "stateDiagram-v2\n  [*] --> S1",
    });
  });

  it("reconstructs tests as string", () => {
    const sections = [
      { key: "TC-001", content: "## TC-001\n\ntest body" },
    ];
    const result = ArtifactPatcher.reconstruct(sections, "tests");
    expect(typeof result).toBe("string");
    expect(result).toContain("TC-001");
  });
});

describe("ArtifactPatcher.validateResult", () => {
  it("rejects result shorter than 50% of original", () => {
    expect(ArtifactPatcher.validateResult("1234567890", "12")).toBe(false);
  });

  it("accepts result of reasonable length", () => {
    expect(ArtifactPatcher.validateResult("1234567890", "12345")).toBe(true);
  });

  it("accepts result longer than original", () => {
    expect(ArtifactPatcher.validateResult("12345", "123456789012345")).toBe(true);
  });

  it("accepts any non-empty result when original is empty", () => {
    expect(ArtifactPatcher.validateResult("", "anything")).toBe(true);
  });
});

describe("ArtifactPatcher.sectionListing", () => {
  it("formats section listing", () => {
    const sections = [
      { key: "A", content: "x".repeat(100) },
      { key: "B", content: "y".repeat(50) },
    ];
    const listing = ArtifactPatcher.sectionListing(sections);
    expect(listing).toContain('"A"');
    expect(listing).toContain("100 chars");
    expect(listing).toContain('"B"');
    expect(listing).toContain("50 chars");
  });
});
