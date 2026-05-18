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
  private readonly streamBuffers = new Map<string, string>();

  push(event: WorkflowEvent): void {
    if (event.kind === "llm_chunk") {
      this.writeChunk(event);
      return;
    }
    if (event.kind === "llm_completed") {
      this.flushTranscript(event);
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
    for (const [tag, content] of this.streamBuffers) {
      this.writeTranscript(tag, content);
    }
    this.streamBuffers.clear();
  }

  private writeChunk(event: WorkflowEvent): void {
    const tag = this.streamTag(event);
    if (this.activeTag !== tag) {
      this.flushStreamLine();
      process.stdout.write(`[stream ${tag}] `);
      this.activeTag = tag;
      this.inStream = true;
    }
    const text = event.chunk ?? event.message;
    process.stdout.write(text);
    this.streamBuffers.set(tag, `${this.streamBuffers.get(tag) ?? ""}${text}`);
  }

  private flushStreamLine(): void {
    if (!this.inStream) return;
    process.stdout.write("\n");
    this.activeTag = "";
    this.inStream = false;
  }

  private flushTranscript(event: WorkflowEvent): void {
    const tag = this.streamTag(event);
    const content = this.streamBuffers.get(tag);
    if (!content) return;
    this.writeTranscript(tag, content);
    this.streamBuffers.delete(tag);
  }

  private writeTranscript(_tag: string, content: string): void {
    const trimmed = content.trimEnd();
    if (!trimmed) return;
    // LLM output is now captured by TracingLLMClient in llm_trace.json.
    // No longer write raw LLM output to the main log file.
  }

  private streamTag(event: WorkflowEvent): string {
    const tag = event.tag || "llm";
    return event.taskId ? `${tag} task=${event.taskId}` : tag;
  }
}
