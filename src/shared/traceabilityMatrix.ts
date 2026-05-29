/**
 * Traceability Matrix — computes coverage mappings from analysis.json
 * and design/test/review outputs.
 *
 * Builds bidirectional maps linking constraints ↔ functions,
 * and identifies what is covered (or not) by design and test artifacts.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TraceabilityMatrix {
  functionToConstraints: Record<string, string[]>;   // functionId → constraintId[]
  constraintToFunctions: Record<string, string[]>;    // constraintId → functionId[]
  constraintToDesign: Record<string, string[]>;       // constraintId → designDecision[]
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

/** Identical to coverageValidator.ts's asArray — safely cast unknown to array. */
function asArray(val: unknown): Record<string, unknown>[] {
  if (!Array.isArray(val)) return [];
  return val as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// ID extraction helpers
// ---------------------------------------------------------------------------

const RE_DISPLAY_CONSTRAINT = /\bC\d{3}\b/g;
const RE_CANONICAL_CONSTRAINT = /\bCON_[A-Za-z0-9_]+\b/g;
const RE_DISPLAY_FUNCTION = /\bF\d{3}\b/g;
const RE_CANONICAL_FUNCTION = /\bFUN_[A-Za-z0-9_]+\b/g;
const RE_DISPLAY_EXCEPTION = /\bX\d{3}\b/g;
const RE_CANONICAL_EXCEPTION = /\bEXC_[A-Za-z0-9_]+\b/g;

function extractConstraintRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.match(RE_DISPLAY_CONSTRAINT) ?? []) refs.add(m);
  for (const m of text.match(RE_CANONICAL_CONSTRAINT) ?? []) refs.add(m);
  return [...refs];
}

function extractFunctionRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.match(RE_DISPLAY_FUNCTION) ?? []) refs.add(m);
  for (const m of text.match(RE_CANONICAL_FUNCTION) ?? []) refs.add(m);
  return [...refs];
}

function extractExceptionRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.match(RE_DISPLAY_EXCEPTION) ?? []) refs.add(m);
  for (const m of text.match(RE_CANONICAL_EXCEPTION) ?? []) refs.add(m);
  return [...refs];
}

