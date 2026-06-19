/**
 * Traceability Matrix — computes coverage mappings from analysis.json
 * and design/test/review outputs.
 *
 * Builds bidirectional maps linking constraints ↔ functions,
 * and identifies what is covered (or not) by design and test artifacts.
 */

import type { SpanEvidence } from "./documentNormalizer.js";
import type { DesignModel } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TraceabilityMatrix {
  functionToConstraints: Record<string, string[]>;   // functionId → constraintId[]
  constraintToFunctions: Record<string, string[]>;    // constraintId → functionId[]
  constraintToDesign: Record<string, string[]>;       // constraintId → designDecision[]
  functionToDesign: Record<string, string[]>;         // functionId → designDecision[]
  exceptionToDesign: Record<string, string[]>;        // exceptionId → designDecision[]
  constraintToTests: Record<string, string[]>;        // constraintId → testCaseId[]
  constraintToEvidence: Record<string, string[]>;     // constraintId → sentenceId[]
  functionToTests: Record<string, string[]>;
  exceptionToTests: Record<string, string[]>;
  constraintDescriptions: Record<string, string>;
  functionDescriptions: Record<string, string>;
  exceptionDescriptions: Record<string, string>;
  uncoveredConstraints: string[];
  uncoveredFunctions: string[];
  uncoveredExceptions: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Coerce an unknown value to a trimmed string array. */
function asArrayOfStrings(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.map((v) => String(v ?? "").trim()).filter(Boolean);
}

/**
 * Parse markdown module tables out of a design document into a map of
 * function displayId (F001) → module names. Tolerates varying headers and
 * column orders: any table whose header row carries a module column
 * (模块 / module) AND a function column (功能 / function) is parsed.
 *
 * Returns an empty Map when no suitable table is present (never throws). Used
 * as a non-self-referential fallback for functionToDesign / constraintToDesign
 * when no structured {@link DesignModel}.coverageMatrix is available — e.g. the
 * baseline's single-turn markdown design, or an agent run whose design was
 * persisted as a markdown string rather than a DesignModel.
 */
export function parseDesignModuleTable(designText: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!designText) return result;

  const lines = designText.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    const separator = i + 1 < lines.length ? lines[i + 1] : "";
    if (!header.includes("|") || !isMarkdownTableSeparator(separator)) {
      i++;
      continue;
    }

    const headerCells = splitTableRow(header);
    // Fuzzy, language-agnostic column detection.
    let moduleNameIdx = -1;
    let fnIdx = -1;
    for (let c = 0; c < headerCells.length; c++) {
      const h = headerCells[c].toLowerCase();
      if (fnIdx === -1 && /功能|function|func/.test(h)) fnIdx = c;
      if (/模块|module/.test(h)) {
        // Prefer a 名称/name-bearing module column when both 模块ID and
        // 模块名称 exist (the name is the better design target).
        if (/名称|name/.test(h) || moduleNameIdx === -1) moduleNameIdx = c;
      }
    }

    if (moduleNameIdx >= 0 && fnIdx >= 0) {
      // Consume this table's data rows.
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && !isMarkdownTableSeparator(lines[j])) {
        const cells = splitTableRow(lines[j]);
        const moduleName = (cells[moduleNameIdx] ?? "").trim();
        const fnField = (cells[fnIdx] ?? "").trim();
        const fids = [...fnField.matchAll(/\bF\d{3}\b/g)].map((m) => m[0]);
        for (const fid of new Set(fids)) {
          if (!result.has(fid)) result.set(fid, []);
          if (moduleName && !(result.get(fid) as string[]).includes(moduleName)) {
            (result.get(fid) as string[]).push(moduleName);
          }
        }
        j++;
      }
      i = j;
    } else {
      // Not a module table — skip past its data rows.
      i += 2;
      while (i < lines.length && lines[i].includes("|") && !isMarkdownTableSeparator(lines[i])) i++;
    }
  }
  return result;
}

/** True when a markdown row is a table separator (`|---|:--:|`). */
function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  if (cells.length < 2) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

/** Split a markdown table row into trimmed cells (edge pipes stripped). */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/**
 * Resolve a raw function reference (displayId F001 or canonicalId
 * FUN_USER_REGISTER) to its displayId, when it belongs to the known function
 * display set. Returns "" if it cannot be resolved.
 */
