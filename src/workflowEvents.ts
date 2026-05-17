import process from "node:process";

export type WorkflowEventScope = "runtime" | "benchmark" | "llm";

export interface WorkflowEvent {
  scope: WorkflowEventScope;
  kind: string;
  timestamp: number;
  message: string;
  goal?: string;
  phase?: string;
  taskId?: string;
  taskType?: string;
  status?: string;
  sessionId?: string;
  caseName?: string;
  tag?: string;
  chunk?: string;
  data?: Record<string, unknown>;
}

export type WorkflowEventSink = (event: WorkflowEvent) => void;

export function createWorkflowEvent(
  overrides: Partial<WorkflowEvent> & Pick<WorkflowEvent, "kind" | "message">,
): WorkflowEvent {
  return {
    scope: "runtime",
    timestamp: Date.now() / 1000,
    ...overrides,
  };
}

export function formatWorkflowEvent(event: WorkflowEvent): string {
  const stamp = new Date(event.timestamp * 1000).toISOString().slice(11, 19);
  const parts = [`[${stamp}]`, event.scope];
  if (event.caseName) parts.push(`case=${event.caseName}`);
  parts.push(event.kind);
  if (event.taskId) parts.push(`task=${event.taskId}`);
  if (event.status) parts.push(`status=${event.status}`);
  return `${parts.join(" ")} | ${event.message}`;
}

export class ConsoleWorkflowStreamer {
  private activeTag = "";
  private inStream = false;

  push(event: WorkflowEvent): void {
    if (event.kind === "llm_chunk") {
      this.writeChunk(event);
      return;
    }
    // Suppress heartbeat noise on console
    if (event.kind === "worker_heartbeat") {
      return;
    }
    this.flushStreamLine();
    process.stdout.write(`${formatWorkflowEvent(event)}\n`);
  }

  close(): void {
    this.flushStreamLine();
  }

  private writeChunk(event: WorkflowEvent): void {
    const tag = event.tag || "llm";
    if (this.activeTag !== tag) {
      this.flushStreamLine();
      process.stdout.write(`[stream ${tag}] `);
      this.activeTag = tag;
      this.inStream = true;
    }
    process.stdout.write(event.chunk ?? event.message);
  }

  private flushStreamLine(): void {
    if (!this.inStream) return;
    process.stdout.write("\n");
    this.activeTag = "";
    this.inStream = false;
  }
}
