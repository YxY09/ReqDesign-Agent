/**
 * Constraint Canonicalizer
 *
 * Transforms raw constraint candidates into canonical constraints with:
 * - Type/subtype inference (keyword-based, programmatic)
 * - Deduplication (sourceText → description → pass-through)
 * - ID assignment (constraintUid, canonicalId, displayId)
 * - Verification strategy generation
 * - Function linking (keyword matching)
 *
 * Two modes are designed:
 * - Program mode (current): deterministic, no LLM calls
 * - LLM mode (future): semantic normalization via LLM
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NormalizedRule {
  condition?: string;
  subject: string;
  modality: string;
  action: string;
  object?: string;
}

export interface ConstraintCandidate {
  description?: string;
  sourceText?: string;
  canonicalRuleEn?: string;
  type?: string;
  subtype?: string;
  sectionId?: string;
  relatedFunctionCandidates?: string[];
}

export interface CanonicalConstraint {
  constraintUid: string;
  displayId: string;
  canonicalId: string;
  type: string;
  subtype: string;
  descriptionZh: string;
  canonicalRuleEn: string;
  sourceText: string;
  normalizedRule: NormalizedRule;
  relatedFunctions: Array<{
    functionId: string;
    relation: string;
    confidence: number;
  }>;
  evidence: Array<{ sourceText: string; sectionId?: string }>;
  verification: {
    testability: string;
    recommendedType: string;
    acceptanceCriteria: string[];
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Simple deterministic hash, 8-char uppercase hex-ish string. */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36).toUpperCase().slice(0, 8).padEnd(8, "0");
}

/** Normalize text for dedup comparison: lowercase, strip punctuation, collapse whitespace. */
function normalizeForComparison(text: string): string {
  // \w only matches [A-Za-z0-9_], so CJK characters get stripped.
  // Instead, use Unicode property escapes: keep letters (\p{L}), digits, and spaces.
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract up to 4 meaningful English keywords, UPPER_SNAKE_CASE. */
function extractEnglishKeyWords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will",
    "would", "could", "should", "may", "might", "must", "shall",
    "can", "need", "to", "of", "in", "for", "on", "with", "at",
    "by", "from", "as", "into", "through", "during", "before",
    "after", "above", "below", "between", "out", "off", "over",
    "under", "again", "further", "then", "once", "not", "no",
    "nor", "only", "own", "same", "so", "than", "too", "very",
    "and", "but", "or", "if", "any", "all", "each", "every",
    "both", "few", "more", "most", "other", "some", "such",
    "that", "this", "these", "those", "it", "its", "their",
    "they", "them", "we", "us", "our", "you", "your", "he",
    "him", "his", "she", "her", "which", "what", "when",
    "where", "who", "whom", "how", "why",
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  return words.slice(0, 4).map((w) => w.toUpperCase());
}

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

const TYPE_INFERENCE_RULES: Array<{
  regex: RegExp;
  type: string;
  subtype: string;
}> = [
  // Usability/accessibility must come before security/access_control
  // because "accessibility" contains "access"
  {
    regex: /usability|iso 9241|accessibility|可用性|易用性|无障碍/i,
    type: "usability",
    subtype: "accessibility",
  },
  {
    regex: /audit|trail|immutable|不可修改|不可删|审计/i,
    type: "security",
    subtype: "audit",
  },
  {
    regex: /security|\baccess\b|auth|encrypt|permission|privilege|密码|加密|权限|认证/i,
    type: "security",
    subtype: "access_control",
  },
  {
    regex: /performance|response time|latency|throughput|性能|响应时间|延迟/i,
    type: "performance",
    subtype: "response_time",
  },
  {
    regex: /availability|uptime|sla|可用率|停机/i,
    type: "availability",
    subtype: "uptime",
  },
  {
    regex: /data integrity|data validation|data accuracy|数据完整性|数据准确|数据校验|数据一致性/i,
    type: "data",
    subtype: "integrity",
  },
];

const TYPE_PREFIX_MAP: Record<string, string> = {
  security: "SEC",
  performance: "PERF",
  usability: "USAB",
  data: "DATA",
  availability: "AVAIL",
  functional: "FUNC",
};

function inferType(text: string): { type: string; subtype: string } {
  for (const rule of TYPE_INFERENCE_RULES) {
    if (rule.regex.test(text)) {
      return { type: rule.type, subtype: rule.subtype };
    }
  }
  return { type: "functional", subtype: "general" };
}

