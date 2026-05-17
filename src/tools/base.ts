/**
 * BaseTool abstract class — session-level prompt caching for tools.
 */

import type { LLMClient } from "../llmClient.js";
import { buildSystemPrompt } from "../promptBuilder.js";
import { loadPrompt } from "../promptLoader.js";

export abstract class BaseTool {
  llm: LLMClient | null;

  /** Session-level prompt cache: avoids re-reading files every call. */
  protected _promptCache: Map<string, string> = new Map();

  constructor(llm: LLMClient | null) {
    this.llm = llm;
  }

  /** Agent name (for logging/display). */
  abstract get name(): string;

  /**
   * Load a prompt template from the unified prompts/ directory.
   */
  protected _loadPrompt(filename: string, fallback = ""): string {
    return loadPrompt(filename, fallback);
  }

  /**
   * Load prompt with constitution + memory injection.
   * Cached by (filename, query_context[:200]) key.
   */
  protected async _loadPromptWithConstitution(
    filename: string,
    fallback = "",
    queryContext = "",
  ): Promise<string> {
    const cacheKey = `${filename}|${queryContext.slice(0, 200)}`;
    const cached = this._promptCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const agentPrompt = this._loadPrompt(filename, fallback);
    if (!agentPrompt) {
      this._promptCache.set(cacheKey, fallback);
      return fallback;
    }

    // Infer agent_type from filename
    const typeMap: Record<string, string> = {
      planner: "planner",
      generator: "generator",
      evaluator: "evaluator",
      coordinator: "coordinator",
      repair: "repair",
    };
    let agentType: string | null = null;
    for (const [key, val] of Object.entries(typeMap)) {
      if (filename.toLowerCase().includes(key)) {
        agentType = val;
        break;
      }
    }

    const prompt = agentType
      ? await buildSystemPrompt(agentPrompt, agentType, queryContext)
      : agentPrompt;

    this._promptCache.set(cacheKey, prompt);
    return prompt;
  }

  /** Invalidate prompt cache (called after memory updates). */
  invalidatePromptCache(): void {
    this._promptCache.clear();
  }
}
