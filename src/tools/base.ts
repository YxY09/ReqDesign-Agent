/**
 * BaseTool — 编排 + 后处理层 (Layer 2)
 *
 * 职责：组合多个 Generator 的输出 + 执行后处理逻辑（验证、评分、修复）
 * 持有 LLMClient 引用用于策略决策（如 orchestrator 的 LLM routing）
 * 可感知全局状态（通过参数传入）
 *
 * 实现类：GenerationTool, EvaluationTool, PlanningTool, RepairTool, AgentOrchestrator
 */

import type { LLMClient } from "../llmClient.js";
import type { ToolCapabilities } from "./types.js";
import { buildSystemPrompt } from "../promptBuilder.js";
import { loadPrompt } from "../promptLoader.js";
import { setupLogger, type Logger } from "../logger.js";

export abstract class BaseTool {
  llm: LLMClient;

  /** Session-level prompt cache: avoids re-reading files every call. */
  protected _promptCache: Map<string, string> = new Map();
  private _systemPromptCache: Map<string, string> = new Map();

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  /** Lazy logger — initialised on first use to avoid constructor ordering issues. */
  private _loggerInstance: Logger | null = null;
  protected get logger(): Logger {
    if (!this._loggerInstance) {
      this._loggerInstance = setupLogger(`reqdesign.${this.name}`);
    }
    return this._loggerInstance;
  }

  /** Agent name (for logging/display). */
  abstract get name(): string;

  /** Tool capabilities declaration. */
  abstract get capabilities(): ToolCapabilities;

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

  /** Unified system prompt loading with caching. */
  protected async _getSystemPrompt(
    filename: string,
    fallback: string,
    queryContext = "",
  ): Promise<string> {
    const cacheKey = `${filename}:${queryContext.slice(0, 50)}`;
    const cached = this._systemPromptCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const prompt = await this._loadPromptWithConstitution(filename, fallback, queryContext);
    this._systemPromptCache.set(cacheKey, prompt);
    return prompt;
  }

  /** Invalidate prompt cache (called after memory updates). */
  invalidatePromptCache(): void {
    this._promptCache.clear();
    this._systemPromptCache.clear();
  }
}
