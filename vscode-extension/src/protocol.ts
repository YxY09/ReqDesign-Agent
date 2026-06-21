/**
 * Message protocol shared between the extension host and the webview.
 * Pure types + constants only, so it can be bundled into both the Node-side
 * extension and the browser-side webview.
 */

export type MessageRole = "system" | "user" | "assistant" | "status" | "error";
export type MessageVariant = "plain" | "event" | "stream" | "card";

/** A single rendered chat item in the webview transcript. */
export interface WebviewMessage {
  id: string;
  role: MessageRole;
  title?: string;
  content: string;
  variant?: MessageVariant;
  subtitle?: string;
  /** Collapsible cards (agent activity, finished streams) start collapsed. */
  collapsed?: boolean;
  /** True while a stream card is still receiving chunks. */
  active?: boolean;
}

/** Lightweight snapshot of workflow progress for the sticky status header. */
export interface PanelSnapshot {
  mode: string;
  goal: string;
  runStatus: string;
  currentAgent: string;
  currentTaskId: string;
  currentModel: string;
  plannedTasks: number;
  completedTasks: number;
  runningTasks: number;
  failedTasks: number;
  totalTokens: number;
  outputDir: string;
  llmStatus: string;
}

export type HostToWebview =
  | { type: "init"; projectRoot: string | null; ready: boolean; model: string; problem?: string }
  | { type: "append"; message: WebviewMessage }
  | { type: "stream"; id: string; chunk: string }
  | { type: "patch"; id: string; patch: Partial<WebviewMessage> }
  | { type: "busy"; busy: boolean }
  | { type: "panel"; panel: PanelSnapshot | null }
  | { type: "clear" }
  | { type: "notice"; level: "info" | "error"; text: string };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "submit"; text: string }
  | { type: "cancel" }
  | { type: "newSession" }
  | { type: "pickFile" }
  | { type: "openPath"; path: string };
