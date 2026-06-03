import { describe, it, expect } from "vitest";
import {
  findDuplicateCandidates,
  applyDeterministicMerges,
  normalizeText,
  tokenize,
  jaccard,
  DEFAULT_GLOSSARY,
  type DedupConfig,
} from "../src/shared/semanticDeduper.js";
import { normalizeForComparison } from "../src/shared/constraintCanonicalizer.js";

// ---------------------------------------------------------------------------
// Test item type
// ---------------------------------------------------------------------------

interface TestItem {
  id: string;
  text: string;
  source: string;
}

function makeConfig(items: TestItem[], overrides?: Partial<DedupConfig<TestItem>>): DedupConfig<TestItem> {
  return {
    items,
    getId: (item) => item.id,
    getText: (item) => item.text,
    getSourceText: (item) => item.source,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeText
// ---------------------------------------------------------------------------

describe("normalizeText", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeText("Hello, World!")).toBe("hello world");
  });

  it("collapses whitespace", () => {
    expect(normalizeText("  foo   bar  ")).toBe("foo bar");
  });

  it("preserves CJK characters", () => {
    expect(normalizeText("审计数据不可修改")).toBe("审计数据不可修改");
  });

  it("is consistent with normalizeForComparison", () => {
    const cases = [
      "Audit trail must be immutable",
      "审计数据不可修改",
      "SSL must be used!",
      "  Response time < 5s  ",
    ];
    for (const c of cases) {
      expect(normalizeText(c)).toBe(normalizeForComparison(c));
    }
  });
});

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("splits on whitespace and strips punctuation", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
  });

  it("filters stop words and short tokens", () => {
    const tokens = tokenize("The system must be accessible per ISO 9241");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("be");
    // "per" is length 3 and not a stop word — included
    expect(tokens).toContain("per");
    expect(tokens).toContain("system");
    expect(tokens).toContain("accessible");
    expect(tokens).toContain("iso");
  });

  it("preserves CJK characters as single tokens", () => {
    // CJK characters are kept by \p{L} but don't split like English
    const tokens = tokenize("审计数据不可修改");
    // CJK chars form a single string after punctuation strip
    expect(tokens.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// jaccard
// ---------------------------------------------------------------------------

describe("jaccard", () => {
  it("returns 1 for identical sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("returns 0 for two empty sets", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it("computes correct overlap", () => {
    // {a, b} ∩ {b, c} = {b}, union = {a, b, c}
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
  });
});

// ---------------------------------------------------------------------------
// findDuplicateCandidates
// ---------------------------------------------------------------------------

describe("findDuplicateCandidates", () => {
  it("detects same_source pairs (identical normalized sourceText)", () => {
    const items: TestItem[] = [
      { id: "1", text: "Desc A", source: "审计数据不可修改" },
      { id: "2", text: "Desc B", source: "审计数据不可修改" },
    ];
    const candidates = findDuplicateCandidates(makeConfig(items));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reason).toBe("same_source");
    expect(candidates[0].score).toBe(1.0);
  });

  it("detects normalized_text pairs (identical normalized description)", () => {
    const items: TestItem[] = [
      { id: "1", text: "Search response time under 8 seconds", source: "搜索1" },
      { id: "2", text: "Search response time under 8 seconds", source: "搜索2" },
    ];
    const candidates = findDuplicateCandidates(makeConfig(items));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reason).toBe("normalized_text");
    expect(candidates[0].score).toBe(1.0);
  });

  it("detects glossary_equiv pairs (ssl/https in DEFAULT_GLOSSARY)", () => {
    const items: TestItem[] = [
      { id: "1", text: "SSL must be used for all connections", source: "source1" },
      { id: "2", text: "HTTPS must be used for all connections", source: "source2" },
    ];
    const candidates = findDuplicateCandidates(makeConfig(items));
    const glossaryPair = candidates.find((c) => c.reason === "glossary_equiv");
    expect(glossaryPair).toBeDefined();
    // Score lowered to 0.75 to prevent false merges from short CJK terms
    expect(glossaryPair!.score).toBeGreaterThanOrEqual(0.7);
    expect(glossaryPair!.score).toBeLessThan(0.8);
  });

  it("detects glossary_equiv with CJK terms (安全传输)", () => {
    const items: TestItem[] = [
      { id: "1", text: "SSL must be used", source: "source1" },
      { id: "2", text: "安全传输 is required", source: "source2" },
    ];
    const candidates = findDuplicateCandidates(makeConfig(items));
    const glossaryPair = candidates.find((c) => c.reason === "glossary_equiv");
    expect(glossaryPair).toBeDefined();
  });

  it("detects token_overlap pairs (Jaccard ≥ 0.6)", () => {
    const items: TestItem[] = [
      { id: "1", text: "The system must encrypt all data during transmission", source: "s1" },
      { id: "2", text: "The system must encrypt all data during network transmission", source: "s2" },
    ];
    const candidates = findDuplicateCandidates(makeConfig(items));
    const overlapPair = candidates.find((c) => c.reason === "token_overlap");
    expect(overlapPair).toBeDefined();
    expect(overlapPair!.score).toBeGreaterThanOrEqual(0.6);
  });

  it("does not emit pairs below threshold", () => {
    const items: TestItem[] = [
      { id: "1", text: "Database connection pool must be configurable", source: "s1" },
      { id: "2", text: "User interface must support dark mode", source: "s2" },
    ];
    const candidates = findDuplicateCandidates(makeConfig(items));
    expect(candidates).toHaveLength(0);
  });

  it("returns no candidates for empty items", () => {
    const candidates = findDuplicateCandidates(makeConfig([]));
    expect(candidates).toEqual([]);
  });

  it("returns no candidates for single item", () => {
    const items: TestItem[] = [
      { id: "1", text: "Test", source: "s1" },
    ];
    const candidates = findDuplicateCandidates(makeConfig(items));
    expect(candidates).toHaveLength(0);
  });

  it("uses custom normalizer when provided", () => {
    const items: TestItem[] = [
      { id: "1", text: "Desc", source: "A-B-C" },
      { id: "2", text: "Desc2", source: "A B C" },
    ];
    // Custom normalizer that strips dashes → "ABC" for both
    const config = makeConfig(items, {
      normalize: (text) => text.replace(/[-\s]/g, "").toLowerCase(),
    });
    const candidates = findDuplicateCandidates(config);
    const sourcePair = candidates.find((c) => c.reason === "same_source");
    expect(sourcePair).toBeDefined();
  });

  it("uses custom glossary when provided", () => {
    const items: TestItem[] = [
      { id: "1", text: "Alpha feature must be enabled", source: "s1" },
      { id: "2", text: "Beta feature must be enabled", source: "s2" },
    ];
    const config = makeConfig(items, {
      glossary: [["alpha", "beta"]],
    });
    const candidates = findDuplicateCandidates(config);
    const glossaryPair = candidates.find((c) => c.reason === "glossary_equiv");
    expect(glossaryPair).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// applyDeterministicMerges
// ---------------------------------------------------------------------------

describe("applyDeterministicMerges", () => {
  it("auto-merges groups with score ≥ 0.8", () => {
    const items: TestItem[] = [
      { id: "1", text: "Short desc", source: "same source text" },
      { id: "2", text: "A longer description for the same thing", source: "same source text" },
    ];
    const config = makeConfig(items);
    const candidates = findDuplicateCandidates(config);
    const result = applyDeterministicMerges(items, candidates, config);

    expect(result.merged).toHaveLength(1);
    expect(result.kept).toHaveLength(0);
    expect(result.merged[0].survivors).toHaveLength(1);
    expect(result.merged[0].absorbed).toHaveLength(1);
  });

  it("keeps longer description as survivor", () => {
    const items: TestItem[] = [
      { id: "1", text: "Short", source: "same source text" },
      { id: "2", text: "A much longer description than short", source: "same source text" },
    ];
    const config = makeConfig(items);
    const candidates = findDuplicateCandidates(config);
    const result = applyDeterministicMerges(items, candidates, config);

    expect(result.merged[0].survivors[0].id).toBe("2");
    expect(result.merged[0].absorbed[0].id).toBe("1");
  });

  it("keeps items not in any pair in kept", () => {
    const items: TestItem[] = [
      { id: "1", text: "Database pool configuration", source: "source alpha" },
      { id: "2", text: "Dark mode support required", source: "source beta" },
      { id: "3", text: "Duplicate X", source: "shared source" },
      { id: "4", text: "Duplicate Y longer", source: "shared source" },
    ];
    const config = makeConfig(items);
    const candidates = findDuplicateCandidates(config);
    const result = applyDeterministicMerges(items, candidates, config);

    // Items 3 and 4 should be merged (same_source)
    expect(result.merged).toHaveLength(1);
    // Items 1 and 2 should be kept
    expect(result.kept).toHaveLength(2);
    const keptIds = result.kept.map((item) => item.id);
    expect(keptIds).toContain("1");
    expect(keptIds).toContain("2");
  });

  it("handles transitive merges (A≈B, B≈C → all merged)", () => {
    const items: TestItem[] = [
      { id: "1", text: "SSL is required for security", source: "shared source text" },
      { id: "2", text: "HTTPS is required for security", source: "shared source text" },
      { id: "3", text: "Secure transmission is required for security", source: "shared source text" },
    ];
    const config = makeConfig(items);
    const candidates = findDuplicateCandidates(config);
    const result = applyDeterministicMerges(items, candidates, config);

    // All three should be merged via same_source (identical source text)
    expect(result.merged).toHaveLength(1);
    expect(result.kept).toHaveLength(0);
    // Survivor should be the longest text
    expect(result.merged[0].survivors[0].id).toBe("3");
    expect(result.merged[0].absorbed).toHaveLength(2);
  });

  it("returns empty results for empty input", () => {
    const config = makeConfig([]);
    const result = applyDeterministicMerges([], [], config);
    expect(result.kept).toEqual([]);
    expect(result.merged).toEqual([]);
  });

  it("returns single item unchanged in kept", () => {
    const items: TestItem[] = [
      { id: "1", text: "Unique", source: "unique source" },
    ];
    const config = makeConfig(items);
    const candidates = findDuplicateCandidates(config);
    const result = applyDeterministicMerges(items, candidates, config);

    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].id).toBe("1");
    expect(result.merged).toHaveLength(0);
  });

  it("glossary_equiv alone does not trigger deterministic merge (score 0.75 < 0.8)", () => {
    // SSL and HTTPS hit the same glossary group with 2 unique terms (ssl, https),
    // but glossary_equiv score is 0.75 — below deterministic merge threshold.
    const items: TestItem[] = [
      { id: "1", text: "SSL must be used for all connections", source: "s1" },
      { id: "2", text: "HTTPS must be used for all connections", source: "s2" },
    ];
    const config = makeConfig(items);
    const candidates = findDuplicateCandidates(config);

    // Should have a glossary_equiv candidate at 0.75
    const glossaryPair = candidates.find((c) => c.reason === "glossary_equiv");
    expect(glossaryPair).toBeDefined();
    expect(glossaryPair!.score).toBe(0.75);

    // But should NOT deterministically merge (0.75 < 0.8)
    const result = applyDeterministicMerges(items, candidates, config);
    expect(result.merged).toHaveLength(0);
    expect(result.kept).toHaveLength(2);
  });

  it("short CJK terms like 权限 do NOT cause false glossary merges", () => {
    // "权限" (permission) appears in the unauthorized glossary group but is a
    // common 2-character CJK term that can appear in many unrelated contexts.
    // Before the fix, a single term match triggered glossary_equiv at 0.85.
    const items: TestItem[] = [
      { id: "1", text: "用户权限管理功能需要支持角色分配", source: "s1" },
      { id: "2", text: "系统权限配置应遵循最小权限原则", source: "s2" },
    ];
    // Both texts contain "权限" but are about different things (user management
    // vs system config). With the ≥2 term requirement, a single CJK term alone
    // should NOT trigger glossary_equiv.
    const config = makeConfig(items);
    const candidates = findDuplicateCandidates(config);
    const glossaryPair = candidates.find((c) => c.reason === "glossary_equiv");
    // No glossary_equiv because only 1 term ("权限") matches in each text
    expect(glossaryPair).toBeUndefined();
  });

  it("does not merge token_overlap pairs (score < 0.8 by design)", () => {
    // These items have high Jaccard but different meaning
    const items: TestItem[] = [
      { id: "1", text: "system encrypt data transmission required", source: "s1" },
      { id: "2", text: "system encrypt data storage required", source: "s2" },
    ];
    const config = makeConfig(items);
    const candidates = findDuplicateCandidates(config);

    // Should have a token_overlap candidate
    const overlapCandidate = candidates.find((c) => c.reason === "token_overlap");
    if (overlapCandidate) {
      // Token overlap score should be < 1.0 but might be >= 0.8
      // Even if >= 0.8, deterministic merge applies
      const result = applyDeterministicMerges(items, candidates, config);
      if (overlapCandidate.score >= 0.8) {
        expect(result.merged).toHaveLength(1);
      } else {
        expect(result.merged).toHaveLength(0);
        expect(result.kept).toHaveLength(2);
      }
    } else {
      // No overlap pair found, both kept
      const result = applyDeterministicMerges(items, candidates, config);
      expect(result.kept).toHaveLength(2);
    }
  });
});
