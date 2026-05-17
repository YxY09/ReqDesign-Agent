/**
 * 提示词组装器
 *
 * 将 Agent prompt、宪法约束、历史记忆三层组装为最终 system prompt。
 * 可独立于 Agent 基类使用。
 *
 * 组装顺序：
 *   1. Agent 专属 prompt（来自 prompts/{agent}.md）
 *   2. 宪法约束前置注入（来自 ReqDesign.md）
 *   3. 历史记忆末尾追加（来自 .reqdesign-memory/）
 */

import { getConstitution } from "./constitution.js";

/**
 * Assemble the full system prompt by layering constitution and memory
 * on top of the agent-specific prompt.
 *
 * @param agentPrompt  - Agent-specific prompt text
 * @param agentType    - Agent role identifier (e.g. "planner", "generator")
 * @param queryContext - Optional context for memory relevance retrieval
 * @returns The assembled system prompt
 */
export async function buildSystemPrompt(
  agentPrompt: string,
  agentType: string,
  queryContext = "",
): Promise<string> {
  if (!agentPrompt) {
    return agentPrompt;
  }

  // 1. 宪法前置注入
  const constitution = getConstitution();
  let prompt = constitution.injectSection(agentPrompt);

  // 2. 记忆末尾追加
  try {
    const { getMemory } = await import("./memory/store.js");
    const memory = getMemory();
    prompt = memory.appendToPrompt(agentType, prompt, queryContext);
  } catch {
    // Memory module not available — skip silently
  }

  return prompt;
}
