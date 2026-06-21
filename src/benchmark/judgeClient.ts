/**
 * Benchmark v2 — minimal LLM surface used by the coverage / evidence judges.
 *
 * `LLMClient` satisfies this interface, so scoring is fully unit-testable
 * offline with a mock and needs no network unless you actually run a case.
 *
 * This interface was extracted from the legacy `scorer.ts` so that the old
 * Phase-1 scorer can be removed while v2 keeps using the same contract.
 *
 * @module benchmark/judgeClient
 */

export interface JudgeClient {
  generateJson(prompt: string, system?: string): Promise<Record<string, unknown>>;
}
