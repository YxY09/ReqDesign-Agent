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
 * 通过在 Agent 专属提示词之上叠加宪法和记忆来组装完整的 system prompt。
 *
 * @param agentPrompt  - Agent 专属提示词文本
 * @param agentType    - Agent 角色标识符（如 "planner"、"generator"）
 * @param queryContext - 用于记忆相关性检索的可选上下文
 * @returns 组装后的 system prompt
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
    // 记忆模块不可用 — 静默跳过
  }

  return prompt;
}
