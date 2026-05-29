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

export interface ConstraintExtractorInput {
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

    const raw = await this.llm.generateJson(prompt, "");
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

  return items
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
}
