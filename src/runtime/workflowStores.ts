import type { WorkflowState, PersistStatus, QualityStatus } from "../state.js";
import type { Artifact, ExecutionPlan, PlanMutation, RuntimeAction, Verdict } from "../shared/types.js";

export class ExecutionStore {
  constructor(private readonly state: WorkflowState) {}

  initializeRun(goal: string, inputPath: string, outputDir: string, startTime: number): void {
    this.state.goal = goal;
    this.state.inputPath = inputPath;
    this.state.outputDir = outputDir;
    this.state.startTime = startTime;
  }

  finishTiming(endTime: number, runSummary: Record<string, unknown>): void {
    this.state.endTime = endTime;
    this.state.runSummary = runSummary;
  }

  recordDecision(decision: RuntimeAction): void {
    this.state.actionHistory.push({
      timestamp: Date.now() / 1000,
      decisionCount: this.state.decisionCount,
      action: decision.action,
      taskId: decision.taskId,
      reason: decision.reason,
    });
  }

  addError(error: string): void {
    if (error) this.state.errors.push(error);
  }

  setPersistStatus(status: PersistStatus): void {
    this.state.persistStatus = status;
  }

  setQualityStatus(status: QualityStatus): void {
    this.state.setQualityStatus(status);
  }
}

export class ArtifactStore {
  constructor(private readonly state: WorkflowState) {}

  add(artifact: Artifact): void {
    this.state.addArtifact(artifact);
  }

  get(taskId: string): Artifact | undefined {
    return this.state.artifactsState.artifacts[taskId];
  }

  currentRevision(taskId: string): number {
    return this.state.currentArtifactRevision(taskId);
  }
}

export class PlanStore {
  constructor(private readonly state: WorkflowState) {}

  set(plan: ExecutionPlan): void {
    this.state.setPlan(plan);
  }

  mutate(mutation: PlanMutation): string[] {
    return this.state.mutatePlan(mutation);
  }
}

export class ReviewStore {
  constructor(private readonly state: WorkflowState) {}

  add(verdict: Verdict): void {
    this.state.addVerdict(verdict);
  }
}

export class WorkflowStores {
  readonly execution: ExecutionStore;
  readonly artifacts: ArtifactStore;
  readonly plan: PlanStore;
  readonly review: ReviewStore;

  constructor(state: WorkflowState) {
    this.execution = new ExecutionStore(state);
    this.artifacts = new ArtifactStore(state);
    this.plan = new PlanStore(state);
    this.review = new ReviewStore(state);
  }
}
