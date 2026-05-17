import type { LLMClient } from "../llmClient.js";
import type { TaskNotification } from "../messaging.js";
import { TaskMailbox } from "../messaging.js";
import { EvaluatorAgent } from "../agents/evaluator.js";
import { GeneratorAgent } from "../agents/generator.js";
import { PlannerAgent } from "../agents/planner.js";
import { EvaluatorSession, GeneratorSession, PlannerSession } from "../agents/sessions.js";
import { SessionContext, SessionDescriptor, type WorkerSession } from "../session.js";

export class DependencyProvider {
  llm: LLMClient | null;
  mailbox: TaskMailbox;
  plannerAgent: PlannerAgent | null;
  generatorAgent: GeneratorAgent | null;
  evaluatorAgent: EvaluatorAgent | null;

  constructor(options?: {
    llm?: LLMClient | null;
    mailbox?: TaskMailbox;
    plannerAgent?: PlannerAgent | null;
    generatorAgent?: GeneratorAgent | null;
    evaluatorAgent?: EvaluatorAgent | null;
  }) {
    this.llm = options?.llm ?? null;
    this.mailbox = options?.mailbox ?? new TaskMailbox();
    this.plannerAgent = options?.plannerAgent ?? null;
    this.generatorAgent = options?.generatorAgent ?? null;
    this.evaluatorAgent = options?.evaluatorAgent ?? null;
  }

  ensureAgents(): void {
    if (this.llm === null) return;
    if (this.plannerAgent === null) this.plannerAgent = new PlannerAgent(this.llm);
    if (this.generatorAgent === null) this.generatorAgent = new GeneratorAgent(this.llm);
    if (this.evaluatorAgent === null) this.evaluatorAgent = new EvaluatorAgent(this.llm);
  }
}

export class WorkerFactory {
  constructor(private readonly deps: DependencyProvider) {}

  createPlannerSession(sessionId: string, context: SessionContext): PlannerSession {
    this.deps.ensureAgents();
    if (!this.deps.plannerAgent) {
      throw new Error("PlannerAgent dependency is unavailable");
    }
    return new PlannerSession(
      sessionId,
      context,
      this.deps.mailbox as { sendNotification: (notif: TaskNotification) => void },
      this.deps.llm,
      this.deps.plannerAgent,
    );
  }

  createGeneratorSession(sessionId: string, context: SessionContext): GeneratorSession {
    this.deps.ensureAgents();
    if (!this.deps.generatorAgent) {
      throw new Error("GeneratorAgent dependency is unavailable");
    }
    return new GeneratorSession(
      sessionId,
      context,
      this.deps.mailbox as { sendNotification: (notif: TaskNotification) => void },
      this.deps.llm,
      this.deps.generatorAgent,
    );
  }

  createEvaluatorSession(sessionId: string, context: SessionContext): EvaluatorSession {
    this.deps.ensureAgents();
    if (!this.deps.evaluatorAgent) {
      throw new Error("EvaluatorAgent dependency is unavailable");
    }
    return new EvaluatorSession(
      sessionId,
      context,
      this.deps.mailbox as { sendNotification: (notif: TaskNotification) => void },
      this.deps.llm,
      this.deps.evaluatorAgent,
    );
  }

  createSession(workerType: string, sessionId: string, context: SessionContext): WorkerSession {
    if (workerType === "planner") return this.createPlannerSession(sessionId, context);
    if (workerType === "generator") return this.createGeneratorSession(sessionId, context);
    if (workerType === "evaluator") return this.createEvaluatorSession(sessionId, context);
    throw new Error(`unknown worker_type: ${workerType}`);
  }

  restore(descriptor: SessionDescriptor): WorkerSession {
    const context = SessionContext.fromDict(descriptor.context);
    const session = this.createSession(descriptor.workerType, descriptor.sessionId, context);
    session.restoreFromDescriptor(descriptor);
    return session;
  }
}
