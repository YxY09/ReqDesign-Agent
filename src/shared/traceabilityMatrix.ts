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
// ID extraction helpers (displayId only — canonicalIds are normalized away)
// ---------------------------------------------------------------------------

const RE_DISPLAY_CONSTRAINT = /\bC\d{3}\b/g;
const RE_DISPLAY_FUNCTION = /\bF\d{3}\b/g;
const RE_DISPLAY_EXCEPTION = /\bX\d{3}\b/g;

function extractConstraintRefs(text: string): string[] {
  return [...new Set(text.match(RE_DISPLAY_CONSTRAINT) ?? [])];
}

function extractFunctionRefs(text: string): string[] {
  return [...new Set(text.match(RE_DISPLAY_FUNCTION) ?? [])];
}

function extractExceptionRefs(text: string): string[] {
  return [...new Set(text.match(RE_DISPLAY_EXCEPTION) ?? [])];
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
  // Prefer the structured DesignModel.coverageMatrix when available (it carries
  // real module/class names). Otherwise fall back to the design text. Keys are
  // displayIds only; refId may be a displayId or a canonicalId, so normalize via
  // lookup maps built from the requirement collections.
  const constraintToDesign: Record<string, string[]> = {};
  const functionToDesign: Record<string, string[]> = {};
  const exceptionToDesign: Record<string, string[]> = {};

  if (designModel && Array.isArray(designModel.coverageMatrix)) {
    const conLookup = buildIdSet(constraints);
    const excLookup = buildIdSet(exceptions);
    const lookup: RefIdLookup = {
      funcDisplay: funcIds.display,
      funcMap: funcIds.canonicalToDisplay,
      conDisplay: conLookup.display,
      conMap: conLookup.canonicalToDisplay,
      excDisplay: excLookup.display,
      excMap: excLookup.canonicalToDisplay,
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
  } else if (designText) {
    // Non-self-referential fallback: a constraint is "designed" when its
    // displayId is mentioned in the design text.
    const designRefs = new Set(extractConstraintRefs(designText));
    for (const c of constraints) {
      const did = String(c.displayId ?? "").trim();
      if (did && designRefs.has(did)) {
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
        for (const ref of extractConstraintRefs(target)) {
          if (!constraintToTests[ref]) constraintToTests[ref] = [];
          if (!constraintToTests[ref].includes(id)) constraintToTests[ref].push(id);
        }
        for (const ref of extractFunctionRefs(target)) {
          if (!functionToTests[ref]) functionToTests[ref] = [];
          if (!functionToTests[ref].includes(id)) functionToTests[ref].push(id);
        }
        for (const ref of extractExceptionRefs(target)) {
          if (!exceptionToTests[ref]) exceptionToTests[ref] = [];
          if (!exceptionToTests[ref].includes(id)) exceptionToTests[ref].push(id);
        }
      }
    } else {
      // Plain-text fallback: no TC ids to map to — record presence only.
      for (const ref of extractConstraintRefs(testsStr)) constraintToTests[ref] = [ref];
      for (const ref of extractFunctionRefs(testsStr)) functionToTests[ref] = [ref];
      for (const ref of extractExceptionRefs(testsStr)) exceptionToTests[ref] = [ref];
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
    uncoveredConstraints,
    uncoveredFunctions,
    uncoveredExceptions,
  };
}
