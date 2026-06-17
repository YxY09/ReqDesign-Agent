// Phase 2.5 mutant judge smoke test — drives the REAL LLM judge against
// M1..M5 mutant artifacts and compares per-obligation scores against the
// hand-written expected_scores.json. Verification-only: writes a report,
// does NOT touch any business source.
//
// Usage: node scripts/mutant_judge_smoke.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { AgentConfig } from "../dist/src/config.js";
import { LLMClient } from "../dist/src/llmClient.js";
import {
  judgeAgainstGold,
  aggregateQuality,
  FINAL_SCORE_WEIGHTS,
} from "../dist/src/benchmark/qualityJudge.js";
import { loadGoldContract } from "../dist/src/benchmark/goldObligation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const MUTANTS = [
  "M1_shallow_coverage",
  "M2_fake_traceability",
  "M3_missing_exception",
  "M4_hallucinated_test",
  "M5_wrong_design_decision",
];

const CASE_ID = "hospital_mgmt";
const GOLD_PATH = join(ROOT, "benchmark", "gold_contracts", `${CASE_ID}.json`);
const REQ_SOURCE_PATH = join(ROOT, "benchmark", "cases", `${CASE_ID}.md`);
const MUTANTS_DIR = join(ROOT, "benchmark", "mutants");

function log(...args) {
  // datestamp but no secrets
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

async function main() {
  log("Loading config (env already copied to .env)");
  const config = AgentConfig.loadFromYaml(join(ROOT, "config.yaml"));
  log(
    `Provider=${config.llm.provider} model=${config.llm.model} baseUrl=${config.llm.baseUrl || "(default)"}`,
  );
  const apiKey = config.getApiKey();
  if (!apiKey) {
    throw new Error("FATAL: no API key resolved from env/config");
  }
  log("API key present (not printed)");

  const judge = new LLMClient(config);

  const gold = loadGoldContract(GOLD_PATH);
  if (!gold) throw new Error(`FATAL: could not load gold contract at ${GOLD_PATH}`);
  log(`Gold loaded: ${gold.obligations.length} obligations`);

  const requirementSource = existsSync(REQ_SOURCE_PATH)
    ? readFileSync(REQ_SOURCE_PATH, "utf8")
    : "";
  if (!requirementSource) throw new Error("FATAL: requirement source empty");

  const report = {
    generated_at: new Date().toISOString(),
    case_id: CASE_ID,
    provider: config.llm.provider,
    model: config.llm.model,
    n_obligations: gold.obligations.length,
    weights: FINAL_SCORE_WEIGHTS,
    mutants: [],
  };

  for (const mutantId of MUTANTS) {
    const mutantDir = join(MUTANTS_DIR, mutantId);
    const designPath = join(mutantDir, "design", "system_design.md");
    const testsPath = join(mutantDir, "tests", "test_cases.md");
    const expectedPath = join(mutantDir, "expected_scores.json");

    log(`=== ${mutantId} ===`);
    const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
    const designText = readFileSync(designPath, "utf8");
    const testsText = readFileSync(testsPath, "utf8");
    log(`  design=${designText.length}ch tests=${testsText.length}ch`);

    const start = Date.now();
    // Bug1 fix: pass the per-mutant traceability_matrix.json so the judge's
    // judgeTraceChain step actually runs (otherwise matrix=null ⇒ the chain
    // truthfulness check — weakness 2 — never executes). Mirrors production
    // benchmarkRunner.ts, which always passes matrixPath.
    const matrixPath = join(mutantDir, "traces", "traceability_matrix.json");
    const matrixExists = existsSync(matrixPath);
    const { verdicts, quality } = await judgeAgainstGold(
      judge,
      gold,
      {
        requirement_source: requirementSource,
        designPath,
        testsPath,
        ...(matrixExists ? { matrixPath } : {}),
      },
    );
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`  matrix=${matrixExists ? matrixPath : "(none)"}`);
    log(`  judged ${verdicts.length} obligations in ${elapsed}s`);

    // Per-obligation comparison
    const perObligation = verdicts.map((v) => {
      const exp = expected.expected_per_obligation[v.obligation_id];
      const maxScore = exp ? exp.max_score : null;
      const within = maxScore === null ? null : v.score <= maxScore;
      return {
        obligation_id: v.obligation_id,
        score: v.score,
        score_basis: v.score_basis,
        rubric_downgraded: v.rubric_downgraded,
        // Bug2 fix: surface the two weakness-1/weakness-2 booleans + their
        // reasons so the report can prove checkContradiction did (not) fire
        // and judgeTraceChain's verdict is observable. All are undefined when
        // the corresponding step did not run.
        has_contradiction: v.has_contradiction,
        trace_chain_truthful: v.trace_chain_truthful,
        contradiction_reason: v.contradiction_reason ?? null,
        chain_reason: v.chain_reason ?? null,
        expected_max: maxScore,
        within_expected_max: within,
        expected_rationale: exp ? exp.rationale : null,
        extracted_design_evidence: v.extracted_design_evidence,
        extracted_test_evidence: v.extracted_test_evidence,
        missing_evidence: v.missing_evidence,
        reason: v.reason,
      };
    });

    // Summary metrics
    const allWithin = perObligation.every(
      (p) => p.within_expected_max === true,
    );
    const violating = perObligation.filter((p) => p.within_expected_max === false);

    const mutantReport = {
      mutant_id: mutantId,
      description: expected.description,
      elapsed_seconds: Number(elapsed),
      expected_direction: expected.expected_quality_direction,
      actual_quality: quality,
      per_obligation: perObligation,
      all_obligations_within_expected_max: allWithin,
      obligations_violating_expected_max: violating.map((v) => ({
        obligation_id: v.obligation_id,
        actual_score: v.score,
        expected_max: v.expected_max,
        expected_rationale: v.expected_rationale,
        reason: v.reason,
      })),
    };
    report.mutants.push(mutantReport);

    log(`  quality=${JSON.stringify(quality)}`);
    log(`  allWithin=${allWithin} violating=${violating.length}`);
  }

  const outPath = join(ROOT, "benchmark", "mutants", "phase25_judge_report.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  log(`Report written to ${outPath}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
