/**
 * Diagnostic: dump per-obligation judge verdicts for ONE side of ONE compare
 * case, so we can see WHICH obligations are judged aligned and WHY. No report
 * is written. Usage: npx tsx scripts/diag_case.mts <case_id> <agent|baseline> [SRC_RUN]
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { AgentConfig } from "../src/config.ts";
import { LLMClient } from "../src/llmClient.ts";
import { loadGoldContract } from "../src/benchmark/goldObligation.ts";
import { judgeAgainstGold } from "../src/benchmark/qualityJudge.ts";
import type { JudgeClient } from "../src/benchmark/judgeClient.ts";

const ROOT = process.cwd();
const caseId = process.argv[2] ?? "hospital_mgmt";
const side = process.argv[3] ?? "agent";
const srcRun = process.argv[4] ?? "full-v27";
const outputDir = join(ROOT, "benchmark", "results", "compare", srcRun, caseId, side);

const config = AgentConfig.loadFromYaml(join(ROOT, "config.yaml"));
const judge = new LLMClient(config) as unknown as JudgeClient;
const gold = loadGoldContract(join(ROOT, "benchmark", "gold_contracts", `${caseId}.json`))!;
const requirement_source = readFileSync(join(ROOT, "benchmark", "cases", `${caseId}.md`), "utf8");

const { verdicts, quality } = await judgeAgainstGold(judge, gold, {
  requirement_source,
  designPath: join(outputDir, "design", "system_design.md"),
  testsPath: join(outputDir, "tests", "test_cases.json"),
  matrixPath: join(outputDir, "traces", "traceability_matrix.json"),
});

console.log(`\n${caseId} / ${side}  quality:`, JSON.stringify(quality), "\n");
console.log("obID    score rule trig hand testAlign  reason / test-evidence");
console.log("-".repeat(100));
for (const v of verdicts) {
  const b = v.score_basis;
  const flag = (x: boolean) => (x ? "Y" : ".");
  const te = v.extracted_test_evidence[0] ? ` | te="${v.extracted_test_evidence[0].slice(0, 50)}"` : " | te=(none)";
  console.log(
    `${v.obligation_id.padEnd(7)} ${v.score}    ${flag(b.has_concrete_rule)}    ${flag(b.has_trigger_condition)}    ${flag(b.has_handling_behavior)}    ${flag(b.has_test_alignment)}      ${v.reason.slice(0, 60)}${te}`,
  );
}
