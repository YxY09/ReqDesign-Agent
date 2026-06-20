/**
 * Fresh agent+baseline regeneration for one or more compare cases, then judge —
 * unlike scripts/rejudge_compare.mts (which only re-judges existing artifacts),
 * this RE-RUNS the agent pipeline, so changes to planning/analyze/design/tests
 * (e.g. the authoritative-constraint fix) take effect.
 *
 * Runs each case into the SAME run-id; runCompare's resume accumulates them into
 * one report (original runs like full-v27 are untouched).
 *
 * Usage:
 *   npx tsx scripts/run_compare.mts [runId] [caseId ...]
 *   # defaults: runId=fixc-verify, cases = hospital_mgmt smart_campus
 *   npx tsx scripts/run_compare.mts fixc-verify hospital_mgmt smart_campus
 */
import { AgentConfig } from "../src/config.ts";
import { runCompare } from "../src/benchmark/compareRunner.ts";

const args = process.argv.slice(2);
const runId = args[0] ?? "fixc-verify";
const caseIds = args.length > 1 ? args.slice(1) : ["hospital_mgmt", "smart_campus"];

const config = AgentConfig.loadFromYaml("config.yaml");
console.log(`Fresh compare run "${runId}" — cases: ${caseIds.join(", ")} (model=${config.llm.model})\n`);

let report;
for (const caseId of caseIds) {
  console.log(`\n========== regenerating + judging: ${caseId} ==========`);
  // Same runId each time → runCompare resumes the partial and appends this case.
  report = await runCompare(config, { caseId, runId });
}

console.log("\n================ SUMMARY ================");
for (const c of report?.cases ?? []) {
  const b = c.baseline.quality.final_score;
  const a = c.agent.quality.final_score;
  const win = (a ?? 0) > (b ?? 0) ? "AGENT" : (a ?? 0) < (b ?? 0) ? "baseline" : "tie";
  console.log(`  ${c.case_id.padEnd(22)} baseline=${b}  agent=${a}  -> ${win}`);
}
console.log(`\nreport -> benchmark/results/compare/${runId}/compare_report.md`);
