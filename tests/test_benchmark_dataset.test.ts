/**
 * Benchmark DATASET checks — no LLM required.
 *
 * The benchmark runner itself drives a real LLM (covered elsewhere). These
 * tests pin the *dataset*: that every gold label is well-formed, that the gold
 * is actually wired to the scorer (a perfect analysis scores 100), and that the
 * external PROMISE adapter maps real rows into the gold schema correctly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scoreRequirementCoverage } from "../src/benchmark/scorer.js";
import {
  parsePromiseCsv,
  promiseRowsToCases,
} from "../benchmark/adapters/promise_to_cases.mjs";

const GOLD_DIR = "benchmark/gold_labels";
const EXPECTED_KEYS = [
  "expected_actors",
  "expected_functions",
  "expected_entities",
  "expected_constraints",
  "expected_exceptions",
  "expected_processes",
];

function loadGold(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(GOLD_DIR, name), "utf8"));
}

describe("benchmark gold labels are well-formed", () => {
  const goldFiles = readdirSync(GOLD_DIR).filter((f) => f.endsWith(".json"));

  it("has at least one gold label", () => {
    expect(goldFiles.length).toBeGreaterThan(0);
  });

  for (const file of goldFiles) {
    it(`${file} parses and has the six expected_* string arrays`, () => {
      const gold = loadGold(file);
      for (const key of EXPECTED_KEYS) {
        expect(Array.isArray(gold[key]), `${file} missing array ${key}`).toBe(true);
        for (const item of gold[key] as unknown[]) {
          expect(typeof item).toBe("string");
        }
      }
    });
  }
});

describe("gold is wired to the scorer", () => {
  it("a perfect analysis scores 100 against the ecommerce gold", () => {
    const gold = loadGold("ecommerce_order_system.json");
    const perfect = {
      actors: gold.expected_actors,
      functions: (gold.expected_functions as string[]).map((name) => ({ name })),
      entities: (gold.expected_entities as string[]).map((name) => ({ name })),
      constraints: (gold.expected_constraints as string[]).map((description) => ({ description })),
      exceptions: (gold.expected_exceptions as string[]).map((description) => ({ description })),
    };
    expect(scoreRequirementCoverage(perfect, gold)).toBe(100);
  });

  it("an empty analysis scores 0", () => {
    const gold = loadGold("hospital_mgmt.json");
    expect(scoreRequirementCoverage({}, gold)).toBe(0);
  });
});

describe("PROMISE adapter maps real rows into the gold schema", () => {
  // A small slice in the real PROMISE CSV shape (PROJECT,REQUIREMENT,LABEL),
  // including a quoted field containing a comma and a header row to skip.
  const csv = [
    "PROJECT,REQUIREMENT,LABEL",
    "1,The system shall let the user search events,F",
    '1,"The system shall refresh the display, every 60 seconds",PE',
    "1,The product shall be available 99% of the time,A",
    "2,The system shall let admins manage accounts,F",
    "2,The system shall encrypt stored passwords,SE",
  ].join("\n");

  it("parses rows, skipping the header and honouring quoted commas", () => {
    const rows = parsePromiseCsv(csv);
    expect(rows).toHaveLength(5);
    expect(rows[1].requirement).toBe("The system shall refresh the display, every 60 seconds");
    expect(rows[1].label).toBe("PE");
  });

  it("groups by project; F→functions, NFR→constraints; other fields empty", () => {
    const cases = promiseRowsToCases(parsePromiseCsv(csv));
    expect(cases.map((c) => c.name).sort()).toEqual(["promise_p01", "promise_p02"]);

    const p1 = cases.find((c) => c.name === "promise_p01")!;
    expect(p1.gold.expected_functions).toEqual(["The system shall let the user search events"]);
    expect(p1.gold.expected_constraints).toHaveLength(2);
    expect(p1.gold.expected_actors).toEqual([]);
    expect(p1.gold.expected_entities).toEqual([]);
    expect(p1.md).toContain("Functional Requirements");
    expect(p1.md).toContain("search events");
  });
});
