/**
 * AgentOrchestrator — single orchestration decision entry.
 * state + mailbox -> snapshot -> policy -> strategy brain -> guard -> compiler -> runtime action
 */

import type { LLMClient } from "../llmClient.js";
import { BaseTool } from "../tools/base.js";
import type { RuntimeAction } from "./types.js";
import type { WorkflowState } from "../state.js";
import type { TaskMailbox } from "../messaging.js";
import { ActionCompiler } from "../orchestration/strategy.js";
import { PolicyGuard } from "../orchestration/policy.js";
import { DeterministicPolicy } from "../orchestration/policy.js";
import { StateReader } from "../orchestration/snapshot.js";
import { StrategyBrain } from "../orchestration/strategyBrain.js";
import {
  createStrategyDecision,
  type StrategyDecision,
} from "../orchestration/strategy.js";

export class AgentOrchestrator extends BaseTool {
  private readonly policyGuard: PolicyGuard;
  private readonly deterministicPolicy: DeterministicPolicy;
  private readonly actionCompiler: ActionCompiler;
  private readonly strategyBrain: StrategyBrain | null;

  constructor(llm: LLMClient | null) {
    super(llm);
    this.policyGuard = new PolicyGuard();
    this.deterministicPolicy = new DeterministicPolicy(this.policyGuard);
    this.actionCompiler = new ActionCompiler();
    this.strategyBrain = llm ? new StrategyBrain(llm) : null;
  }

  get name(): string {
    return "AgentOrchestrator";
  }

  async decide(
    state: WorkflowState,
    mailbox: TaskMailbox,
  ): Promise<RuntimeAction> {
    const latestNotif = mailbox.peekLatestNotification();
    state.decisionCount += 1;
    const curr = state.decisionCount;

    if (latestNotif?.status === "failed") {
      state.errors.push(
        latestNotif.error || latestNotif.summary || "worker failed",
      );
    }

    const snapshot = StateReader.fromState(state, mailbox);
    let strategy = this.deterministicPolicy.decide(snapshot);
    if (strategy === null) {
      strategy = await this.resolveNonDeterministicStrategy(snapshot);
    }

    const guarded = this.policyGuard.validate(strategy, snapshot);
    const action = this.actionCompiler.compile(guarded, snapshot);
    this.logger.info(`decide: strategy=${strategy.strategy}，action=${action.action}，reason=${strategy.reason?.slice(0, 80)}`);
    state.lastAction = action.action;
    state.lastDecisionCount = curr;

    return action;
  }

  private async resolveNonDeterministicStrategy(
    snapshot: ReturnType<typeof StateReader.fromState>,
  ): Promise<StrategyDecision> {
    if (!this.strategyBrain) {
      return createStrategyDecision({
        strategy: "pause_for_user",
        reason: "no deterministic strategy and no LLM strategy brain available",
      });
    }
    try {
      const result = await this.strategyBrain.decide(snapshot);
      this.logger.info(`decide: LLM strategy=${result.strategy}，confidence=${result.confidence}`);
      return result;
    } catch (exc) {
      this.logger.warn(`decide: LLM 策略决策失败: ${exc instanceof Error ? exc.message : String(exc)}`);
      return createStrategyDecision({
        strategy: "pause_for_user",
        reason:
          exc instanceof Error
            ? `strategy brain failed: ${exc.message}`
            : "strategy brain failed",
      });
    }
  }
}
