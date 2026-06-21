/**
 * Shared mutable chat state + pure ANSI/markdown helpers for the terminal UI.
 *
 * This module is the common dependency of all TUI submodules (renderer, input,
 * commands, workflowBridge, chatApp). It holds no I/O and no timers — only
 * data, types, constants, and pure functions. Message mutators here delegate
 * rendering to the renderer stored on {@link ChatState}.
 *
 * @module
 */

import path from "node:path";
import type { AgentConfig } from "../config.js";
import type { ChatMessage, LLMClient } from "../llmClient.js";
import type { MultiAgentRuntime } from "../runtime.js";
// Type-only import avoids a runtime cycle: renderer.ts imports values from
// state.ts, while state.ts only needs the Renderer type for ChatState.renderer.
import type { Renderer } from "./renderer.js";

// ---------------------------------------------------------------------------
// ANSI / color constants
// ---------------------------------------------------------------------------

export const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  reverse: "\u001b[7m",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
  altOn: "\u001b[?1049h",
  altOff: "\u001b[?1049l",
  clear: "\u001b[2J",
  home: "\u001b[H",
};

export const COLORS = {
  border: "\u001b[38;5;238m",
  borderStrong: "\u001b[38;5;245m",
  header: "\u001b[38;5;230m",
  accent: "\u001b[38;5;179m",
  accentSoft: "\u001b[38;5;143m",
  system: "\u001b[38;5;215m",
  user: "\u001b[38;5;110m",
  assistant: "\u001b[38;5;230m",
  status: "\u001b[38;5;150m",
  warning: "\u001b[38;5;222m",
  error: "\u001b[38;5;167m",
  placeholder: "\u001b[38;5;244m",
  muted: "\u001b[38;5;240m",
  input: "\u001b[38;5;231m",
};

export const WINDOWS_INPUT_MODE_ENABLE_EXTENDED_FLAGS = 0x0080;
export const WINDOWS_INPUT_MODE_ENABLE_MOUSE_INPUT = 0x0010;
export const WINDOWS_INPUT_MODE_ENABLE_QUICK_EDIT = 0x0040;
export const WINDOWS_INPUT_MODE_ENABLE_VT_INPUT = 0x0200;
export const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
export const DISABLE_MOUSE_TRACKING = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

