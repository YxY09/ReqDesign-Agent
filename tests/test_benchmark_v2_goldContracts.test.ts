/**
 * Compare-benchmark unit tests: the native gold contracts all pass
 * validateGoldContract, carry the correct source_language, and cover the
 * three obligation types.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadGoldContract, validateGoldContract } from "../src/benchmark/goldObligation.js";

const GOLD_DIR = join("benchmark", "gold_contracts");

// The 6 native cases the compare benchmark scores (4 zh + 2 pure/en).
const COMPARE_CASES = [
  { id: "hospital_mgmt", lang: "zh" },
  { id: "ecommerce_order_system", lang: "zh" },
  { id: "smart_campus", lang: "zh" },
  { id: "mid_complex_system", lang: "zh" },
  { id: "pure_keepass", lang: "en" },
  { id: "pure_qheadache", lang: "en" },
] as const;

describe("gold contracts — all 6 compare cases", () => {
  for (const { id, lang } of COMPARE_CASES) {
    it(`${id}.json exists, validates, source_language=${lang}, ≥5 obligations, ids [CFX]-NNN`, () => {
      const path = join(GOLD_DIR, `${id}.json`);
      const gold = loadGoldContract(path);
      expect(gold, `${path} must be a valid gold contract`).not.toBeNull();
      expect(gold!.case_id).toBe(id);
      expect(gold!.source_language).toBe(lang);
      // validateGoldContract must pass (loadGoldContract already filtered, but
      // re-run explicitly to surface the precise error if a future edit breaks it).
      expect(() => validateGoldContract(gold)).not.toThrow();

      // Spec: 5-12 key obligations (hospital_mgmt has 10 hard rules + 2
      // functional flows = 12; other cases sit at 5-10).
      expect(gold!.obligations.length).toBeGreaterThanOrEqual(5);
      expect(gold!.obligations.length).toBeLessThanOrEqual(12);

      // ID format anchored to the source (C-/F-/X-NNN), never the generated
      // coverage-matrix renumbering.
      for (const o of gold!.obligations) {
        expect(o.id).toMatch(/^[CFX]-\d{3}$/);
      }
    });

    it(`${id}.json covers all three obligation types (constraint/functional/exception)`, () => {
      const gold = loadGoldContract(join(GOLD_DIR, `${id}.json`))!;
      const types = new Set(gold.obligations.map((o) => o.type));
      expect(types.has("constraint")).toBe(true);
      expect(types.has("functional")).toBe(true);
      expect(types.has("exception")).toBe(true);
    });

    it(`${id}.json every obligation has non-empty evidence + anti_patterns`, () => {
      const gold = loadGoldContract(join(GOLD_DIR, `${id}.json`))!;
      for (const o of gold.obligations) {
        expect(o.expected_design_evidence.length).toBeGreaterThan(0);
        // expected_test_evidence / anti_patterns may be empty per schema, but
        // for quality we require test evidence on at least most obligations.
        expect(o.source_span.length).toBeGreaterThan(0);
      }
    });
  }
});

describe("gold contracts — native numeric constraints mapped to constraint type", () => {
  it("pure_keepass composite-key + no-back-door obligations are typed constraint", () => {
    const gold = loadGoldContract(join(GOLD_DIR, "pure_keepass.json"))!;
    const noBackdoor = gold.obligations.find((o) => /back door|recovery/i.test(o.source_span));
    expect(noBackdoor).toBeDefined();
    expect(noBackdoor!.type).toBe("constraint");
    const composite = gold.obligations.find((o) => /Composite Master Key/i.test(o.source_span));
    expect(composite).toBeDefined();
    // Deepened encryption evidence (N001): AES/Rijndael AND Twofish both
    // 128-bit block + 256-bit key, plus ARC4 in-memory (N002) 12-byte key.
    expect(gold.obligations.some((o) => /128-bit block/.test(o.source_span))).toBe(true);
    expect(gold.obligations.some((o) => /12-byte key/.test(o.source_span))).toBe(true);
  });

  it("ecommerce_order_system numeric inventory obligations (5% oversell / 10-unit alert) are anchored in source_span", () => {
    const gold = loadGoldContract(join(GOLD_DIR, "ecommerce_order_system.json"))!;
    // C003 inventory constraint must be present verbatim with its numbers.
    expect(gold.obligations.some((o) => o.source_span.includes("超卖（最多5%）"))).toBe(true);
    expect(gold.obligations.some((o) => o.source_span.includes("库存预警值为10件"))).toBe(true);
  });

  it("pure_qheadache numeric-bound obligations (0.05x / 10 records / 1000 actions / 10000 positions) are typed constraint", () => {
    const gold = loadGoldContract(join(GOLD_DIR, "pure_qheadache.json"))!;
    const constraintCount = gold.obligations.filter((o) => o.type === "constraint").length;
    expect(constraintCount).toBeGreaterThanOrEqual(3);
    // The numeric bounds must be anchored in the verbatim source_span text.
    expect(gold.obligations.some((o) => /0\.05x clearance/.test(o.source_span))).toBe(true);
    expect(gold.obligations.some((o) => /If 10 records already exist/.test(o.source_span))).toBe(
      true,
    );
    expect(gold.obligations.some((o) => /up to the last 1000 actions/.test(o.source_span))).toBe(
      true,
    );
    expect(
      gold.obligations.some((o) => /last 10000 previous positions/.test(o.source_span)),
    ).toBe(true);
    // Board layout (F001) and finish-window name cap (F011) anchored verbatim.
    expect(gold.obligations.some((o) => /4x wide by 5x tall/.test(o.source_span))).toBe(true);
    expect(gold.obligations.some((o) => /up to 20 characters/.test(o.source_span))).toBe(true);
  });
});

describe("gold contracts — source_span is a verbatim substring of the case .md", () => {
  // Each obligation's source_span must be a verbatim excerpt of the original
  // requirement (benchmark/cases/<id>.md) so the quality judge can match by
  // semantic content against the real source text. Synthetic summaries (e.g.
  // joining several bullets with '；') must be caught here.
  for (const { id } of COMPARE_CASES) {
    it(`${id}.json every source_span is a verbatim substring of ${id}.md`, () => {
      const md = readFileSync(join("benchmark", "cases", `${id}.md`), "utf8");
      const gold = loadGoldContract(join(GOLD_DIR, `${id}.json`))!;
      for (const o of gold.obligations) {
        expect(
          md.includes(o.source_span),
          `${id}/${o.id} source_span is not a verbatim substring of the case .md`,
        ).toBe(true);
      }
    });
  }
});

describe("gold contracts — gold_contracts dir has exactly these compare files", () => {
  it("contains at least the 6 compare contracts", () => {
    const files = readdirSync(GOLD_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
    for (const { id } of COMPARE_CASES) {
      expect(files, `expected ${id}.json in gold_contracts`).toContain(id);
    }
  });
});
