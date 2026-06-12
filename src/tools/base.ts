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

  /** Session 级提示词缓存：避免每次调用都重新读取文件。 */
  protected _promptCache: Map<string, string> = new Map();
  private _systemPromptCache: Map<string, string> = new Map();

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  /** 基于 (filename, query_context[:200]) 缓存提示词。 */
  private _loggerInstance: Logger | null = null;
  protected get logger(): Logger {
    if (!this._loggerInstance) {
      this._loggerInstance = setupLogger(`reqdesign.${this.name}`);
    }
    return this._loggerInstance;
  }

  /** Agent 名称（用于日志/显示）。 */
  abstract get name(): string;

  /** 工具能力声明。 */
  abstract get capabilities(): ToolCapabilities;

  /**
   * 从 unified prompts/ 目录加载提示词模板。
   */
  protected _loadPrompt(filename: string, fallback = ""): string {
    return loadPrompt(filename, fallback);
  }

  /**
   * 加载提示词，注入宪法 + 记忆。按 (filename, query_context[:200]) 缓存。
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

    /** 基于文件名推断 agent_type */
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

  /** 统一系统提示词加载，带缓存。 */
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

  /** 使提示词缓存失效（记忆更新后调用）。 */
  invalidatePromptCache(): void {
    this._promptCache.clear();
    this._systemPromptCache.clear();
  }
}
