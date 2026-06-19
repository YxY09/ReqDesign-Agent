import { extractContentTerms, jaccardSimilarity } from "./testAlignment.js";

export type RequirementRefKind = "function" | "constraint" | "exception";
export type TestScenarioType = "正常" | "异常" | "边界";

export interface RequirementReference {
  kind: RequirementRefKind;
  displayId: string;
  canonicalId: string;
  label: string;
  sourceText: string;
  text: string;
}

export interface RequirementTargetRef {
  displayId: string;
  canonicalId: string;
}

const ID_RE = /\b(?:F\d{3,4}|C\d{3,4}|[EX]\d{3,4}|FUN_[A-Za-z0-9_]+|CON_[A-Za-z0-9_]+|EXC_[A-Za-z0-9_]+)\b/g;
const TARGET_PAIR_RE = /\b([FCX]\d{3,4})\s*\|\s*((?:FUN|CON|EXC)_[A-Za-z0-9_]+)/g;
const DISPLAY_ONLY_RE = /\b([FCX]\d{3,4})\b(?!\s*\|)/g;
// A bare canonicalId not already part of a “displayId | canonicalId” pair.
// The negative lookbehind avoids double-rewriting the canonicalId that sits
// after a “|” in an existing pair.
const BARE_CANONICAL_RE = /(?<!\|\s)\b(FUN_[A-Za-z0-9_]+|CON_[A-Za-z0-9_]+|EXC_[A-Za-z0-9_]+)\b/g;

const KEYWORDS = [
  "help",
  "context",
  "defect",
  "report",
  "audit",
  "search",
  "register",
  "access",
  "profile",
  "prosecute",
  "investigate",
  "soa",
  "modular",
  "scalable",
  "vpn",
  "https",
];

function refKindFromCollection(kind: RequirementRefKind, items: unknown): RequirementReference[] {
  if (!Array.isArray(items)) return [];
  const refs: RequirementReference[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    let displayId = String(rec.displayId ?? rec.constraintRef ?? rec.exceptionRef ?? "").trim();
    let canonicalId = String(rec.id ?? rec.constraintRef ?? rec.exceptionRef ?? "").trim();
    if (!displayId && /^[FCX]\d{3,4}$/.test(canonicalId)) {
      displayId = canonicalId;
    }
    if (!canonicalId && displayId) {
      canonicalId = displayId;
    }
    if (!displayId || !canonicalId) continue;
    const label = String(rec.description ?? rec.name ?? rec.trigger ?? rec.source_text ?? rec.sourceText ?? "").trim();
    const sourceText = String(rec.source_text ?? rec.sourceText ?? rec.description ?? rec.name ?? rec.trigger ?? "").trim();
    const aliases = Array.isArray(rec.aliases) ? rec.aliases.map(String).join(" ") : "";
    const text = [
      displayId,
      canonicalId,
      label,
      sourceText,
      rec.name,
      rec.description,
      rec.source_text,
      rec.sourceText,
      rec.trigger,
      aliases,
    ].map((value) => String(value ?? "")).join(" ").toLowerCase();
    refs.push({ kind, displayId, canonicalId, label, sourceText, text });
  }
  return refs;
}

export class RequirementIndex {
  readonly functions: RequirementReference[];
  readonly constraints: RequirementReference[];
  readonly exceptions: RequirementReference[];
  readonly refs: RequirementReference[];
  readonly displayToCanonical = new Map<string, string>();
  readonly canonicalToDisplay = new Map<string, string>();
  readonly allowedIds = new Set<string>();
  readonly idToRef = new Map<string, RequirementReference>();

  private constructor(refs: {
    functions: RequirementReference[];
    constraints: RequirementReference[];
    exceptions: RequirementReference[];
  }) {
    this.functions = refs.functions;
    this.constraints = refs.constraints;
    this.exceptions = refs.exceptions;
    this.refs = [...this.functions, ...this.constraints, ...this.exceptions];
    for (const ref of this.refs) {
      this.displayToCanonical.set(ref.displayId, ref.canonicalId);
      this.canonicalToDisplay.set(ref.canonicalId, ref.displayId);
      this.allowedIds.add(ref.displayId);
      this.allowedIds.add(ref.canonicalId);
      this.idToRef.set(ref.displayId, ref);
      this.idToRef.set(ref.canonicalId, ref);
    }
  }