// ---------------------------------------------------------------------------
// Verification strategy
// ---------------------------------------------------------------------------

const VERIFICATION_TYPE_MAP: Record<string, string> = {
  security: "security_integration_test",
  performance: "performance_test",
  usability: "manual_inspection",
  data: "data_validation_test",
  availability: "failover_test",
  functional: "functional_test",
};

// ---------------------------------------------------------------------------
// Internal dedup group (merged candidates)
// ---------------------------------------------------------------------------

interface MergedGroup {
  description: string;
  sourceTexts: Array<{ sourceText: string; sectionId?: string }>;
  descriptions: string[];
  // All fields from the "best" candidate (first one seen)
  canonicalRuleEn?: string;
  candidateType?: string;
  candidateSubtype?: string;
  relatedFunctionCandidates?: string[];
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export function canonicalizeConstraints(
  candidates: ConstraintCandidate[],
  existingFunctions: Array<{ id: string; displayId: string; name: string }>,
): CanonicalConstraint[] {
  if (candidates.length === 0) return [];

  // --- Step 1: Deduplication ---
  // Layer 1: normalizeForComparison(sourceText) exact match
  // Layer 2: normalizeForComparison(description) exact match
  const groups: MergedGroup[] = [];
  const sourceTextIndex = new Map<string, number>(); // normalized sourceText → group index
  const descIndex = new Map<string, number>();       // normalized description → group index

  for (const candidate of candidates) {
    const rawSource = (candidate.sourceText ?? "").trim();
    const rawDesc = (candidate.description ?? "").trim();

    const normSource = normalizeForComparison(rawSource);
    const normDesc = normalizeForComparison(rawDesc);

    let groupIdx: number | undefined;

    // Layer 1: sourceText match
    if (normSource) {
      groupIdx = sourceTextIndex.get(normSource);
    }

    // Layer 2: description match (only if no sourceText match)
    if (groupIdx === undefined && normDesc) {
      groupIdx = descIndex.get(normDesc);
    }

    if (groupIdx !== undefined) {
      // Merge into existing group
      const group = groups[groupIdx];
      // Collect LLM-generated description
      if (rawDesc && !group.descriptions.includes(rawDesc)) {
        group.descriptions.push(rawDesc);
      }
      // Add evidence (avoid duplicate sourceText)
      const evidenceText = rawSource || rawDesc;
      if (evidenceText && !group.sourceTexts.some((s) => s.sourceText === evidenceText)) {
        group.sourceTexts.push({ sourceText: evidenceText, sectionId: candidate.sectionId });
      } else if (evidenceText) {
        // Already exists — still add if sectionId differs
        const existing = group.sourceTexts.find((s) => s.sourceText === evidenceText);
        if (existing && candidate.sectionId && existing.sectionId !== candidate.sectionId) {
          group.sourceTexts.push({ sourceText: evidenceText, sectionId: candidate.sectionId });
        }
      }
    } else {
      // New group
      groupIdx = groups.length;
      const evidenceText = rawSource || rawDesc;
      const sourceTexts: Array<{ sourceText: string; sectionId?: string }> = [];
      if (evidenceText) {
        sourceTexts.push({ sourceText: evidenceText, sectionId: candidate.sectionId });
      }

      groups.push({
        description: rawDesc || rawSource,
        sourceTexts,
        descriptions: rawDesc ? [rawDesc] : [],
        canonicalRuleEn: candidate.canonicalRuleEn,
        candidateType: candidate.type,
        candidateSubtype: candidate.subtype,
        relatedFunctionCandidates: candidate.relatedFunctionCandidates,
      });

      if (normSource) sourceTextIndex.set(normSource, groupIdx);
      if (normDesc) descIndex.set(normDesc, groupIdx);
    }
  }

  // --- Step 2: For each group, build CanonicalConstraint ---
  const results: CanonicalConstraint[] = groups.map((group) => {
    const text = group.description;

    // Type inference: use candidate-provided if available, otherwise infer
    const inferred = inferType(text);
    const type = group.candidateType || inferred.type;
    const subtype = group.candidateSubtype || inferred.subtype;

    // canonicalRuleEn: use candidate-provided or generate from description
    const canonicalRuleEn = group.canonicalRuleEn || text;

    // constraintUid: "ct_" + hash(description + sourceText)
    const hashInput = text + (group.sourceTexts.map((s) => s.sourceText).join("") || "");
    const constraintUid = "ct_" + simpleHash(hashInput).slice(0, 8);

    // canonicalId: CON_TYPE_PREFIX_KEYWORDS_HASH4
    const typePrefix = TYPE_PREFIX_MAP[type] || "FUNC";
    const keywords = extractEnglishKeyWords(canonicalRuleEn);
    const hash4 = simpleHash(hashInput).slice(0, 4);
    let canonicalId: string;
    if (keywords.length > 0) {
      canonicalId = `CON_${typePrefix}_${keywords.join("_")}_${hash4}`;
    } else {
      canonicalId = `CON_${typePrefix}_${simpleHash(hashInput).slice(0, 8)}`;
    }

    // Verification strategy
    const recommendedType = VERIFICATION_TYPE_MAP[type] || "functional_test";

    // normalizedRule (programmatic — basic best-effort)
    const normalizedRule = buildNormalizedRule(canonicalRuleEn);

    // relatedFunctions: keyword matching
    const relatedFunctions = linkFunctions(group, existingFunctions);

    // evidence
    const evidence = group.sourceTexts.map((s) => ({
      sourceText: s.sourceText,
      sectionId: s.sectionId,
    }));

    return {
      constraintUid,
      displayId: "", // assigned later
      canonicalId,
      type,
      subtype,
      descriptionZh: group.descriptions[0] || group.sourceTexts[0]?.sourceText || text,
      canonicalRuleEn,
      sourceText: group.sourceTexts[0]?.sourceText || text,
      normalizedRule,
      relatedFunctions,
      evidence,
      verification: {
        testability: "testable",
        recommendedType,
        acceptanceCriteria: [],
      },
    };
  });

  // --- Step 3: Sort by canonicalId for deterministic displayId assignment ---
  results.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));

  // --- Step 4: Resolve canonicalId collisions ---
  const usedCanonicalIds = new Set<string>();
  for (const r of results) {
    let cid = r.canonicalId;
    if (usedCanonicalIds.has(cid)) {
      let suffix = 2;
      while (usedCanonicalIds.has(`${cid}_${suffix}`)) suffix++;
      cid = `${cid}_${suffix}`;
      r.canonicalId = cid;
    }
    usedCanonicalIds.add(cid);
  }

  // --- Step 5: Assign sequential displayIds ---
  let counter = 1;
  for (const r of results) {
    r.displayId = `C${String(counter++).padStart(3, "0")}`;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a basic NormalizedRule from English text.
 * Programmatic best-effort: extracts modality keywords, treats rest as subject/action.
 */
function buildNormalizedRule(text: string): NormalizedRule {
  const lower = text.toLowerCase();

  // Extract modality
  let modality = "must";
  if (/\bshall\b/i.test(text)) modality = "shall";
  else if (/\bshould\b/i.test(text)) modality = "should";
  else if (/\bmust not\b/i.test(text) || /\bcannot\b/i.test(text) || /\b不可\b/.test(text)) modality = "must_not";
  else if (/\bmay\b/i.test(text)) modality = "may";

  // Basic heuristic: split text around modality verb
  // For now, use full text as subject + action
  return {
    subject: lower,
    modality,
    action: lower,
  };
}

/**
 * Link constraints to functions by checking if sourceText/description contains function name.
 */
function linkFunctions(
  group: MergedGroup,
  existingFunctions: Array<{ id: string; displayId: string; name: string }>,
): CanonicalConstraint["relatedFunctions"] {
  if (existingFunctions.length === 0) return [];

  const searchTexts = [
    group.description,
    ...group.sourceTexts.map((s) => s.sourceText),
  ].filter(Boolean);

  const links: CanonicalConstraint["relatedFunctions"] = [];

  for (const fn of existingFunctions) {
    const nameLower = fn.name.toLowerCase();
    // Also derive English-searchable keywords from the PascalCase name
    // e.g. "SearchCase" → ["search", "case"]
    const nameParts = fn.name
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/\s+/);

    for (const text of searchTexts) {
      const textLower = text.toLowerCase();
      // Match full name or any significant part (>3 chars)
      const matches =
        textLower.includes(nameLower) ||
        nameParts.some(
          (part) => part.length > 3 && textLower.includes(part),
        );
      if (matches) {
        if (!links.some((l) => l.functionId === fn.id)) {
          links.push({
            functionId: fn.id,
            relation: "mentioned_in_source",
            confidence: 0.7,
          });
        }
        break;
      }
    }
  }

  return links;
}

