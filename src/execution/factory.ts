import type { LLMClient } from "../llmClient.js";
import type { TaskNotification } from "../messaging.js";
import { TaskMailbox } from "../messaging.js";
import { EvaluationTool } from "../tools/evaluation.js";
import { GenerationTool } from "../tools/generation.js";
import { PlanningTool } from "../tools/planning.js";
import { RepairTool } from "../tools/repair.js";
import { EvaluationSession, GenerationSession, PlanningSession } from "../tools/sessions.js";
import { RepairSession } from "../tools/sessions.js";
import { SessionContext, SessionDescriptor, type WorkerSession } from "../session.js";
import { setupLogger, type Logger } from "../logger.js";

export class DependencyProvider {
  private readonly logger: Logger = setupLogger("reqdesign.DependencyProvider");
  llm: LLMClient | null;
  mailbox: TaskMailbox;
  plannerTool: PlanningTool | null;
  generatorTool: GenerationTool | null;
  evaluatorTool: EvaluationTool | null;
  repairTool: RepairTool | null;

  constructor(options?: {
    llm?: LLMClient | null;
    mailbox?: TaskMailbox;
    plannerTool?: PlanningTool | null;
    generatorTool?: GenerationTool | null;
    evaluatorTool?: EvaluationTool | null;
    repairTool?: RepairTool | null;
  }) {
    this.llm = options?.llm ?? null;
    this.mailbox = options?.mailbox ?? new TaskMailbox();
    this.plannerTool = options?.plannerTool ?? null;
    this.generatorTool = options?.generatorTool ?? null;
    this.evaluatorTool = options?.evaluatorTool ?? null;
    this.repairTool = options?.repairTool ?? null;
  }

  ensureTools(): void {
    if (this.llm === null) return;
    if (this.plannerTool === null) this.plannerTool = new PlanningTool(this.llm);
    if (this.generatorTool === null) this.generatorTool = new GenerationTool(this.llm);
    if (this.evaluatorTool === null) this.evaluatorTool = new EvaluationTool(this.llm);
    this.logger.info("ensureTools: tools initialized");
  }
}

export class WorkerFactory {
  constructor(private readonly deps: DependencyProvider) {}

  createPlannerSession(sessionId: string, context: SessionContext): PlanningSession {
    this.deps.ensureTools();
    if (!this.deps.plannerTool) {
      throw new Error("PlanningTool dependency is unavailable");
    }
    return new PlanningSession(
      sessionId,
      context,
      this.deps.mailbox as { sendNotification: (notif: TaskNotification) => void },
      this.deps.llm,
      this.deps.plannerTool,
    );
  }

  createGeneratorSession(sessionId: string, context: SessionContext): GenerationSession {
    this.deps.ensureTools();
    if (!this.deps.generatorTool) {
      throw new Error("GenerationTool dependency is unavailable");
    }
    return new GenerationSession(
      sessionId,
      context,
      this.deps.mailbox as { sendNotification: (notif: TaskNotification) => void },
      this.deps.llm,
      this.deps.generatorTool,
    );
  }

  createRepairSession(sessionId: string, context: SessionContext): RepairSession {
    if (!this.deps.repairTool) {
      throw new Error("RepairTool dependency is unavailable");
    }
    return new RepairSession(
      sessionId,
      context,
      this.deps.mailbox as { sendNotification: (notif: TaskNotification) => void },
      this.deps.llm,
      this.deps.repairTool,
    );
  }

  createEvaluatorSession(sessionId: string, context: SessionContext): EvaluationSession {
    this.deps.ensureTools();
    if (!this.deps.evaluatorTool) {
      throw new Error("EvaluationTool dependency is unavailable");
    }
    return new EvaluationSession(
      sessionId,
      context,
      this.deps.mailbox as { sendNotification: (notif: TaskNotification) => void },
      this.deps.llm,
      this.deps.evaluatorTool,
    );
  }

  createSession(workerType: string, sessionId: string, context: SessionContext): WorkerSession {
    if (workerType === "planner") return this.createPlannerSession(sessionId, context);
    if (workerType === "generator") return this.createGeneratorSession(sessionId, context);
    if (workerType === "evaluator") return this.createEvaluatorSession(sessionId, context);
    if (workerType === "repair") return this.createRepairSession(sessionId, context);
    throw new Error(`unknown worker_type: ${workerType}`);
  }

  restore(descriptor: SessionDescriptor): WorkerSession {
    const context = SessionContext.fromDict(descriptor.context);
    const session = this.createSession(descriptor.workerType, descriptor.sessionId, context);
    session.restoreFromDescriptor(descriptor);
    return session;
  }
}