  static fromRequirementJson(requirementJson: Record<string, unknown> | null | undefined): RequirementIndex {
    const req = requirementJson ?? {};
    return new RequirementIndex({
      functions: refKindFromCollection("function", req.functions),
      constraints: refKindFromCollection("constraint", req.constraints),
      exceptions: refKindFromCollection("exception", req.exceptions),
    });
  }

  idsFor(kind: RequirementRefKind, idForm: "display" | "canonical" | "both" = "display"): string[] {
    const refs = this.refsFor(kind);
    if (idForm === "display") return refs.map((ref) => ref.displayId).filter(Boolean);
    if (idForm === "canonical") return refs.map((ref) => ref.canonicalId).filter(Boolean);
    return refs.flatMap((ref) => [ref.displayId, ref.canonicalId]).filter(Boolean);
  }

  idMapFor(kind: RequirementRefKind): Map<string, string> {
    const map = new Map<string, string>();
    for (const ref of this.refsFor(kind)) {
      if (ref.displayId && ref.canonicalId && ref.displayId !== ref.canonicalId) {
        map.set(ref.displayId, ref.canonicalId);
      }
    }
    return map;
  }

  refsFor(kind: RequirementRefKind): RequirementReference[] {
    if (kind === "function") return this.functions;
    if (kind === "constraint") return this.constraints;
    return this.exceptions;
  }

  refForId(id: string): RequirementReference | undefined {
    return this.idToRef.get(id.trim());
  }

  extractIds(text: string): string[] {
    return text.match(ID_RE) ?? [];
  }

  extractTargetRefs(target: string): RequirementTargetRef[] {
    const refs: RequirementTargetRef[] = [];
    let match: RegExpExecArray | null;
    while ((match = TARGET_PAIR_RE.exec(target)) !== null) {
      refs.push({ displayId: match[1], canonicalId: match[2] });
    }
    return refs;
  }

  removeUnknownRefs(text: string): string {
    return text.replace(ID_RE, (id) => this.allowedIds.has(id) ? id : "");
  }

  normalizeTargetReferences(target: string, testCase: Record<string, unknown>): string {
    const originalTarget = target.trim();
    // Pre-rewrite: a bare canonicalId (CON_/FUN_/EXC_) with no displayId is
    // often produced by repair prompts. Prefer the target's natural-language
    // description when it points to a different current requirement; this
    // prevents stale canonical IDs from being mechanically paired with the
    // wrong displayId.
    const preRewritten = originalTarget.replace(
      BARE_CANONICAL_RE,
      (canonicalRaw) => {
        const canonicalId = canonicalRaw.trim();
        const ref = this.refForId(canonicalId);
        if (!ref) return canonicalId;
        const semantic = this.bestSemanticRefForTarget(originalTarget, ref.kind, testCase);
        return RequirementIndex.formatRef(semantic ?? ref) || canonicalId;
      },
    );
    const pairNormalized = preRewritten.replace(
      TARGET_PAIR_RE,
      (_match, displayRaw: string, canonicalRaw: string) => {
        const displayId = displayRaw.trim();
        const canonicalId = canonicalRaw.trim();
        const displayRef = this.refForId(displayId);
        const canonicalRef = this.refForId(canonicalId);
        const pairConsistent = Boolean(
          displayRef &&
          canonicalRef &&
          displayRef.displayId === canonicalRef.displayId &&
          displayRef.canonicalId === canonicalRef.canonicalId,
        );

        if (displayRef) return RequirementIndex.formatRef(displayRef);

        const semantic = canonicalRef
          ? this.bestSemanticRefForTarget(originalTarget, canonicalRef.kind, testCase)
          : undefined;
        if (!pairConsistent && semantic) return RequirementIndex.formatRef(semantic);
        if (canonicalRef) return RequirementIndex.formatRef(canonicalRef);
        if (semantic) return RequirementIndex.formatRef(semantic);
        return "";
      },
    );
    const idsInOriginalTarget = originalTarget.match(ID_RE) ?? [];
    const normalized = idsInOriginalTarget.length === 1
      ? pairNormalized.replace(DISPLAY_ONLY_RE, (displayRaw: string) => {
          const displayRef = this.refForId(displayRaw.trim());
          if (!displayRef) return displayRaw;
          return displayRaw;
        })
      : pairNormalized;

    const cleaned = RequirementIndex.cleanupTargetText(this.removeUnknownRefs(normalized));
    if (cleaned) return cleaned;

    const type = String(testCase.type ?? "").trim() as TestScenarioType;
    const haystack = [
      originalTarget,
      testCase.title,
      testCase.expected_result,
      Array.isArray(testCase.steps) ? testCase.steps.join(" ") : "",
    ].map((value) => String(value ?? "")).join(" ");
    return this.bestFallbackRef(haystack, type) || originalTarget;
  }