function resolveDisplayFunctionId(
  rawFid: string,
  funcDisplay: Set<string>,
  canonicalToDisplay: Map<string, string>,
): string {
  const trimmed = rawFid.trim();
  if (!trimmed) return "";
  if (funcDisplay.has(trimmed)) return trimmed;
  const mapped = canonicalToDisplay.get(trimmed);
  if (mapped && funcDisplay.has(mapped)) return mapped;
  // A bare canonical FUN_ id with no displayId mapping cannot be keyed.
  return "";
}

interface RefIdLookup {
  funcDisplay: Set<string>;
  funcMap: Map<string, string>;
  conDisplay: Set<string>;
  conMap: Map<string, string>;
  excDisplay: Set<string>;
  excMap: Map<string, string>;
}

/**
 * Normalize a coverageMatrix entry refId (which may be a displayId or a
 * canonicalId) to its displayId, using the refKind to pick the right lookup.
 */
function normalizeRefId(rawRefId: string, refKind: string, lookup: RefIdLookup): string {
  const id = rawRefId.trim();
  if (!id) return "";
  let display: Set<string>;
  let map: Map<string, string>;
  if (refKind === "function") { display = lookup.funcDisplay; map = lookup.funcMap; }
  else if (refKind === "exception") { display = lookup.excDisplay; map = lookup.excMap; }
  else { display = lookup.conDisplay; map = lookup.conMap; }
  if (display.has(id)) return id;
  const mapped = map.get(id);
  if (mapped && display.has(mapped)) return mapped;
  // If the refId is itself a displayId shape but not in the set (orphan),
  // keep it only when it is a displayId-shaped token matching the kind.
  return "";
}

/** Identical to coverageValidator.ts's asArray — safely cast unknown to array. */
function asArray(val: unknown): Record<string, unknown>[] {
  if (!Array.isArray(val)) return [];
  return val as Record<string, unknown>[];
}

type SpanMapInput = Record<string, SpanEvidence> | Map<string, SpanEvidence>;

function spanEntries(spanMap?: SpanMapInput): Array<[string, SpanEvidence]> {
  if (!spanMap) return [];
  if (spanMap instanceof Map) return [...spanMap.entries()];
  return Object.entries(spanMap);
}

function normalizeEvidenceText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[.!?。！？，,、；;：:\s]+$/g, "")
    .trim();
}

function pushUnique(target: string[], values: string[]): void {
  for (const value of values) {
    if (value && !target.includes(value)) target.push(value);
  }
}

