/**
 * Re-judge an EXISTING compare run's artifacts with the current judge — no
 * agent/baseline regeneration. Reads design/tests from each
 * benchmark/results/compare/<SRC_RUN>/<case>/{agent,baseline}/ and re-runs
 * judgeAgainstGold (via scoreSide), writing a fresh report under <OUT_RUN> so
 * the original report is preserved for comparison.
 *
 * Usage:  npx tsx scripts/rejudge_compare.mts [SRC_RUN] [OUT_RUN]
 *   SRC_RUN defaults to "full-v27", OUT_RUN to "<SRC_RUN>-rejudge".
 */
import { join } from "node:path";
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";

import { AgentConfig } from "../src/config.ts";
import { LLMClient } from "../src/llmClient.ts";
import { loadGoldContract } from "../src/benchmark/goldObligation.ts";
import {
  scoreSide,
  computeDelta,
  aggregateCompare,
  writeReport,
  compareRunPaths,
} from "../src/benchmark/compareRunner.ts";
import type { JudgeClient } from "../src/benchmark/scorer.ts";

const ROOT = process.cwd();
const SRC_RUN = process.argv[2] ?? "full-v27";
const OUT_RUN = process.argv[3] ?? `${SRC_RUN}-rejudge`;
const resultsBaseDir = join(ROOT, "benchmark", "results");
const srcRoot = join(resultsBaseDir, "compare", SRC_RUN);

const config = AgentConfig.loadFromYaml(join(ROOT, "config.yaml"));
const judge = new LLMClient(config) as unknown as JudgeClient;

// Cases = subdirs of the source run that have both agent/ and baseline/.
const caseIds = readdirSync(srcRoot).filter(
  (d) =>
    statSync(join(srcRoot, d)).isDirectory() &&
    existsSync(join(srcRoot, d, "agent")) &&
    existsSync(join(srcRoot, d, "baseline")),
);

// Original report (for a before/after print).
const orig: Record<string, number | null> = {};
const origPath = join(srcRoot, "compare_report.json");
if (existsSync(origPath)) {
  for (const c of JSON.parse(readFileSync(origPath, "utf8")).cases ?? []) {
    orig[`${c.case_id}:b`] = c.baseline?.quality?.final_score ?? null;
    orig[`${c.case_id}:a`] = c.agent?.quality?.final_score ?? null;
  }
}

console.log(`Re-judging ${caseIds.length} cases from ${SRC_RUN} (judge=${config.llm.model})\n`);
console.log("case                       baseline(old→new)   agent(old→new)   winner");
console.log("-".repeat(78));

const cases: unknown[] = [];
for (const caseId of caseIds) {
  const gold = loadGoldContract(join(ROOT, "benchmark", "gold_contracts", `${caseId}.json`));
  if (!gold) {
    console.log(`${caseId}: (no gold contract — skipped)`);
    continue;
  }
  const requirementSource = readFileSync(join(ROOT, "benchmark", "cases", `${caseId}.md`), "utf8");
  const baseline = await scoreSide(judge, gold, {
    caseId,
    outputDir: join(srcRoot, caseId, "baseline"),
    requirementSource,
  });
  const agent = await scoreSide(judge, gold, {
    caseId,
    outputDir: join(srcRoot, caseId, "agent"),
    requirementSource,
  });
  const delta = computeDelta(baseline, agent);
  cases.push({ case_id: caseId, baseline, agent, delta });

  const bNew = baseline.quality.final_score;
  const aNew = agent.quality.final_score;
  const win = (aNew ?? 0) > (bNew ?? 0) ? "AGENT" : (aNew ?? 0) < (bNew ?? 0) ? "baseline" : "tie";
  const f = (v: number | null | undefined) => (v == null ? " - " : String(v).padStart(4));
  console.log(
    `${caseId.padEnd(26)} ${f(orig[`${caseId}:b`])}→${f(bNew)}        ${f(orig[`${caseId}:a`])}→${f(aNew)}      ${win}`,
  );
}

const report = {
  run_id: OUT_RUN,
  timestamp: new Date().toISOString(),
  judge_model: config.llm.model,
  cases,
  aggregate: aggregateCompare(cases as never),
};
const paths = compareRunPaths(resultsBaseDir, OUT_RUN);
mkdirSync(paths.root, { recursive: true });
writeReport({ reportJson: paths.reportJson, reportMd: paths.reportMd }, report as never);

const agg = (report.aggregate as { agent_wins: number; baseline_wins: number; ties: number });
console.log("-".repeat(78));
console.log(`\nagent_wins=${agg.agent_wins} baseline_wins=${agg.baseline_wins} ties=${agg.ties}`);
console.log(`report → ${paths.reportMd}`);
