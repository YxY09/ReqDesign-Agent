/**
 * Benchmark DATASET checks — no LLM required.
 *
 * The benchmark runner drives a real LLM (covered elsewhere). These tests pin
 * the *dataset*: that every gold label is well-formed, that the gold is wired
 * to the coverage judge (a judge that covers everything scores 100; one that
 * covers nothing scores 0), and that the external PROMISE adapter maps real
 * rows into the gold schema correctly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { judgeCoverage, type JudgeClient, type GoldLabel } from "../src/benchmark/scorer.js";
import {
  parsePromiseCsv,
  promiseRowsToCases,
} from "../benchmark/adapters/promise_to_cases.mjs";

const GOLD_DIR = "benchmark/gold_labels";
const GOLD_TO_LABEL: Record<string, string> = {
  expected_actors: "actors",
  expected_functions: "functions",
  expected_entities: "entities",
  expected_constraints: "constraints",
  expected_exceptions: "exceptions",
  expected_processes: "processes",
};
const EXPECTED_KEYS = Object.keys(GOLD_TO_LABEL);

function loadGold(name: string): GoldLabel {
  return JSON.parse(readFileSync(join(GOLD_DIR, name), "utf8"));
}

/** A judge that reports every gold item as covered (no LLM). */
function allCoveredJudge(gold: GoldLabel): JudgeClient {
  const verdict: Record<string, unknown> = {};
  for (const [goldKey, label] of Object.entries(GOLD_TO_LABEL)) {
    verdict[label] = { covered: (gold as Record<string, string[]>)[goldKey] ?? [], missing: [] };
  }
  return { generateJson: async () => verdict };
}

describe("benchmark gold labels are well-formed", () => {
  const goldFiles = readdirSync(GOLD_DIR).filter((f) => f.endsWith(".json"));

  it("has at least one gold label", () => {
    expect(goldFiles.length).toBeGreaterThan(0);
  });

  for (const file of goldFiles) {
    it(`${file} parses and has the six expected_* string arrays`, () => {
      const gold = loadGold(file) as Record<string, unknown>;
      for (const key of EXPECTED_KEYS) {
        expect(Array.isArray(gold[key]), `${file} missing array ${key}`).toBe(true);
        for (const item of gold[key] as unknown[]) {
          expect(typeof item).toBe("string");
        }
      }
    });
  }
});

describe("gold is wired to the coverage judge", () => {
  it("a fully-covering judge scores 100 against the ecommerce gold", async () => {
    const gold = loadGold("ecommerce_order_system.json");
    const { score } = await judgeCoverage(allCoveredJudge(gold), gold, {});
    expect(score).toBe(100);
  });

  it("a non-covering judge scores 0", async () => {
    const gold = loadGold("hospital_mgmt.json");
    const judge: JudgeClient = { generateJson: async () => ({}) };
    const { score } = await judgeCoverage(judge, gold, {});
    expect(score).toBe(0);
  });
});

describe("PROMISE adapter maps real rows into the gold schema", () => {
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
