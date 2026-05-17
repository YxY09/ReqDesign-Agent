/**
 * CoordinatorAgent — single orchestration decision entry.
 * state + mailbox -> snapshot -> policy -> strategy brain -> guard -> compiler -> runtime action
 */

import type { LLMClient } from "../llmClient.js";
import { BaseAgent } from "./base.js";
import type { RuntimeAction } from "./types.js";
import type { WorkflowState } from "../state.js";
import type { TaskMailbox } from "../messaging.js";
import { ActionCompiler } from "../orchestration/compiler.js";
import { PolicyGuard } from "../orchestration/gates.js";
import { DeterministicPolicy } from "../orchestration/policy.js";
import { StateReader } from "../orchestration/snapshot.js";
import { StrategyBrain } from "../orchestration/strategyBrain.js";
import {
  createStrategyDecision,
  type StrategyDecision,
} from "../orchestration/strategy.js";

export class CoordinatorAgent extends BaseAgent {
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
    return "CoordinatorAgent";
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
      return await this.strategyBrain.decide(snapshot);
    } catch (exc) {
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