  private bestSemanticRefForTarget(
    target: string,
    kind: RequirementRefKind,
    testCase?: Record<string, unknown>,
  ): RequirementReference | undefined {
    const naturalText = [
      RequirementIndex.stripRequirementIds(target),
      testCase?.title,
      testCase?.preconditions,
      Array.isArray(testCase?.steps) ? testCase.steps.join(" ") : "",
      testCase?.expected_result,
    ].map((value) => String(value ?? "").trim()).filter(Boolean).join(" ");
    const targetTerms = extractContentTerms(naturalText);
    if (targetTerms.size === 0) return undefined;

    let best: RequirementReference | undefined;
    let bestScore = 0;
    for (const ref of this.refsFor(kind)) {
      const refTerms = extractContentTerms([ref.label, ref.sourceText].join(" "));
      const score = jaccardSimilarity(targetTerms, refTerms);
      if (score > bestScore) {
        best = ref;
        bestScore = score;
      }
    }
    return bestScore > 0 ? best : undefined;
  }

  bestFallbackRef(text: string, type: TestScenarioType): string {
    const refs = type === "异常"
      ? this.exceptions
      : type === "边界"
        ? this.constraints
        : this.functions;
    const lower = text.toLowerCase();
    const best = refs.find((ref) =>
      KEYWORDS.some((keyword) => lower.includes(keyword) && ref.text.includes(keyword)),
    );
    return RequirementIndex.formatRef(best) || this.fallbackRef(type);
  }

  fallbackRef(type: TestScenarioType): string {
    if (type === "异常") return RequirementIndex.formatRef(this.exceptions[0]);
    if (type === "边界") return RequirementIndex.formatRef(this.constraints[0]);
    return RequirementIndex.formatRef(this.functions[0]);
  }

  pairWarnings(targetRefs: RequirementTargetRef[], label: string): string[] {
    const warnings = new Set<string>();
    for (const ref of targetRefs) {
      const expectedCanonical = this.displayToCanonical.get(ref.displayId);
      const expectedDisplay = this.canonicalToDisplay.get(ref.canonicalId);
      const expectedPrefix = RequirementIndex.expectedCanonicalPrefix(ref.displayId);
      if (expectedPrefix && !ref.canonicalId.startsWith(expectedPrefix)) {
        warnings.add(`${label} target ID 类型不一致: ${ref.displayId} 不应配对 ${ref.canonicalId}`);
      }
      if (expectedCanonical && expectedCanonical !== ref.canonicalId) {
        warnings.add(`${label} target ID 配对不一致: ${ref.displayId} 应对应 ${expectedCanonical}, 实际为 ${ref.canonicalId}`);
      }
      if (expectedDisplay && expectedDisplay !== ref.displayId) {
        warnings.add(`${label} target ID 配对不一致: ${ref.canonicalId} 应对应 ${expectedDisplay}, 实际为 ${ref.displayId}`);
      }
    }
    return [...warnings];
  }

  unknownReferences(ids: Iterable<string>): string[] {
    return [...ids].filter((id) => !this.allowedIds.has(id)).sort();
  }

  kindLabelForId(id: string): string {
    if (id.startsWith("F") || id.startsWith("FUN_")) return "功能";
    if (id.startsWith("C") || id.startsWith("CON_")) return "约束";
    return "需求";
  }

  static formatRef(ref: { displayId: string; canonicalId: string } | undefined): string {
    return ref ? `${ref.displayId} | ${ref.canonicalId}` : "";
  }

  static expectedCanonicalPrefix(displayId: string): string {
    if (displayId.startsWith("F")) return "FUN_";
    if (displayId.startsWith("C")) return "CON_";
    if (displayId.startsWith("X")) return "EXC_";
    return "";
  }

  static cleanupTargetText(text: string): string {
    return text
      .replace(/\s*\|\s*(?=,|$)/g, "")
      .replace(/(^|,\s*)\|\s*/g, "$1")
      .replace(/\s*,\s*,+/g, ", ")
      .replace(/^\s*,\s*|\s*,\s*$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  static stripRequirementIds(text: string): string {
    return text
      .replace(ID_RE, " ")
      .replace(/[|,;:，；：（）()[\]{}]/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
}