export const NATIVE_CONSOLE_CSHARP = [
  "$signature = @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class NativeConsole {",
  '  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int nStdHandle);',
  '  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out int lpMode);',
  '  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, int dwMode);',
  "}",
  "'@",
  "Add-Type -TypeDefinition $signature | Out-Null",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UiRole = "system" | "user" | "assistant" | "status" | "error";
type UiVariant = "plain" | "event" | "stream";

export interface UiMessage {
  role: UiRole;
  title: string;
  content: string;
  variant?: UiVariant;
  subtitle?: string;
  active?: boolean;
  collapsed?: boolean;
}

export interface SidePanelState {
  mode: "idle" | "chat" | "workflow" | "benchmark";
  goal: string;
  currentCase: string;
  currentTaskId: string;
  currentTaskType: string;
  outputDir: string;
  runStatus: string;
  qualityStatus: string;
  persistStatus: string;
  totalArtifacts: number;
  plannedTasks: number;
  completedTasks: number;
  runningTasks: number;
  pendingTasks: number;
  blockedTasks: number;
  failedTasks: number;
  readyTasks: number;
  benchmarkTotal: number;
  benchmarkDone: number;
  benchmarkPassed: number;
  benchmarkFailed: number;
  benchmarkError: number;
  mouseWheelEvents: number;
  lastMouseSequence: string;
  pendingScrollDelta: number;
  lastRawChunk: string;
  lastParsedKey: string;
  lastStreamTag: string;
  currentAgent: string;
  currentModel: string;
  currentPromptPreview: string;
  activeSessionId: string;
  activeLlmStartedAt: number;
  lastLlmChunkAt: number;
  llmChunkCount: number;
  lastHeartbeatAt: number;
  llmStatus: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  recentEvents: string[];
}

export interface TranscriptLayout {
  lines: string[];
  messageStarts: number[];
}

export type ConversationDecision =
  | { action: "chat" }
  | { action: "respond"; title: string; content: string }
  | { action: "ask_clarification"; filePath: string; message: string }
  | { action: "run_workflow"; goal: "design"; input: string; output?: string; reason: string };

interface WorkflowMemory {
  goal: string;
  input: string;
  output: string;
  artifacts: Record<string, string>;
  preview: string;
  completedAt: string;
}

interface FollowUpAction {
  id: string;
  label: string;
  decision: ConversationDecision;
}

/**
 * Shared mutable state for the terminal chat app. All submodules mutate this
 * single instance directly (no cloning) and call {@link Renderer} methods via
 * the `renderer` reference for screen updates.
 */
export interface ChatState {
  config: AgentConfig;
  llm: LLMClient;
  renderer: Renderer;

  // Messages
  messages: UiMessage[];
  chatHistory: ChatMessage[];
  sessionMemory: string[];
  workflowMemories: WorkflowMemory[];
  followUpActions: FollowUpAction[];
  streamMessageIndex: Map<string, number>;

  // Composer / input
  input: string;
  cursorIndex: number;
  inputHistory: string[];
  historyIndex: number;
  historyDraft: string;

  // Scrolling
  scrollOffset: number;
  autoScroll: boolean;
  pendingScrollDelta: number;

  // Panel
  panel: SidePanelState;

  // Search
  searchMode: boolean;
  searchQuery: string;
  searchMatches: number[];
  searchMatchIndex: number;

  // Lifecycle
  busy: boolean;
  exiting: boolean;
  footerHint: string;

  // File-path tracking
  pendingFilePath: string | null;

  // Workflow
  currentRuntime: MultiAgentRuntime | null;
  cancelRequested: boolean;
  windowsInputModeBeforeTui: number | null;
}

export interface ChatAppOptions {
  config: AgentConfig;
}

// ---------------------------------------------------------------------------
// Panel + state construction
// ---------------------------------------------------------------------------

export function defaultPanelState(): SidePanelState {
  return {
    mode: "idle",
    goal: "",
    currentCase: "",
    currentTaskId: "",
    currentTaskType: "",
    outputDir: "",
    runStatus: "idle",
    qualityStatus: "unknown",
    persistStatus: "not_saved",
    totalArtifacts: 0,
    plannedTasks: 0,
    completedTasks: 0,
    runningTasks: 0,
    pendingTasks: 0,
    blockedTasks: 0,
    failedTasks: 0,
    readyTasks: 0,
    benchmarkTotal: 0,
    benchmarkDone: 0,
    benchmarkPassed: 0,
    benchmarkFailed: 0,
    benchmarkError: 0,
    mouseWheelEvents: 0,
    lastMouseSequence: "",
    pendingScrollDelta: 0,
    lastRawChunk: "",
    lastParsedKey: "",
    lastStreamTag: "",
    currentAgent: "",
    currentModel: "",
    currentPromptPreview: "",
    activeSessionId: "",
    activeLlmStartedAt: 0,
    lastLlmChunkAt: 0,
    llmChunkCount: 0,
    lastHeartbeatAt: 0,
    llmStatus: "idle",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    recentEvents: [],
  };
}

export function resolveDefaultOutput(config: AgentConfig, goal: string): string {
  return path.join(config.output.defaultDir, goal);
}

// ---------------------------------------------------------------------------
// Message mutators (shared across chatApp, commands, workflowBridge)
// ---------------------------------------------------------------------------

export function pushMessage(
  state: ChatState,
  role: UiRole,
  title: string,
  content: string,
  extras: Partial<Omit<UiMessage, "role" | "title" | "content">> = {},
): void {
  state.messages.push({ role, title, content, variant: "plain", ...extras });
  state.renderer.pinScroll();
  state.renderer.requestRender();
}

export function pushAssistantMessage(state: ChatState, title: string, content: string): void {
  pushMessage(state, "assistant", title, content);
  state.chatHistory.push({ role: "assistant", content: `${title}\n${content}` });
  trimChatHistory(state);
}

export function rememberSession(state: ChatState, content: string): void {
  state.sessionMemory.push(truncateToWidth(content, 4000));
  while (state.sessionMemory.length > 8) {
    state.sessionMemory.shift();
  }
}

export function memoryForPrompt(state: ChatState, maxChars: number): string {
  const structured = state.workflowMemories.slice(-4).map((memory) => {
    return [
      `Workflow: ${memory.goal}`,
      `completedAt: ${memory.completedAt}`,
      `input: ${memory.input}`,
      `output: ${memory.output}`,
      `artifacts: ${JSON.stringify(memory.artifacts)}`,
      memory.preview ? `preview:\n${memory.preview}` : "",
    ].filter(Boolean).join("\n");
  });
  const text = [...structured, ...state.sessionMemory.slice(-4)].filter(Boolean).join("\n\n---\n\n");
  return text ? truncateToWidth(text, maxChars) : "No workflow artifacts have been completed in this TUI session yet.";
}

export function trimChatHistory(state: ChatState): void {
  const maxMessages = 24;
  if (state.chatHistory.length <= maxMessages) return;
  state.chatHistory.splice(0, state.chatHistory.length - maxMessages);
}

// ---------------------------------------------------------------------------
// Pure ANSI / width / markdown helpers
// ---------------------------------------------------------------------------

export function formatMouseSequenceDebug(sequence: string): string {
  return Array.from(sequence)
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code === 0x1b) return "ESC";
      if (code < 32 || code === 127) return `0x${code.toString(16).padStart(2, "0")}`;
      return char;
    })
    .join(" ");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function repeat(char: string, count: number): string {
  return count > 0 ? char.repeat(count) : "";
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function charWidth(char: string): number {
  if (!char) return 0;
  const codePoint = char.codePointAt(0) ?? 0;
  if (
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff)
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf)
  ) {
    return 2;
  }
  return 1;
}

