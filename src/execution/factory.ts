import type { LLMClient } from "../llmClient.js";
import type { TaskNotification } from "../messaging.js";
import { TaskMailbox } from "../messaging.js";
import { EvaluationTool } from "../tools/evaluation.js";
import { GenerationTool } from "../tools/generation.js";
import { PlanningTool } from "../tools/planning.js";
import { RepairTool } from "../tools/repair.js";
import { EvaluationSession, GenerationSession, PlanningSession, RepairSession } from "../tools/sessions.js";
import { SessionContext, SessionDescriptor, type WorkerSession } from "../session.js";

export class WorkerFactory {
  constructor(
    private readonly llm: LLMClient | null,
    private readonly mailbox: TaskMailbox,
    private readonly plannerTool: PlanningTool,
    private readonly generatorTool: GenerationTool,
    private readonly evaluatorTool: EvaluationTool,
    private readonly repairTool: RepairTool,
  ) {}

  createPlannerSession(sessionId: string, context: SessionContext): PlanningSession {
    return new PlanningSession(
      sessionId, context,
      this.mailbox as { sendNotification: (notif: TaskNotification) => void },
      this.llm, this.plannerTool,
    );
  }

  createGeneratorSession(sessionId: string, context: SessionContext): GenerationSession {
    return new GenerationSession(
      sessionId, context,
      this.mailbox as { sendNotification: (notif: TaskNotification) => void },
      this.llm, this.generatorTool,
    );
  }

  createRepairSession(sessionId: string, context: SessionContext): RepairSession {
    return new RepairSession(
      sessionId, context,
      this.mailbox as { sendNotification: (notif: TaskNotification) => void },
      this.llm, this.repairTool,
    );
  }

  createEvaluatorSession(sessionId: string, context: SessionContext): EvaluationSession {
    return new EvaluationSession(
      sessionId, context,
      this.mailbox as { sendNotification: (notif: TaskNotification) => void },
      this.llm, this.evaluatorTool,
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