/** Build a set of all recognized IDs (canonical + display) for a given entity type. */
function buildIdSet(items: Record<string, unknown>[]): { canonical: Set<string>; display: Set<string>; all: Set<string> } {
  const canonical = new Set<string>();
  const display = new Set<string>();
  const all = new Set<string>();

  for (const item of items) {
    const cid = String(item.id ?? "");
    const did = String(item.displayId ?? "");
    if (cid) { canonical.add(cid); all.add(cid); }
    if (did) { display.add(did); all.add(did); }
  }

  return { canonical, display, all };
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
 * @returns A fully populated TraceabilityMatrix.
 */
export function buildMatrix(
  requirementJson: Record<string, unknown>,
  designText?: string,
  testCasesText?: string,
): TraceabilityMatrix {
  const functions = asArray(requirementJson["functions"]);
  const constraints = asArray(requirementJson["constraints"]);
  const exceptions = asArray(requirementJson["exceptions"]);

  const funcIds = buildIdSet(functions);

  const designStr = designText ?? "";
  const testsStr = testCasesText ?? "";

  // --- functionToConstraints / constraintToFunctions (from related_functions) ---
  const functionToConstraints: Record<string, string[]> = {};
  const constraintToFunctions: Record<string, string[]> = {};

  for (const c of constraints) {
    const cid = String(c.id ?? "");
    const did = String(c.displayId ?? "");
    const related = asArray(c["related_functions"] ?? c["relatedFunctions"] ?? []);

    const funcRefs: string[] = [];
    for (const rel of related) {
      const relStr = String(rel);
      // It could be the functionId directly, or an object with functionId
      if (typeof rel === "object" && rel !== null) {
        const fnId = String((rel as Record<string, unknown>).functionId ?? "");
        if (fnId) funcRefs.push(fnId);
      } else if (relStr) {
        funcRefs.push(relStr);
      }
    }

    const entry: string[] = [];
    for (const fid of funcRefs) {
      if (funcIds.all.has(fid)) {
        entry.push(fid);
        // Add to functionToConstraints
        if (!functionToConstraints[fid]) functionToConstraints[fid] = [];
        if (did && !functionToConstraints[fid].includes(did)) functionToConstraints[fid].push(did);
        if (cid && !functionToConstraints[fid].includes(cid)) functionToConstraints[fid].push(cid);
      }
    }

    if (entry.length > 0) {
      if (did) constraintToFunctions[did] = entry;
      if (cid) constraintToFunctions[cid] = entry;
    }
  }

  // --- constraintToEvidence (from evidence array) ---
  const constraintToEvidence: Record<string, string[]> = {};

  for (const c of constraints) {
    const cid = String(c.id ?? "");
    const did = String(c.displayId ?? "");
    const evidence = asArray(c["evidence"] ?? []);

    const sentenceIds: string[] = [];
    for (const ev of evidence) {
      const sid = String(ev["sentenceId"] ?? "");
      if (sid) sentenceIds.push(sid);
    }

    if (sentenceIds.length > 0) {
      if (did) constraintToEvidence[did] = sentenceIds;
      if (cid) constraintToEvidence[cid] = sentenceIds;
    }
  }

  // --- constraintToDesign ---
  const constraintToDesign: Record<string, string[]> = {};
  if (designStr) {
    const designRefs = extractConstraintRefs(designStr);
    for (const ref of designRefs) {
      if (!constraintToDesign[ref]) constraintToDesign[ref] = [];
      constraintToDesign[ref].push(ref); // reference ID itself as the design reference
    }
  }

  // --- constraintToTests ---
  const constraintToTests: Record<string, string[]> = {};
  if (testsStr) {
    const testConstraintRefs = extractConstraintRefs(testsStr);
    for (const ref of testConstraintRefs) {
      if (!constraintToTests[ref]) constraintToTests[ref] = [];
      constraintToTests[ref].push(ref);
    }
  }

  // --- functionToTests ---
  const functionToTests: Record<string, string[]> = {};
  if (testsStr) {
    const testFuncRefs = extractFunctionRefs(testsStr);
    for (const ref of testFuncRefs) {
      if (!functionToTests[ref]) functionToTests[ref] = [];
      functionToTests[ref].push(ref);
    }
  }

  // --- exceptionToTests ---
  const exceptionToTests: Record<string, string[]> = {};
  if (testsStr) {
    const testExRefs = extractExceptionRefs(testsStr);
    for (const ref of testExRefs) {
      if (!exceptionToTests[ref]) exceptionToTests[ref] = [];
      exceptionToTests[ref].push(ref);
    }
  }

  // --- uncovered computation ---
  const uncoveredConstraints: string[] = [];
  for (const c of constraints) {
    const did = String(c.displayId ?? "");
    const cid = String(c.id ?? "");
    const inDesign = (did && constraintToDesign[did]) || (cid && constraintToDesign[cid]);
    const inTests = (did && constraintToTests[did]) || (cid && constraintToTests[cid]);
    if (!inDesign && !inTests) {
      uncoveredConstraints.push(did || cid);
    }
  }

  const uncoveredFunctions: string[] = [];
  for (const f of functions) {
    const did = String(f.displayId ?? "");
    const fid = String(f.id ?? "");
    const inTests = (did && functionToTests[did]) || (fid && functionToTests[fid]);
    if (!inTests) {
      uncoveredFunctions.push(did || fid);
    }
  }

  const uncoveredExceptions: string[] = [];
  for (const e of exceptions) {
    const did = String(e.displayId ?? "");
    const eid = String(e.id ?? "");
    const inTests = (did && exceptionToTests[did]) || (eid && exceptionToTests[eid]);
    if (!inTests) {
      uncoveredExceptions.push(did || eid);
    }
  }

  return {
    functionToConstraints,
    constraintToFunctions,
    constraintToDesign,
    constraintToTests,
    constraintToEvidence,
    functionToTests,
    exceptionToTests,
    uncoveredConstraints,
    uncoveredFunctions,
    uncoveredExceptions,
  };
}