export function stringWidth(text: string): number {
  let width = 0;
  for (const char of Array.from(stripAnsi(text))) {
    width += charWidth(char);
  }
  return width;
}

export function padToWidth(text: string, width: number): string {
  const current = stringWidth(text);
  if (current >= width) return text;
  return text + repeat(" ", width - current);
}

export function fitToWidth(text: string, width: number): string {
  const safe = sanitizeTerminalText(text);
  const current = stringWidth(safe);
  if (current === width) return safe;
  if (current < width) return safe + repeat(" ", width - current);
  // 永远不要直接截断 ANSI 文本。截断的 CSI 序列会渲染为可见的乱码，
  // 例如在转录中显示 "[38;5;179m"。
  return truncateToWidth(stripAnsi(safe), width);
}

/** 移除危险的终端控制字符，只保留 SGR 颜色序列。 */
export function sanitizeTerminalText(text: string): string {
  return text
    // 移除 OSC 序列（例如超链接）
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    // 只保留 SGR（颜色）序列；移除所有其他 CSI 序列
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, (seq) => {
      return /^\u001b\[[\d;]*m$/.test(seq) ? seq : "";
    })
    // 在处理完有效 SGR 序列后，移除孤立的 ESC 字节
    .replace(/\u001b(?!\[[\d;]*m)/g, "")
    // 移除破坏终端布局的字符
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, "")
    .replace(/\t/g, "  ");
}

export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let result = "";
  let currentWidth = 0;
  for (const char of Array.from(stripAnsi(text))) {
    const nextWidth = charWidth(char);
    if (currentWidth + nextWidth > width) break;
    result += char;
    currentWidth += nextWidth;
  }
  return result;
}

export function lineWithLabel(width: number, label = ""): string {
  if (!label) return repeat("─", width);
  const safeLabel = truncateToWidth(stripAnsi(sanitizeTerminalText(label)), Math.max(0, width - 2));
  const decorated = ` ${safeLabel} `;
  return decorated + repeat("─", Math.max(0, width - stringWidth(decorated)));
}

export function statusColor(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("fail") || normalized.includes("error") || normalized.includes("blocked")) {
    return COLORS.error;
  }
  if (normalized.includes("run") || normalized.includes("stream") || normalized.includes("pending")) {
    return COLORS.warning;
  }
  if (normalized.includes("complete") || normalized.includes("pass") || normalized.includes("ready")) {
    return COLORS.status;
  }
  return COLORS.placeholder;
}

export function compactValue(value: string, fallback = "-"): string {
  return value.trim() ? value : fallback;
}

export function compactStreamPreview(text: string): string {
  const plain = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!plain) return "(empty stream)";
  const lines = plain.split("\n").filter((line) => line.trim().length > 0);
  const preview = lines.slice(0, 6).join("\n");
  return lines.length > 6 ? `${preview}\n${COLORS.placeholder}... collapsed ${lines.length - 6} more lines${ANSI.reset}` : preview;
}

export function activeStreamTail(text: string): string {
  const lines = text.split("\n");
  const maxLines = 40;
  if (lines.length <= maxLines) return text;
  return `${COLORS.placeholder}... streaming tail, ${lines.length - maxLines} earlier lines hidden${ANSI.reset}\n${lines.slice(-maxLines).join("\n")}`;
}

export function streamStats(text: string): string {
  const chars = Array.from(text).length;
  const lines = text ? text.split("\n").length : 0;
  return `${lines} lines | ${chars} chars`;
}

