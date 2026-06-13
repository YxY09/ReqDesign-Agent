/**
 * promise_to_cases.mjs — ingest the public PROMISE NFR dataset into
 * ReqDesign-Agent benchmark cases + gold labels.
 *
 * PROMISE NFR (Cleland-Huang et al. 2007; expanded by Lima et al. 2019) is a
 * public dataset of software-requirement sentences, each labelled functional
 * ("F") or one of 11 non-functional subtypes. Rows look like:
 *
 *     PROJECT,REQUIREMENT,LABEL
 *     1,"The system shall refresh the display every 60 seconds",PE
 *
 * Fetchable (JSON) via the Hugging Face datasets-server, e.g.:
 *   https://datasets-server.huggingface.co/rows?dataset=MariaIsabel/PROMISE_NFR_translated&config=default&split=train&offset=0&length=100
 * (that mirror is Spanish, CC-BY-4.0; the English original lives on the
 * PROMISE/tera-PROMISE repository). Save the rows as a CSV and run:
 *
 *   node benchmark/adapters/promise_to_cases.mjs <promise.csv> [benchmarkDir]
 *
 * IMPORTANT — mapping caveat: PROMISE only carries requirement sentences plus
 * an F/NFR label. It has no actors / entities / exceptions / processes, so the
 * derived gold only populates expected_functions (F rows) and
 * expected_constraints (NFR rows); the other four gold fields stay empty and
 * those scorer dimensions are not exercised by PROMISE cases. PROMISE is also
 * English/Spanish, whereas scorer.ts's constraint matching is tuned for
 * Chinese — treat PROMISE results as a coarse functional/NFR coverage probe,
 * not a full-pipeline score.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** PROMISE non-functional subtype codes → human-readable names. */
export const NFR_LABELS = {
  A: "Availability",
  FT: "Fault Tolerance",
  L: "Legal",
  LF: "Look & Feel",
  MN: "Maintainability",
  O: "Operational",
  PE: "Performance",
  PO: "Portability",
  SC: "Scalability",
  SE: "Security",
  US: "Usability",
};

/** Split one CSV line, honouring double-quoted fields with "" escapes. */
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** Parse PROMISE CSV text into {project, requirement, label} rows. */
export function parsePromiseCsv(text) {
  const rows = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/^﻿/, "").trim();
    if (!line) continue;
    const fields = splitCsvLine(line);
    if (fields.length < 3) continue;
    const project = fields[0].trim();
    const label = fields[fields.length - 1].trim();
    const requirement = fields.slice(1, fields.length - 1).join(",").trim();
    if (project.toUpperCase() === "PROJECT") continue; // header
    if (!project || !requirement) continue;
    rows.push({ project, requirement, label });
  }
  return rows;
}

/**
 * Group PROMISE rows by project and emit { name, md, gold } per project.
 * Functional rows (label "F") → expected_functions; everything else → NFR.
 */
export function promiseRowsToCases(rows) {
  const byProject = new Map();
  for (const r of rows) {
    if (!r.requirement) continue;
    if (!byProject.has(r.project)) byProject.set(r.project, []);
    byProject.get(r.project).push(r);
  }

  const cases = [];
  for (const [project, reqs] of byProject) {
    const name = `promise_p${String(project).padStart(2, "0")}`;
    const functional = reqs.filter((r) => r.label.toUpperCase() === "F");
    const nfr = reqs.filter((r) => r.label.toUpperCase() !== "F");
    const gold = {
      case: name,
      source: `PROMISE NFR project ${project} (Cleland-Huang et al.)`,
      expected_actors: [],
      expected_functions: functional.map((r) => r.requirement),
      expected_entities: [],
      expected_constraints: nfr.map((r) => r.requirement),
      expected_exceptions: [],
      expected_processes: [],
    };
    cases.push({ name, md: buildCaseMd(project, functional, nfr), gold });
  }
  return cases;
}

function buildCaseMd(project, functional, nfr) {
  const lines = [`# PROMISE NFR — Project ${project}`, "", "## 功能需求 (Functional Requirements)", ""];
  functional.forEach((r, i) => {
    lines.push(`### F${String(i + 1).padStart(3, "0")}: ${r.requirement}`, "");
  });
  lines.push("## 非功能需求 (Non-Functional Requirements)", "");
  nfr.forEach((r, i) => {
    const kind = NFR_LABELS[r.label.toUpperCase()] ?? r.label;
    lines.push(`### N${String(i + 1).padStart(3, "0")} [${kind}]: ${r.requirement}`, "");
  });
  return lines.join("\n");
}

// CLI entry — only runs when executed directly, never on import.
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  process.argv[1].endsWith("promise_to_cases.mjs");

if (invokedDirectly) {
  const csvPath = process.argv[2];
  const outRoot = resolve(process.argv[3] ?? "benchmark");
  if (!csvPath) {
    console.error("usage: node promise_to_cases.mjs <promise.csv> [benchmarkDir]");
    process.exit(1);
  }
  const cases = promiseRowsToCases(parsePromiseCsv(readFileSync(csvPath, "utf8")));
  mkdirSync(join(outRoot, "cases"), { recursive: true });
  mkdirSync(join(outRoot, "gold_labels"), { recursive: true });
  for (const c of cases) {
    writeFileSync(join(outRoot, "cases", `${c.name}.md`), c.md, "utf8");
    writeFileSync(join(outRoot, "gold_labels", `${c.name}.json`), JSON.stringify(c.gold, null, 2), "utf8");
  }
  console.log(`Wrote ${cases.length} PROMISE case(s) under ${outRoot}/`);
}
