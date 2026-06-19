/**
 * ConstraintExtractor — Extract constraint candidates from requirement documents.
 *
 * Uses LLM to identify all atomic constraints (security, performance, data,
 * usability, availability, functional rules) from a requirement text, given
 * known entities and functions as context.
 *
 * Returns ConstraintCandidate[] for downstream canonicalization.
 */

import { BaseGenerator } from "./base.js";
import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";
import type { ConstraintCandidate } from "../shared/constraintCanonicalizer.js";

// ---------------------------------------------------------------------------
// Input type for generate()
// ---------------------------------------------------------------------------

interface ConstraintExtractorInput {
  requirementText: string;
  entityRegistry: Array<{ id: string; canonicalName: string; aliases?: string[] }>;
  functionRegistry: Array<{ id: string; name: string; aliases?: string[] }>;
}

// ---------------------------------------------------------------------------
// ConstraintExtractor
// ---------------------------------------------------------------------------

export class ConstraintExtractor extends BaseGenerator<ConstraintCandidate[]> {
  private promptTemplate: string;

  constructor(llm: LLMClient) {
    super(llm);
    this.promptTemplate = loadPrompt("constraint_extraction.md", "");
  }

  async generate(input: unknown): Promise<ConstraintCandidate[]> {
    const { requirementText, entityRegistry, functionRegistry } =
      input as ConstraintExtractorInput;
    return this.extractCandidates(requirementText, entityRegistry, functionRegistry);
  }

  async extractCandidates(
    requirementText: string,
    entityRegistry: Array<{ id: string; canonicalName: string; aliases?: string[] }>,
    functionRegistry: Array<{ id: string; name: string; aliases?: string[] }>,
  ): Promise<ConstraintCandidate[]> {
    if (!this.promptTemplate) {
      console.warn(
        `[ConstraintExtractor] prompt template "constraint_extraction.md" is empty — skipping extraction.`,
      );
      return [];
    }

    const entitySummary = entityRegistry
      .map((e) => `- ${e.canonicalName} (ID: ${e.id}, aliases: ${(e.aliases ?? []).join(", ") || "none"})`)
      .join("\n");

    const functionSummary = functionRegistry
      .map((f) => `- ${f.name} (ID: ${f.id}${f.aliases?.length ? `, aliases: ${f.aliases.join(", ")}` : ""})`)
      .join("\n");

    requirementText = this.sanitizePlaceholder(requirementText, "requirement_text");
    requirementText = this.sanitizePlaceholder(requirementText, "entity_registry");
    requirementText = this.sanitizePlaceholder(requirementText, "function_registry");

    const prompt = this.buildPrompt(this.promptTemplate, {
      entity_registry: entitySummary || "（无已知实体）",
      function_registry: functionSummary || "（无已知功能）",
      requirement_text: requirementText,
    });

    const raw = await this.llm.generateJson(prompt, "", undefined, 0);
    const result = BaseGenerator.unwrapContent(raw);

    const constraints = Array.isArray(result?.constraints) ? result.constraints : [];
    return postProcess(constraints);
  }
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

/**
 * Clean up raw LLM output:
 * - Filter out items with no description AND no sourceText
 * - Map descriptionZh → description field (ConstraintCandidate uses .description)
 * - Fill missing fields with defaults
 */
function postProcess(items: unknown[]): ConstraintCandidate[] {
  const VALID_TYPES = new Set([
    "security", "performance", "usability", "data", "availability", "functional",
  ]);

  const normalized = items
    .filter((item): item is Record<string, unknown> => {
      if (typeof item !== "object" || item === null) return false;
      const rec = item as Record<string, unknown>;
      const desc = String(rec["descriptionZh"] ?? rec["description"] ?? "").trim();
      const src = String(rec["sourceText"] ?? "").trim();
      return desc.length > 0 || src.length > 0;
    })
    .map((item) => {
      const description = String(item["descriptionZh"] ?? item["description"] ?? "").trim();
      const sourceText = String(item["sourceText"] ?? "").trim();
      const canonicalRuleEn = String(item["canonicalRuleEn"] ?? "").trim() || description;
      const rawType = String(item["type"] ?? "").trim();
      const type = VALID_TYPES.has(rawType) ? rawType : "functional";
      const subtype = String(item["subtype"] ?? "").trim() || "general";
      const sectionId = String(item["sectionId"] ?? "").trim() || undefined;
      const relatedRaw = item["relatedFunctionCandidates"];
      const relatedFunctionCandidates = Array.isArray(relatedRaw)
        ? relatedRaw.filter((r): r is string => typeof r === "string")
        : [];

      return {
        description,
        sourceText: sourceText || undefined,
        canonicalRuleEn,
        type,
        subtype,
        sectionId,
        relatedFunctionCandidates,
      } satisfies ConstraintCandidate;
    });

  // De-duplicate by sourceText subset/overlap. When the LLM emits both an
  // entire compound sentence AND its atomic sub-clauses (which the prompt
  // tries to forbid but cannot guarantee), drop the LONGER container in favor
  // of the shorter atomic pieces — the atomic ones are what tests/design need
  // to ground against. This is a deterministic, dataset-agnostic backstop.
  return dropContainerConstraints(normalized);
}

/**
 * Drop "container" constraints whose sourceText fully contains (or is fully
 * contained by) another constraint's sourceText. We keep the SHORTER one in
 * each pair: shorter = more atomic = the rule that downstream stages can
 * actually anchor against. When two candidates share an identical sourceText,
 * keep the first occurrence.
 *
 * Containment is detected with a normalized substring check (lowercase ASCII,
 * whitespace and ASCII hyphen folded) so "Database files use the .kdb
 * extension." matches inside "Database files use the .kdb extension.
 * Databases must have unique names to avoid overwriting." even when quoting
 * differs slightly.
 *
 * Exported for unit tests.
 */
export function dropContainerConstraints(
  items: ConstraintCandidate[],
): ConstraintCandidate[] {
  const norm = (s: string): string =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[-\s]+/g, " ")
      .replace(/[^a-z0-9 一-鿿]/g, "")
      .trim();

  const withNorm = items.map((c) => ({
    item: c,
    src: c.sourceText ?? c.description ?? "",
    normSrc: norm(c.sourceText ?? c.description ?? ""),
  }));

  const dropped = new Set<number>();
  for (let i = 0; i < withNorm.length; i++) {
    if (dropped.has(i)) continue;
    const a = withNorm[i];
    if (a.normSrc.length < 6) continue;
    for (let j = 0; j < withNorm.length; j++) {
      if (i === j || dropped.has(j)) continue;
      const b = withNorm[j];
      if (b.normSrc.length < 6) continue;
      // Identical → keep i, drop j
      if (a.normSrc === b.normSrc) {
        dropped.add(j);
        continue;
      }
      // a contains b → a is the container, drop a (keep the shorter atom b)
      if (a.normSrc.includes(b.normSrc) && a.normSrc.length > b.normSrc.length + 5) {
        dropped.add(i);
        break;
      }
    }
  }
  return withNorm.filter((_, i) => !dropped.has(i)).map((w) => w.item);
}