export function estimateTokens(text: string): number {
  let tokens = 0;
  let asciiRun = "";
  const flushAscii = () => {
    if (!asciiRun) return;
    tokens += Math.ceil(asciiRun.length / 4);
    asciiRun = "";
  };

  for (const char of Array.from(text)) {
    const codePoint = char.codePointAt(0) ?? 0;
    const isCjk =
      (codePoint >= 0x3400 && codePoint <= 0x9fff) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff);
    if (isCjk) {
      flushAscii();
      tokens += 1;
      continue;
    }
    asciiRun += char;
  }

  flushAscii();
  return tokens;
}

export function elapsedSeconds(sinceMs: number): string {
  if (!sinceMs) return "-";
  return `${Math.max(0, Math.floor((Date.now() - sinceMs) / 1000))}s`;
}

export function wrapLine(line: string, width: number): string[] {
  if (width <= 1) return [line];
  if (!line) return [""];

  const result: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const char of Array.from(line)) {
    const nextWidth = charWidth(char);
    if (currentWidth + nextWidth > width) {
      result.push(current);
      current = char;
      currentWidth = nextWidth;
      continue;
    }
    current += char;
    currentWidth += nextWidth;
  }

  result.push(current);
  return result;
}

export function wrapText(text: string, width: number): string[] {
  const lines = text.split("\n");
  const wrapped: string[] = [];
  for (const line of lines) {
    wrapped.push(...wrapLine(line, width));
  }
  return wrapped.length > 0 ? wrapped : [""];
}

/**
 * 包装可能包含 ANSI 转义序列的字符串，
 * 在原始位置保留转义序列，只在可见字符边界处换行。
 */
export function wrapLineAnsiAware(text: string, width: number): string[] {
  if (width <= 1) return [text];
  if (!text) return [""];

  // 分词为可见字符和 ANSI 序列
  type Token = { kind: "ansi"; text: string } | { kind: "char"; text: string; width: number };
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\u001b" && i + 1 < text.length && text[i + 1] === "[") {
      // ANSI 转义序列：ESC [ ... m
      let j = i + 2;
      while (j < text.length && text[j] !== "m") j++;
      if (j < text.length) j++; // 包含 'm'
      tokens.push({ kind: "ansi", text: text.slice(i, j) });
      i = j;
    } else {
      // 可见字符（通过 Array.from 处理多字节）
      const chars = Array.from(text.slice(i));
      const char = chars[0];
      tokens.push({ kind: "char", text: char, width: charWidth(char) });
      i += char.length;
    }
  }

  // 构建换行后的行，保留 ANSI 码
  const result: string[] = [];
  let current = "";
  let currentWidth = 0;
  // 跟踪活动 ANSI 样式以传递到下一行
  let activeStyles = "";

  for (const token of tokens) {
    if (token.kind === "ansi") {
      current += token.text;
      if (token.text === ANSI.reset) {
        activeStyles = "";
      } else if (token.text.endsWith("m")) {
        // 跟踪非重置样式（简化版）
        activeStyles += token.text;
      }
      continue;
    }
    // 可见字符
    if (currentWidth + token.width > width && currentWidth > 0) {
      // 在此处断开，关闭当前行并用活动样式开始新行
      result.push(current + ANSI.reset);
      current = activeStyles + token.text;
      currentWidth = token.width;
    } else {
      current += token.text;
      currentWidth += token.width;
    }
  }

  if (current || result.length === 0) {
    result.push(current);
  }
  return result;
}

export function roleColor(role: UiRole): string {
  if (role === "system") return COLORS.system;
  if (role === "user") return COLORS.user;
  if (role === "assistant") return COLORS.assistant;
  if (role === "error") return COLORS.error;
  return COLORS.status;
}

// ---------------------------------------------------------------------------
// 极简内联 Markdown 转 ANSI 渲染器
// ---------------------------------------------------------------------------

/**
 * 将部分 Markdown 渲染为 ANSI 转义的终端文本。
 * 支持：**粗体**、*斜体*、`代码`、```代码块```、
 * # 标题、- / * 列表、> 引用、表格和链接。
 *
 * 表格渲染为堆叠的键值对形式，以便在窄终端宽度下自然换行。
 */