function resolveSentenceIds(
  evidence: Record<string, unknown>,
  spans: Array<[string, SpanEvidence]>,
): string[] {
  const explicit = String(evidence["sentenceId"] ?? "").trim();
  if (explicit) return [explicit];
  if (spans.length === 0) return [];

  const sourceText = normalizeEvidenceText(String(evidence["sourceText"] ?? "").trim());
  if (!sourceText) return [];
  const sectionId = String(evidence["sectionId"] ?? "").trim();

  const matches: string[] = [];
  for (const [sentenceId, span] of spans) {
    if (sectionId && span.sectionId !== sectionId) continue;
    const spanText = normalizeEvidenceText(span.sourceText);
    if (!spanText) continue;
    if (
      spanText === sourceText ||
      spanText.includes(sourceText) ||
      sourceText.includes(spanText)
    ) {
      matches.push(span.sentenceId || sentenceId);
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// ID extraction helpers. Display IDs are returned as-is; canonical IDs are
// resolved to their current display IDs before entering matrix keys.
// ---------------------------------------------------------------------------

const RE_DISPLAY_CONSTRAINT = /\bC\d{3,4}\b/g;
const RE_DISPLAY_FUNCTION = /\bF\d{3,4}\b/g;
const RE_DISPLAY_EXCEPTION = /\bX\d{3,4}\b/g;
const RE_CANONICAL_CONSTRAINT = /\bCON_[A-Za-z0-9_]+\b/g;
const RE_CANONICAL_FUNCTION = /\bFUN_[A-Za-z0-9_]+\b/g;
const RE_CANONICAL_EXCEPTION = /\bEXC_[A-Za-z0-9_]+\b/g;

function extractRequirementRefs(
  text: string,
  displayRe: RegExp,
  canonicalRe: RegExp,
  canonicalToDisplay: Map<string, string> = new Map(),
): string[] {
  const refs = new Set<string>();
  for (const id of text.match(displayRe) ?? []) refs.add(id);
  for (const id of text.match(canonicalRe) ?? []) {
    const displayId = canonicalToDisplay.get(id);
    if (displayId) refs.add(displayId);
  }
  return [...refs];
}

function extractConstraintRefs(text: string, canonicalToDisplay?: Map<string, string>): string[] {
  return extractRequirementRefs(text, RE_DISPLAY_CONSTRAINT, RE_CANONICAL_CONSTRAINT, canonicalToDisplay);
}

function extractFunctionRefs(text: string, canonicalToDisplay?: Map<string, string>): string[] {
  return extractRequirementRefs(text, RE_DISPLAY_FUNCTION, RE_CANONICAL_FUNCTION, canonicalToDisplay);
}

function extractExceptionRefs(text: string, canonicalToDisplay?: Map<string, string>): string[] {
  return extractRequirementRefs(text, RE_DISPLAY_EXCEPTION, RE_CANONICAL_EXCEPTION, canonicalToDisplay);
}

/**
 * Parse test-cases text into {id, target} pairs. Supports structured JSON
 * ({test_cases:[...]} or a bare array, optionally fenced in ```json) and
 * markdown sections ("## TC-...: title" + "**测试对象**: ...").
 *
 * Inlined here (rather than imported from generators/tests.ts) to keep this
 * shared module free of a shared→generators cross-layer dependency. Mirrors
 * the parsing patterns in reviewValidator._parseTestCaseEntries and
 * TestCaseGenerator.parseStructuredTestCases.
 */
function parseTestCaseTargets(text: string): Array<{ id: string; target: string }> {
  const entries: Array<{ id: string; target: string }> = [];

  // Strip a surrounding code fence if present.
  let body = text.trim();
  if (body.startsWith("```")) {
    const firstNl = body.indexOf("\n");
    const lastFence = body.lastIndexOf("```");
    if (firstNl >= 0 && lastFence > firstNl) {
      body = body.slice(firstNl + 1, lastFence).trim();
    }
  }

  // Structured JSON ({test_cases:[...]} or a bare array)
  if (body.startsWith("{") || body.startsWith("[")) {
    try {
      const parsed = JSON.parse(body) as unknown;
      const arr: unknown[] = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null &&
            Array.isArray((parsed as Record<string, unknown>).test_cases)
          ? (parsed as Record<string, unknown>).test_cases as unknown[]
          : [];
      for (const item of arr) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        const id = String(rec.id ?? "").trim();
        const target = String(rec.target ?? "").trim();
        if (id && target) entries.push({ id, target });
      }
      if (entries.length > 0) return entries;
    } catch {
      // fall through to markdown parsing
    }
  }

  // Markdown sections: "## TC-...: title" then "- **测试对象**: ..."
  const sections = text.split(/^##\s+/m);
  for (const section of sections) {
    if (!/^TC-/.test(section)) continue;
    const idMatch = section.match(/^(TC-[A-Z]-\d{3,})/);
    const targetMatch = section.match(/\*\*测试对象\*\*:\s*([^\n]*)/);
    const id = (idMatch?.[1] ?? "").trim();
    const target = (targetMatch?.[1] ?? "").trim();
    if (id && target) entries.push({ id, target });
  }
  return entries;
}

/**
 * Build ID lookup helpers for an entity collection. Returns the set of
 * displayIds plus a canonical→display map so that related_functions (which
 * carry canonicalIds like FUN_USER_REGISTER) can be resolved to displayIds.
 */
function buildIdSet(items: Record<string, unknown>[]): {
  display: Set<string>;
  canonicalToDisplay: Map<string, string>;
} {
  const display = new Set<string>();
  const canonicalToDisplay = new Map<string, string>();

  for (const item of items) {
    const cid = String(item.id ?? "").trim();
    const did = String(item.displayId ?? "").trim();
    if (did) display.add(did);
    if (cid && did) canonicalToDisplay.set(cid, did);
  }

  return { display, canonicalToDisplay };
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Build a TraceabilityMatrix from requirement analysis JSON and
 * optional design/test text.
 *
 * @param requirementJson - The analysis.json structure (functions, constraints, exceptions).
 * @param designText - System design document text (optional).
 * @param testCasesText - Test cases document text (optional).
 * @param spanMap - Optional span evidence map.
 * @param designModel - Optional structured DesignModel; when provided, its
 *   coverageMatrix drives constraintToDesign/functionToDesign/exceptionToDesign
 *   instead of the raw designText (which is self-referential and unreliable).
 * @returns A fully populated TraceabilityMatrix.
 */
export function buildMatrix(
  requirementJson: Record<string, unknown>,
  designText?: string,
  testCasesText?: string,
  spanMap?: SpanMapInput,
  designModel?: DesignModel,
): TraceabilityMatrix {
  const functions = asArray(requirementJson["functions"]);
  const constraints = asArray(requirementJson["constraints"]);
  const exceptions = asArray(requirementJson["exceptions"]);
  const spans = spanEntries(spanMap);

  const funcIds = buildIdSet(functions);
  const conIds = buildIdSet(constraints);
  const excIds = buildIdSet(exceptions);
  const constraintDescriptions: Record<string, string> = {};
  for (const c of constraints) {
    const did = String(c.displayId ?? "").trim();
    if (!did) continue;
    const desc = String(c.source_text ?? c.sourceText ?? c.description ?? "").trim();
    if (desc) constraintDescriptions[did] = desc;
  }
  // Function/exception descriptions enable the scorer to match gold obligations
  // to this matrix SEMANTICALLY (by text), not by positional id coincidence
  // (gold C-001 ≠ generated C001). Without these, functional/exception
  // obligations could only fall back to brittle id matching.
  const functionDescriptions: Record<string, string> = {};
  for (const f of functions) {
    const did = String(f.displayId ?? "").trim();
    if (!did) continue;
    const desc = [f.name, f.description]
      .map((p) => String(p ?? "").trim())
      .filter(Boolean)
      .join(" ");
    if (desc) functionDescriptions[did] = desc;
  }
  const exceptionDescriptions: Record<string, string> = {};
  for (const e of exceptions) {
    const did = String(e.displayId ?? "").trim();
    if (!did) continue;
    const desc = [e.description, e.trigger, e.handling]
      .map((p) => String(p ?? "").trim())
      .filter(Boolean)
      .join(" ");
    if (desc) exceptionDescriptions[did] = desc;
  }

  // design coverage is sourced from designModel.coverageMatrix when available;
  // otherwise fall back to a non-self-referential presence check against the
  // design text (constraint displayId mentioned → marked as designed).
  const testsStr = testCasesText ?? "";

  // --- functionToConstraints / constraintToFunctions (from related_functions) ---
  // Keys are displayIds only. related_functions carry canonicalIds, so resolve
  // them through the canonical→display map before keying.
  const functionToConstraints: Record<string, string[]> = {};
  const constraintToFunctions: Record<string, string[]> = {};

  for (const c of constraints) {
    const did = String(c.displayId ?? "").trim();
    if (!did) continue;
    const related = asArray(c["related_functions"] ?? c["relatedFunctions"] ?? []);

    const entry: string[] = [];
    for (const rel of related) {
      const relStr = String(rel);
      // It could be the functionId directly, or an object with functionId
      if (typeof rel === "object" && rel !== null) {
        const fnId = String((rel as Record<string, unknown>).functionId ?? "").trim();
        if (fnId) funcRefsPush(fnId);
      } else if (relStr) {
        funcRefsPush(relStr.trim());
      }
    }

    function funcRefsPush(rawFid: string): void {
      const fid = resolveDisplayFunctionId(rawFid, funcIds.display, funcIds.canonicalToDisplay);
      if (!fid) return;
      if (!entry.includes(fid)) entry.push(fid);
      if (!functionToConstraints[fid]) functionToConstraints[fid] = [];
      if (!functionToConstraints[fid].includes(did)) functionToConstraints[fid].push(did);
    }

    if (entry.length > 0) {
      constraintToFunctions[did] = entry;
    }
  }

  // --- constraintToEvidence (from evidence array) ---
  const constraintToEvidence: Record<string, string[]> = {};

  for (const c of constraints) {
    const did = String(c.displayId ?? "").trim();
    if (!did) continue;
    const evidence = asArray(c["evidence"] ?? []);

    const sentenceIds: string[] = [];
    for (const ev of evidence) {
      pushUnique(sentenceIds, resolveSentenceIds(ev, spans));
    }

    if (sentenceIds.length === 0 && c["sourceText"]) {
      pushUnique(sentenceIds, resolveSentenceIds({
        sourceText: c["sourceText"],
        sectionId: c["sectionId"],
      }, spans));
    }

    if (sentenceIds.length > 0) {
      constraintToEvidence[did] = sentenceIds;
    }
  }

  // --- constraintToDesign / functionToDesign / exceptionToDesign ---
  // Three-tier and ADDITIVE so the agent (coverageMatrix) and the baseline /
  // markdown-persisted design (text tiers) run on the SAME strict branch of
  // buildMatrix — keeping traceability comparable across sides:
  //   1. structured DesignModel.coverageMatrix (real module/class names)
  //   2. markdown module table fallback (function F-id → module names), which
  //      derives functionToDesign and, via constraintToFunctions /
  //      exception.related_functions, also constraintToDesign / exceptionToDesign
  //   3. constraint displayId presence in the design text (last resort)
  // Tiers 2/3 only run when designText is available and MERGE into whatever
  // tier 1 produced (they never overwrite a real coverageMatrix mapping).
  const constraintToDesign: Record<string, string[]> = {};
  const functionToDesign: Record<string, string[]> = {};
  const exceptionToDesign: Record<string, string[]> = {};

  // Tier 1: structured DesignModel.coverageMatrix (carries real module/class
  // names). refId may be a displayId or a canonicalId, so normalize via lookup
  // maps built from the requirement collections.
  if (designModel && Array.isArray(designModel.coverageMatrix)) {
    const lookup: RefIdLookup = {
      funcDisplay: funcIds.display,
      funcMap: funcIds.canonicalToDisplay,
      conDisplay: conIds.display,
      conMap: conIds.canonicalToDisplay,
      excDisplay: excIds.display,
      excMap: excIds.canonicalToDisplay,
    };
    for (const entry of designModel.coverageMatrix) {
      const rawRefId = String(entry.refId ?? "").trim();
      if (!rawRefId) continue;
      const refKind = String(entry.refKind ?? "").trim();
      const displayId = normalizeRefId(rawRefId, refKind, lookup);
      if (!displayId) continue;

      // A coverageMatrix entry existing for this refId means the design
      // addressed it. Collect real module/class names when present.
      const designTargets: string[] = [
        ...asArrayOfStrings(entry.affectedModuleIds),
        ...asArrayOfStrings(entry.affectedClassNames),
      ];
      if (designTargets.length === 0) designTargets.push("design");

      const bucket = refKind === "function" ? functionToDesign
        : refKind === "exception" ? exceptionToDesign
        : constraintToDesign;
      if (!bucket[displayId]) bucket[displayId] = [];
      pushUnique(bucket[displayId], designTargets);
    }
  }

  // Tiers 2 & 3: markdown design text fallback.
  if (designText) {
    // Tier 2 — parse module tables → function displayId → module names.
    const fnToModules = parseDesignModuleTable(designText);

    // functionToDesign directly from the module table.
    for (const [fid, modules] of fnToModules) {
      if (!functionToDesign[fid]) functionToDesign[fid] = [];
      pushUnique(functionToDesign[fid], modules);
    }

    // constraintToDesign via constraint → its functions → their modules.
    for (const [cid, fids] of Object.entries(constraintToFunctions)) {
      const modules: string[] = [];
      for (const fid of fids) pushUnique(modules, fnToModules.get(fid) ?? []);
      if (modules.length > 0) {
        if (!constraintToDesign[cid]) constraintToDesign[cid] = [];
        pushUnique(constraintToDesign[cid], modules);
      }
    }

    // exceptionToDesign via exception.related_functions → their modules.
    for (const x of exceptions) {
      const xid = String(x.displayId ?? "").trim();
      if (!xid) continue;
      const related = asArray(x["related_functions"] ?? x["relatedFunctions"]);
      const modules: string[] = [];
      for (const rel of related) {
        const rawFid = typeof rel === "object" && rel !== null
          ? String((rel as Record<string, unknown>).functionId ?? "").trim()
          : String(rel).trim();
        const fid = resolveDisplayFunctionId(rawFid, funcIds.display, funcIds.canonicalToDisplay);
        pushUnique(modules, fnToModules.get(fid) ?? []);
      }
      if (modules.length > 0) {
        if (!exceptionToDesign[xid]) exceptionToDesign[xid] = [];
        pushUnique(exceptionToDesign[xid], modules);
      }
    }

    // Tier 3 — constraint displayId presence (last resort, non-overwriting).
    // A constraint is "designed" when its displayId is mentioned in the design
    // text. Only fills entries tiers 1/2 did not already populate.
    const designConRefs = new Set(extractConstraintRefs(designText, conIds.canonicalToDisplay));
    for (const c of constraints) {
      const did = String(c.displayId ?? "").trim();
      if (did && designConRefs.has(did) && !constraintToDesign[did]) {
        constraintToDesign[did] = ["design"];
      }
    }
  }

  // --- constraintToTests / functionToTests / exceptionToTests ---
  // Each maps a constraint/function/exception displayId → the list of test
  // case IDs (TC-xxx) that target it. When the test-cases text is parseable
  // into {id, target} pairs (structured JSON or markdown), map properly so
  // the values are real TC-xxx ids. When it is plain text with no TC ids,
  // fall back to presence detection (key exists) so coverage booleans still
  // work — there is simply no TC id to record in that case.
  const constraintToTests: Record<string, string[]> = {};
  const functionToTests: Record<string, string[]> = {};
  const exceptionToTests: Record<string, string[]> = {};
  if (testsStr) {
    const parsedTests = parseTestCaseTargets(testsStr);
    if (parsedTests.length > 0) {
      for (const { id, target } of parsedTests) {
        for (const ref of extractConstraintRefs(target, conIds.canonicalToDisplay)) {
          if (!constraintToTests[ref]) constraintToTests[ref] = [];
          if (!constraintToTests[ref].includes(id)) constraintToTests[ref].push(id);
        }
        for (const ref of extractFunctionRefs(target, funcIds.canonicalToDisplay)) {
          if (!functionToTests[ref]) functionToTests[ref] = [];
          if (!functionToTests[ref].includes(id)) functionToTests[ref].push(id);
        }
        for (const ref of extractExceptionRefs(target, excIds.canonicalToDisplay)) {
          if (!exceptionToTests[ref]) exceptionToTests[ref] = [];
          if (!exceptionToTests[ref].includes(id)) exceptionToTests[ref].push(id);
        }
      }
    } else {
      // Plain-text fallback: no TC ids to map to — record presence only.
      for (const ref of extractConstraintRefs(testsStr, conIds.canonicalToDisplay)) constraintToTests[ref] = [ref];
      for (const ref of extractFunctionRefs(testsStr, funcIds.canonicalToDisplay)) functionToTests[ref] = [ref];
      for (const ref of extractExceptionRefs(testsStr, excIds.canonicalToDisplay)) exceptionToTests[ref] = [ref];
    }
  }

  // --- uncovered computation ---
  const uncoveredConstraints: string[] = [];
  for (const c of constraints) {
    const did = String(c.displayId ?? "").trim();
    if (!did) continue;
    const inDesign = Boolean(constraintToDesign[did]);
    const inTests = Boolean(constraintToTests[did]);
    if (!inDesign && !inTests) {
      uncoveredConstraints.push(did);
    }
  }

  const uncoveredFunctions: string[] = [];
  for (const f of functions) {
    const did = String(f.displayId ?? "").trim() || String(f.id ?? "").trim();
    if (!did) continue;
    const inTests = Boolean(functionToTests[did]);
    if (!inTests) {
      uncoveredFunctions.push(did);
    }
  }

  const uncoveredExceptions: string[] = [];
  for (const e of exceptions) {
    const did = String(e.displayId ?? "").trim() || String(e.id ?? "").trim();
    if (!did) continue;
    const inTests = Boolean(exceptionToTests[did]);
    if (!inTests) {
      uncoveredExceptions.push(did);
    }
  }

  return {
    functionToConstraints,
    constraintToFunctions,
    constraintToDesign,
    functionToDesign,
    exceptionToDesign,
    constraintToTests,
    constraintToEvidence,
    functionToTests,
    exceptionToTests,
    constraintDescriptions,
    functionDescriptions,
    exceptionDescriptions,
    uncoveredConstraints,
    uncoveredFunctions,
    uncoveredExceptions,
  };
}
