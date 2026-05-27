/**
 * RegistryExtractor — Extract entity registry from requirement documents.
 *
 * Uses LLM to identify all core entities and functions,
 * building a global terminology registry for cross-artifact consistency.
 */

import { BaseGenerator } from "./base.js";
import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";
import type { EntityRegistry } from "../shared/types.js";

export class RegistryExtractor extends BaseGenerator<EntityRegistry> {
  private promptTemplate: string;

  constructor(llm: LLMClient) {
    super(llm);
    this.promptTemplate = loadPrompt("registry_extraction.md", "");
  }

  async generate(...args: any[]): Promise<EntityRegistry> {
    const [requirementText, systemPrompt] = args as [string, string?];
    return this.extract(requirementText, systemPrompt);
  }

  async extract(requirementText: string, systemPrompt?: string): Promise<EntityRegistry> {
    if (!this.promptTemplate) {
      return { entities: [], functions: [] };
    }
    const prompt = this.buildPrompt(this.promptTemplate, {
      requirement_text: requirementText,
    });
    const raw = await this.llm.generateJson(prompt, systemPrompt ?? "");
    const result = BaseGenerator.unwrapContent(raw);

    // Validate basic structure
    const entities = Array.isArray(result?.entities) ? result.entities : [];
    const functions = Array.isArray(result?.functions) ? result.functions : [];

    return { entities, functions };
  }
}