export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let inTable = false;
  let tableRows: string[][] = [];
  let tableHeader: string[] | null = null;

  // 将累积的表格行刷新为列表样式渲染
  const flushTable = (): void => {
    if (tableRows.length === 0) { inTable = false; return; }
    for (let i = 0; i < tableRows.length; i++) {
      const row = tableRows[i];
      if (tableHeader && row.length >= 2) {
        // 渲染每行：粗体(第一格) \n   描述(其余)
        const label = renderInlineMarkdown(row[0]);
        const desc = row.slice(1).map((c) => renderInlineMarkdown(c)).join(" - ");
        result.push(ANSI.bold + label + ANSI.reset);
        result.push("  " + COLORS.placeholder + desc + ANSI.reset);
      } else {
        // 单列或无表头：直接渲染单元格
        result.push(row.map((c) => renderInlineMarkdown(c)).join(", "));
      }
    }
    tableRows = [];
    tableHeader = null;
    inTable = false;
  };

  for (const line of lines) {
    // --- 带围栏代码块切换 ---
    if (line.trimStart().startsWith("```")) {
      if (inTable) flushTable();
      if (inCodeBlock) {
        result.push(COLORS.border + "\u2514" + "\u2500".repeat(20) + ANSI.reset);
        inCodeBlock = false;
        codeBlockLang = "";
      } else {
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim();
        result.push(COLORS.border + "\u250C" + "\u2500" + (codeBlockLang ? " " + COLORS.status + codeBlockLang + " " : "\u2500") + "\u2500".repeat(Math.max(0, 18 - (codeBlockLang ? codeBlockLang.length + 2 : 0))) + "\u2510" + ANSI.reset);
      }
      continue;
    }

    if (inCodeBlock) {
      result.push(COLORS.border + "\u2502 " + ANSI.reset + COLORS.status + line + ANSI.reset);
      continue;
    }

    // --- 表格行检测 ---
    const tableMatch = line.match(/^\|(.+)\|$/);
    if (tableMatch) {
      const cells = tableMatch[1].split("|").map((c) => c.trim());
      // 分隔行标记前一行为表头
      if (cells.every((c) => /^[-:]+$/.test(c))) {
        if (tableRows.length > 0 && !tableHeader) {
          tableHeader = tableRows.pop()!;
        }
        continue;
      }
      if (!inTable) inTable = true;
      tableRows.push(cells);
      continue;
    }
    // 如果之前在表格中但当前行不是表格行，则刷新
    if (inTable) flushTable();

    // --- 标题 ---
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = renderInlineMarkdown(headingMatch[2]);
      result.push(ANSI.bold + COLORS.header + "\u2588".repeat(7 - level) + " " + content + ANSI.reset);
      continue;
    }

    // --- 引用 ---
    if (line.trimStart().startsWith("> ")) {
      const content = line.trimStart().slice(2);
      result.push(COLORS.placeholder + "\u2502 " + renderInlineMarkdown(content) + ANSI.reset);
      continue;
    }

    // --- 无序列表项 ---
    const listMatch = line.match(/^(\s*)([-*])\s+(.*)/);
    if (listMatch) {
      const indent = listMatch[1];
      const content = listMatch[3];
      result.push(indent + COLORS.accent + "\u2022 " + ANSI.reset + renderInlineMarkdown(content));
      continue;
    }

    // --- 有序列表项 ---
    const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (orderedMatch) {
      const indent = orderedMatch[1];
      const num = orderedMatch[2];
      const content = orderedMatch[3];
      result.push(indent + COLORS.accent + num + ". " + ANSI.reset + renderInlineMarkdown(content));
      continue;
    }

    // --- 水平线 ---
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      result.push(COLORS.border + "\u2500".repeat(40) + ANSI.reset);
      continue;
    }

    // --- 普通行 ---
    result.push(renderInlineMarkdown(line));
  }

  if (inTable) flushTable();

  return result.join("\n");
}

/** 渲染内联 Markdown：**粗体**、*斜体*、`代码`、~~删除线~~、[链接](url)。 */
function renderInlineMarkdown(text: string): string {
  // 内联代码：`...`
  text = text.replace(/`([^`]+)`/g, (_, content: string) => COLORS.status + content + ANSI.reset);
  // 粗体加斜体：***...***
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, (_, content: string) => ANSI.bold + COLORS.assistant + content + ANSI.reset);
  // 粗体：**...**
  text = text.replace(/\*\*(.+?)\*\*/g, (_, content: string) => ANSI.bold + content + ANSI.reset);
  // 斜体：*...*
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, content: string) => "\u001b[3m" + content + ANSI.reset);
  // 删除线：~~...~~
  text = text.replace(/~~(.+?)~~/g, (_, content: string) => "\u001b[9m" + content + ANSI.reset);
  // 链接：[text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) => COLORS.accent + label + COLORS.placeholder + " (" + url + ")" + ANSI.reset);
  text = text.replace(/\u26a0\ufe0f?/g, COLORS.error + "[warning]" + ANSI.reset);
  return text;
}
