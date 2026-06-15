import { getMemory } from "./store.js";

export type MemoryPromptAgent = "generator" | "evaluator" | "coordinator";

export async function appendMemorySafely(
  agent: MemoryPromptAgent,
  prompt: string,
  queryContext: string,
): Promise<string> {
  try {
    return await getMemory().appendToPrompt(agent, prompt, queryContext);
  } catch {
    return prompt;
  }
}
