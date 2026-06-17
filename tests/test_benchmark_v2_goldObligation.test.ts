/**
 * Phase-2 unit tests: goldObligation.ts — schema validation + disk loader.
 * Fully offline; no LLM.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateGoldContract,
  loadGoldContract,
  GoldContractError,
  type GoldContract,
} from "../src/benchmark/goldObligation.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gold-obl-"));
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** A minimal-but-valid contract used as the happy-path baseline. */
function validContract(): GoldContract {
  return {
    case_id: "hospital_mgmt",
    source_language: "zh",
    canonical_language: "en",
    obligations: [
      {
        id: "C-001",
        type: "constraint",
        severity: "major",
        source_span: "每位医生每日限号 50",
        expected_design_evidence: ["每日 50 的硬性校验"],
        expected_test_evidence: ["第 51 个被拒绝"],
        anti_patterns: ["只挂 ID 无数值规则"],
      },
      {
        id: "X-002",
        type: "exception",
        severity: "major",
        source_span: "过敏检测自动拦截",
        expected_design_evidence: ["开方时过敏拦截"],
        expected_test_evidence: ["过敏药品被拦截"],
        anti_patterns: ["只记录不拦截"],
      },
    ],
  };
}

describe("validateGoldContract — happy path", () => {
  it("accepts a valid contract covering all three obligation types", () => {
    const c = validContract();
    c.obligations.push({
      id: "F-006",
      type: "functional",
      severity: "minor",
      source_span: "处方状态流转",
      expected_design_evidence: ["开立→审核→收费→发药"],
      expected_test_evidence: [],
      anti_patterns: [],
    });
    expect(validateGoldContract(c)).toBe(true);
  });
});

describe("validateGoldContract — rejections", () => {
  it("rejects a non-object", () => {
    expect(() => validateGoldContract(null)).toThrow(GoldContractError);
    expect(() => validateGoldContract("x")).toThrow(GoldContractError);
  });

  it("rejects the Phase-1 placeholder `{}` (no obligations)", () => {
    // This is the key guarantee: a Phase-1 `{}` gold-label stub must NOT be
    // treated as a Phase-2 gold contract, so the runner skips the judge.
    // (It fails the first required-field check, case_id, before obligations.)
    expect(() => validateGoldContract({})).toThrow(GoldContractError);
  });

  it("rejects missing/empty case_id", () => {
    const c = validContract() as unknown as Record<string, unknown>;
    delete c.case_id;
    expect(() => validateGoldContract(c)).toThrow(/case_id/);
  });

  it("rejects an invalid obligation type", () => {
    const c = validContract();
    (c.obligations[0] as unknown as { type: string }).type = "bogus";
    expect(() => validateGoldContract(c)).toThrow(/type/);
  });

  it("rejects an invalid severity", () => {
    const c = validContract();
    (c.obligations[0] as unknown as { severity: string }).severity = "critical";
    expect(() => validateGoldContract(c)).toThrow(/severity/);
  });

  it("rejects duplicate obligation ids", () => {
    const c = validContract();
    c.obligations[1].id = c.obligations[0].id;
    expect(() => validateGoldContract(c)).toThrow(/duplicate/);
  });

  it("rejects an obligation with empty expected_design_evidence", () => {
    const c = validContract();
    c.obligations[0].expected_design_evidence = [];
    expect(() => validateGoldContract(c)).toThrow(/expected_design_evidence/);
  });

  it("rejects an obligation with non-string evidence entries", () => {
    const c = validContract();
    (c.obligations[0].expected_design_evidence as unknown[]).push(42);
    expect(() => validateGoldContract(c)).toThrow(/expected_design_evidence/);
  });
});

describe("loadGoldContract", () => {
  it("loads + validates a valid contract from disk", () => {
    const path = join(root, "hospital_mgmt.json");
    writeFileSync(path, JSON.stringify(validContract()), "utf8");
    const loaded = loadGoldContract(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.obligations).toHaveLength(2);
  });

  it("returns null when the file is absent", () => {
    expect(loadGoldContract(join(root, "nope.json"))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const path = join(root, "bad.json");
    writeFileSync(path, "{not json", "utf8");
    expect(loadGoldContract(path)).toBeNull();
  });

  it("returns null for a structurally-invalid contract (e.g. Phase-1 `{}`)", () => {
    const path = join(root, "empty.json");
    writeFileSync(path, "{}", "utf8");
    expect(loadGoldContract(path)).toBeNull();
  });

  it("loads the real hospital_mgmt gold contract shipped with the repo", () => {
    const loaded = loadGoldContract(join("benchmark", "gold_contracts", "hospital_mgmt.json"));
    expect(loaded).not.toBeNull();
    expect(loaded!.case_id).toBe("hospital_mgmt");
    // Spec: 5-8 key obligations covering all three types.
    expect(loaded!.obligations.length).toBeGreaterThanOrEqual(5);
    expect(loaded!.obligations.length).toBeLessThanOrEqual(9);
    const types = new Set(loaded!.obligations.map((o) => o.type));
    expect(types.has("constraint")).toBe(true);
    expect(types.has("functional")).toBe(true);
    expect(types.has("exception")).toBe(true);
    // IDs are anchored to the original source (C-/F-/X-), not the generated
    // coverage-matrix renumbering.
    for (const o of loaded!.obligations) {
      expect(o.id).toMatch(/^[CFX]-\d{3}$/);
    }
  });
});
