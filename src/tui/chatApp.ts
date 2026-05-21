import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { AgentConfig } from "../config.js";
import { BenchmarkRunner } from "../benchmark/runBenchmark.js";
import { LLMClient, type ChatMessage } from "../llmClient.js";
import { MultiAgentRuntime } from "../runtime.js";
import type { WorkflowEvent } from "../workflowEvents.js";
import {
  createInitialTerminalInputState,
  parseTerminalInput,
  type InputKey,
  type TerminalInputEvent,
} from "./terminalInput.js";
import {
  computeWheelStep,
  detectXtermJsWheelHost,
  initWheelAccel,
} from "./wheelAccel.js";

type UiRole = "system" | "user" | "assistant" | "status" | "error";
type UiVariant = "plain" | "event" | "stream";

interface UiMessage {
  role: UiRole;
  title: string;
  content: string;
  variant?: UiVariant;
  subtitle?: string;
  active?: boolean;
  collapsed?: boolean;
}

interface ChatAppOptions {
  config: AgentConfig;
  executionBackend?: string;
}

interface SidePanelState {
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

interface TranscriptLayout {
  lines: string[];
  messageStarts: number[];
}

type ConversationDecision =
  | { action: "chat" }
  | { action: "respond"; title: string; content: string }
  | { action: "ask_clarification"; filePath: string; message: string }
  | { action: "run_workflow"; goal: "analyze" | "design"; input: string; output?: string; reason: string };

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

const ANSI = {
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

const COLORS = {
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

const WINDOWS_INPUT_MODE_ENABLE_EXTENDED_FLAGS = 0x0080;
const WINDOWS_INPUT_MODE_ENABLE_MOUSE_INPUT = 0x0010;
const WINDOWS_INPUT_MODE_ENABLE_QUICK_EDIT = 0x0040;
const WINDOWS_INPUT_MODE_ENABLE_VT_INPUT = 0x0200;
const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
const DISABLE_MOUSE_TRACKING = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

const NATIVE_CONSOLE_CSHARP = [
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

function setWindowsConsoleMode(mode: number): void {
  const script = [
    ...NATIVE_CONSOLE_CSHARP,
    "$handle = [NativeConsole]::GetStdHandle(-10)",
    `if (-not [NativeConsole]::SetConsoleMode($handle, ${mode})) { exit 1 }`,
  ].join("\n");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["inherit", "ignore", "ignore"],
  });
}

function configureWindowsVirtualTerminalInput(): number | null {
  if (process.platform !== "win32") return null;

  const script = [
    ...NATIVE_CONSOLE_CSHARP,
    "$handle = [NativeConsole]::GetStdHandle(-10)",
    "$mode = 0",
    "if (-not [NativeConsole]::GetConsoleMode($handle, [ref]$mode)) { exit 1 }",
    `$newMode = ($mode -bor ${WINDOWS_INPUT_MODE_ENABLE_VT_INPUT} -bor ${WINDOWS_INPUT_MODE_ENABLE_MOUSE_INPUT} -bor ${WINDOWS_INPUT_MODE_ENABLE_EXTENDED_FLAGS}) -band (-bnot ${WINDOWS_INPUT_MODE_ENABLE_QUICK_EDIT})`,
    "if (-not [NativeConsole]::SetConsoleMode($handle, $newMode)) { exit 1 }",
    "Write-Output $mode",
  ].join("\n");

  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "ignore"],
    }).trim();
    const mode = Number.parseInt(output, 10);
    return Number.isFinite(mode) ? mode : null;
  } catch {
    return null;
  }
}

function formatMouseSequenceDebug(sequence: string): string {
  return Array.from(sequence)
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code === 0x1b) return "ESC";
      if (code < 32 || code === 127) return `0x${code.toString(16).padStart(2, "0")}`;
      return char;
    })
    .join(" ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function repeat(char: string, count: number): string {
  return count > 0 ? char.repeat(count) : "";
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function charWidth(char: string): number {
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

function stringWidth(text: string): number {
  let width = 0;
  for (const char of Array.from(stripAnsi(text))) {
    width += charWidth(char);
  }
  return width;
}

function padToWidth(text: string, width: number): string {
  const current = stringWidth(text);
  if (current >= width) return text;
  return text + repeat(" ", width - current);
}

function fitToWidth(text: string, width: number): string {
  const safe = sanitizeTerminalText(text);
  const current = stringWidth(safe);
  if (current === width) return safe;
  if (current < width) return safe + repeat(" ", width - current);
  // Never truncate ANSI text directly. A sliced CSI sequence renders as
  // visible garbage such as "[38;5;179m" in the transcript.
  return truncateToWidth(stripAnsi(safe), width);
}

/** Strip dangerous terminal control characters, keeping only SGR color sequences. */
function sanitizeTerminalText(text: string): string {
  return text
    // Remove OSC sequences (e.g. hyperlinks)
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    // Keep only SGR (color) sequences; strip all other CSI sequences
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, (seq) => {
      return /^\u001b\[[\d;]*m$/.test(seq) ? seq : "";
    })
    // Strip stray ESC bytes after valid SGR sequences have been handled.
    .replace(/\u001b(?!\[[\d;]*m)/g, "")
    // Remove characters that break terminal layout
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, "")
    .replace(/\t/g, "  ");
}

function truncateToWidth(text: string, width: number): string {
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

function lineWithLabel(width: number, label = ""): string {
  if (!label) return repeat("─", width);
  const safeLabel = truncateToWidth(stripAnsi(sanitizeTerminalText(label)), Math.max(0, width - 2));
  const decorated = ` ${safeLabel} `;
  return decorated + repeat("─", Math.max(0, width - stringWidth(decorated)));
}

function statusColor(status: string): string {
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

function compactValue(value: string, fallback = "-"): string {
  return value.trim() ? value : fallback;
}

function compactStreamPreview(text: string): string {
  const plain = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!plain) return "(empty stream)";
  const lines = plain.split("\n").filter((line) => line.trim().length > 0);
  const preview = lines.slice(0, 6).join("\n");
  return lines.length > 6 ? `${preview}\n${COLORS.placeholder}... collapsed ${lines.length - 6} more lines${ANSI.reset}` : preview;
}

function activeStreamTail(text: string): string {
  const lines = text.split("\n");
  const maxLines = 40;
  if (lines.length <= maxLines) return text;
  return `${COLORS.placeholder}... streaming tail, ${lines.length - maxLines} earlier lines hidden${ANSI.reset}\n${lines.slice(-maxLines).join("\n")}`;
}

function streamStats(text: string): string {
  const chars = Array.from(text).length;
  const lines = text ? text.split("\n").length : 0;
  return `${lines} lines | ${chars} chars`;
}

function estimateTokens(text: string): number {
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

function elapsedSeconds(sinceMs: number): string {
  if (!sinceMs) return "-";
  return `${Math.max(0, Math.floor((Date.now() - sinceMs) / 1000))}s`;
}

function wrapLine(line: string, width: number): string[] {
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

function wrapText(text: string, width: number): string[] {
  const lines = text.split("\n");
  const wrapped: string[] = [];
  for (const line of lines) {
    wrapped.push(...wrapLine(line, width));
  }
  return wrapped.length > 0 ? wrapped : [""];
}

function layoutInputLines(
  text: string,
  width: number,
  cursorIndex: number,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const chars = Array.from(text);
  const lines: string[] = [];
  let currentLine = "";
  let currentWidth = 0;
  let cursorLine = 0;
  let cursorCol = 0;
  let cursorPlaced = false;

  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    const nextWidth = charWidth(char);

    if (currentWidth + nextWidth > width && currentWidth > 0) {
      lines.push(currentLine);
      currentLine = "";
      currentWidth = 0;
      if (!cursorPlaced && cursorIndex === index) {
        cursorLine = lines.length;
        cursorCol = 0;
        cursorPlaced = true;
      }
    }

    if (!cursorPlaced && cursorIndex === index) {
      cursorLine = lines.length;
      cursorCol = currentWidth;
      cursorPlaced = true;
    }

    currentLine += char;
    currentWidth += nextWidth;
  }

  if (!cursorPlaced) {
    if (currentWidth >= width && currentLine) {
      lines.push(currentLine);
      currentLine = "";
      currentWidth = 0;
    }
    cursorLine = lines.length;
    cursorCol = currentWidth;
  }

  if (currentLine || lines.length === 0 || cursorLine === lines.length) {
    lines.push(currentLine);
  }

  return { lines, cursorLine, cursorCol };
}

/**
 * Wrap a string that may contain ANSI escape sequences, preserving
 * the escape sequences at their original positions and only breaking
 * at visible-character boundaries.
 */
function wrapLineAnsiAware(text: string, width: number): string[] {
  if (width <= 1) return [text];
  if (!text) return [""];

  // Tokenize into visible chars and ANSI sequences
  type Token = { kind: "ansi"; text: string } | { kind: "char"; text: string; width: number };
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\u001b" && i + 1 < text.length && text[i + 1] === "[") {
      // ANSI escape sequence: ESC [ ... m
      let j = i + 2;
      while (j < text.length && text[j] !== "m") j++;
      if (j < text.length) j++; // include the 'm'
      tokens.push({ kind: "ansi", text: text.slice(i, j) });
      i = j;
    } else {
      // Visible character (handle multi-byte via Array.from)
      const chars = Array.from(text.slice(i));
      const char = chars[0];
      tokens.push({ kind: "char", text: char, width: charWidth(char) });
      i += char.length;
    }
  }

  // Build wrapped lines preserving ANSI codes
  const result: string[] = [];
  let current = "";
  let currentWidth = 0;
  // Track active ANSI styles to carry over to next line
  let activeStyles = "";

  for (const token of tokens) {
    if (token.kind === "ansi") {
      current += token.text;
      if (token.text === ANSI.reset) {
        activeStyles = "";
      } else if (token.text.endsWith("m")) {
        // Track non-reset styles (simplified)
        activeStyles += token.text;
      }
      continue;
    }
    // Visible character
    if (currentWidth + token.width > width && currentWidth > 0) {
      // Break here, close current and start new line with active styles
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

function roleColor(role: UiRole): string {
  if (role === "system") return COLORS.system;
  if (role === "user") return COLORS.user;
  if (role === "assistant") return COLORS.assistant;
  if (role === "error") return COLORS.error;
  return COLORS.status;
}

// ---------------------------------------------------------------------------
// Minimal inline Markdown to ANSI renderer
// ---------------------------------------------------------------------------

/**
 * Render a subset of Markdown to ANSI-escaped terminal text.
 * Handles: **bold**, *italic*, `code`, ```code blocks```,
 * # headings, - / * lists, > blockquotes, tables, and links.
 *
 * Tables are rendered as stacked key-value pairs so they wrap naturally
 * in narrow terminal widths.
 */
function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let inTable = false;
  let tableRows: string[][] = [];
  let tableHeader: string[] | null = null;

  // Flush accumulated table rows into a list-style rendering
  const flushTable = (): void => {
    if (tableRows.length === 0) { inTable = false; return; }
    for (let i = 0; i < tableRows.length; i++) {
      const row = tableRows[i];
      if (tableHeader && row.length >= 2) {
        // Render each row as: bold(first_cell) \n   description(rest)
        const label = renderInlineMarkdown(row[0]);
        const desc = row.slice(1).map((c) => renderInlineMarkdown(c)).join(" - ");
        result.push(ANSI.bold + label + ANSI.reset);
        result.push("  " + COLORS.placeholder + desc + ANSI.reset);
      } else {
        // Single-column or no header: just render cells
        result.push(row.map((c) => renderInlineMarkdown(c)).join(", "));
      }
    }
    tableRows = [];
    tableHeader = null;
    inTable = false;
  };

  for (const line of lines) {
    // --- fenced code block toggle ---
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

    // --- table row detection ---
    const tableMatch = line.match(/^\|(.+)\|$/);
    if (tableMatch) {
      const cells = tableMatch[1].split("|").map((c) => c.trim());
      // separator row marks previous row as header
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
    // If we were in a table but this line is not a table line, flush
    if (inTable) flushTable();

    // --- heading ---
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = renderInlineMarkdown(headingMatch[2]);
      result.push(ANSI.bold + COLORS.header + "\u2588".repeat(7 - level) + " " + content + ANSI.reset);
      continue;
    }

    // --- blockquote ---
    if (line.trimStart().startsWith("> ")) {
      const content = line.trimStart().slice(2);
      result.push(COLORS.placeholder + "\u2502 " + renderInlineMarkdown(content) + ANSI.reset);
      continue;
    }

    // --- list item (unordered) ---
    const listMatch = line.match(/^(\s*)([-*])\s+(.*)/);
    if (listMatch) {
      const indent = listMatch[1];
      const content = listMatch[3];
      result.push(indent + COLORS.accent + "\u2022 " + ANSI.reset + renderInlineMarkdown(content));
      continue;
    }

    // --- list item (ordered) ---
    const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (orderedMatch) {
      const indent = orderedMatch[1];
      const num = orderedMatch[2];
      const content = orderedMatch[3];
      result.push(indent + COLORS.accent + num + ". " + ANSI.reset + renderInlineMarkdown(content));
      continue;
    }

    // --- horizontal rule ---
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      result.push(COLORS.border + "\u2500".repeat(40) + ANSI.reset);
      continue;
    }

    // --- normal line ---
    result.push(renderInlineMarkdown(line));
  }

  if (inTable) flushTable();

  return result.join("\n");
}

/** Render inline Markdown: **bold**, *italic*, `code`, ~~strikethrough~~, [link](url). */
function renderInlineMarkdown(text: string): string {
  // Inline code: `...`
  text = text.replace(/`([^`]+)`/g, (_, content: string) => COLORS.status + content + ANSI.reset);
  // Bold+italic: ***...***
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, (_, content: string) => ANSI.bold + COLORS.assistant + content + ANSI.reset);
  // Bold: **...**
  text = text.replace(/\*\*(.+?)\*\*/g, (_, content: string) => ANSI.bold + content + ANSI.reset);
  // Italic: *...*
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, content: string) => "\u001b[3m" + content + ANSI.reset);
  // Strikethrough: ~~...~~
  text = text.replace(/~~(.+?)~~/g, (_, content: string) => "\u001b[9m" + content + ANSI.reset);
  // Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) => COLORS.accent + label + COLORS.placeholder + " (" + url + ")" + ANSI.reset);
  text = text.replace(/\u26a0\ufe0f?/g, COLORS.error + "[warning]" + ANSI.reset);
  return text;
}

function defaultPanelState(): SidePanelState {
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

export class TerminalChatApp {
  private readonly config: AgentConfig;
  private readonly llm: LLMClient;
  private readonly executionBackend: string;
  private readonly messages: UiMessage[] = [];
  private readonly chatHistory: ChatMessage[] = [];
  private readonly sessionMemory: string[] = [];
  private readonly workflowMemories: WorkflowMemory[] = [];
  private readonly followUpActions: FollowUpAction[] = [];
  private readonly cleanupHandlers: Array<() => void> = [];
  private readonly inputHistory: string[] = [];
  private readonly streamMessageIndex = new Map<string, number>();
  private readonly panel = defaultPanelState();
  private input = "";
  private cursorIndex = 0;
  private scrollOffset = 0;
  private autoScroll = true;
  private terminalInputState = createInitialTerminalInputState();
  private incompleteInputTimer: NodeJS.Timeout | null = null;
  private scrollDrainTimer: NodeJS.Timeout | null = null;
  private activityRefreshTimer: NodeJS.Timeout | null = null;
  private pendingScrollDelta = 0;
  private wheelAccel = initWheelAccel(detectXtermJsWheelHost(), 1);
  private busy = false;
  private exiting = false;
  private historyIndex = -1;
  private historyDraft = "";
  private pendingFilePath: string | null = null;
  private currentRuntime: MultiAgentRuntime | null = null;
  private cancelRequested = false;
  private searchMode = false;
  private searchQuery = "";
  private searchMatches: number[] = [];
  private searchMatchIndex = 0;
  private footerHint = "Enter send | Wheel/PgUp/PgDn scroll | Ctrl+R search | Ctrl+C exit";
  private windowsInputModeBeforeTui: number | null = null;
  private readonly normalInputTimeoutMs = 50;
  private readonly pasteInputTimeoutMs = 500;

  constructor(options: ChatAppOptions) {
    this.config = options.config;
    this.llm = new LLMClient(options.config);
    this.executionBackend = options.executionBackend ?? "thread";
  }

  async start(): Promise<void> {
    this.enterScreen();
    this.pushMessage("system", "ReqDesign Chat", [
      "交互模式已启动。",
      "普通输入走对话模型；/design /analyze /benchmark 会把本地流程实时流式输出到左侧会话区。",
      "支持 Ctrl+R 搜索记录、Up/Down 输入历史、右侧状态面板实时查看任务进度。",
    ].join("\n"));
    this.render();

    // Safety net: ensure terminal state is restored even on uncaught exceptions
    const emergencyCleanup = () => {
      try {
        process.stdout.write("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1007l"); // Disable all mouse modes
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdout.write(ANSI.showCursor + ANSI.altOff + ANSI.reset + "\n");
      } catch { /* best effort */ }
    };
    process.on("uncaughtException", emergencyCleanup);
    process.on("SIGINT", emergencyCleanup);
    process.on("exit", emergencyCleanup);

    await new Promise<void>((resolve) => {
      const onExit = () => resolve();
      this.cleanupHandlers.push(onExit);
    });
  }


  private enterScreen(): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    this.windowsInputModeBeforeTui = configureWindowsVirtualTerminalInput();
    process.stdin.setEncoding("utf8");
    process.stdin.resume();

    process.stdout.write(ANSI.altOn + ANSI.clear + ANSI.home + ENABLE_MOUSE_TRACKING + ANSI.hideCursor);

    const inputHandler = (chunk: string | Buffer) => {
      this.processTerminalChunk(chunk);
    };
    const resizeHandler = () => {
      this.reassertTerminalModes();
      this.render();
    };

    process.stdin.on("data", inputHandler);
    process.stdout.on("resize", resizeHandler);
    setTimeout(() => this.reassertTerminalModes(), 0);

    this.cleanupHandlers.push(() => {
      process.stdout.off("resize", resizeHandler);
      process.stdin.off("data", inputHandler);
      if (this.incompleteInputTimer) {
        clearTimeout(this.incompleteInputTimer);
        this.incompleteInputTimer = null;
      }
      if (this.scrollDrainTimer) {
        clearTimeout(this.scrollDrainTimer);
        this.scrollDrainTimer = null;
      }
      if (this.activityRefreshTimer) {
        clearInterval(this.activityRefreshTimer);
        this.activityRefreshTimer = null;
      }
      process.stdout.write(DISABLE_MOUSE_TRACKING);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      if (this.windowsInputModeBeforeTui !== null) {
        try {
          setWindowsConsoleMode(this.windowsInputModeBeforeTui);
        } catch {
          // best effort restore
        }
        this.windowsInputModeBeforeTui = null;
      }
      process.stdout.write(ANSI.showCursor + ANSI.altOff + ANSI.reset);
    });
  }

  private reassertTerminalModes(): void {
    process.stdout.write(ENABLE_MOUSE_TRACKING + ANSI.hideCursor);
  }

  private processTerminalChunk(input: string | Buffer | null): void {
    if (input !== null) {
      const rawText = typeof input === "string" ? input : String(input);
      this.panel.lastRawChunk = formatMouseSequenceDebug(rawText);
    }
    const [events, nextState] = parseTerminalInput(this.terminalInputState, input);
    this.terminalInputState = nextState;

    if (events.length > 0) {
      for (const event of events) {
        void this.handleTerminalInputEvent(event);
      }
    }

    if (this.incompleteInputTimer) {
      clearTimeout(this.incompleteInputTimer);
      this.incompleteInputTimer = null;
    }

    if (this.terminalInputState.incomplete) {
      this.incompleteInputTimer = setTimeout(
        () => {
          this.incompleteInputTimer = null;
          if (process.stdin.readableLength > 0) {
            this.incompleteInputTimer = setTimeout(() => this.processTerminalChunk(null), this.normalInputTimeoutMs);
            return;
          }
          this.processTerminalChunk(null);
        },
        this.terminalInputState.mode === "IN_PASTE" ? this.pasteInputTimeoutMs : this.normalInputTimeoutMs,
      );
    }
  }

  private async handleTerminalInputEvent(event: TerminalInputEvent): Promise<void> {
    if (event.kind === "mouse") {
      this.panel.lastMouseSequence = formatMouseSequenceDebug(event.sequence);
      this.panel.lastParsedKey = `mouse:${event.button}:${event.action}@${event.col},${event.row}`;
      this.render();
      return;
    }

    const { key, text } = event;
    this.panel.lastParsedKey = [
      key.name ?? "(text)",
      key.ctrl ? "ctrl" : "",
      key.meta ? "meta" : "",
      key.shift ? "shift" : "",
      text ? `text=${JSON.stringify(text)}` : "",
    ].filter(Boolean).join(" ");
    if (key.name === "wheelup") {
      this.panel.mouseWheelEvents += 1;
      this.panel.lastMouseSequence = formatMouseSequenceDebug(key.sequence);
      this.queueWheelScroll(-1);
      return;
    }
    if (key.name === "wheeldown") {
      this.panel.mouseWheelEvents += 1;
      this.panel.lastMouseSequence = formatMouseSequenceDebug(key.sequence);
      this.queueWheelScroll(1);
      return;
    }
    await this.handleKeypress(text ?? "", key);
  }

  private async handleKeypress(text: string, key: InputKey): Promise<void> {
    if (this.exiting) return;

    if (key.ctrl && key.name === "c") {
      if (this.busy && this.currentRuntime) {
        this.requestCancelWorkflow("cancelled by Ctrl+C");
        return;
      }
      this.shutdown(130);
      return;
    }

    if (this.busy && key.name === "escape") {
      this.requestCancelWorkflow("cancelled by Escape");
      return;
    }

    if (key.name === "pageup") {
      this.scrollTranscriptByPage(-1);
      return;
    }
    if (key.name === "pagedown") {
      this.scrollTranscriptByPage(1);
      return;
    }

    if (key.ctrl && key.name === "l") {
      this.render();
      return;
    }
    if (key.ctrl && key.name === "r") {
      if (this.searchMode) {
        this.exitSearchMode();
      } else {
        this.enterSearchMode();
      }
      return;
    }

    if (this.searchMode) {
      this.handleSearchKeypress(text, key);
      return;
    }

    if (key.name === "escape") {
      return;
    }

    if (this.busy) {
      return;
    }

    if (key.ctrl && key.name === "j") {
      this.insertText("\n");
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      await this.submitInput();
      return;
    }
    if (key.name === "backspace") {
      this.deleteBackward();
      return;
    }
    if (key.name === "delete") {
      this.deleteForward();
      return;
    }
    if (key.name === "left") {
      this.cursorIndex = Math.max(0, this.cursorIndex - 1);
      this.render();
      return;
    }
    if (key.name === "right") {
      this.cursorIndex = Math.min(Array.from(this.input).length, this.cursorIndex + 1);
      this.render();
      return;
    }
    if (key.name === "home") {
      this.cursorIndex = 0;
      this.render();
      return;
    }
    if (key.name === "end") {
      this.cursorIndex = Array.from(this.input).length;
      this.render();
      return;
    }
    if (key.name === "up") {
      // If input is empty, scroll up instead of navigating history
      if (!this.input) {
        this.scrollTranscriptBy(-3);
        return;
      }
      if (this.navigateHistory(-1)) return;
      return;
    }
    if (key.name === "down") {
      // If input is empty, scroll down instead of navigating history
      if (!this.input) {
        this.scrollTranscriptBy(3);
        return;
      }
      if (this.navigateHistory(1)) return;
      return;
    }
    if (key.name === "tab") {
      this.insertText("  ");
      return;
    }

    if (text && !key.ctrl && !key.meta) {
      this.insertText(text);
    }
  }

  private handleSearchKeypress(text: string, key: InputKey): void {
    if (key.name === "escape") {
      this.exitSearchMode();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      if (this.searchMatches.length > 0) {
        this.searchMatchIndex = (this.searchMatchIndex + 1) % this.searchMatches.length;
        this.jumpToCurrentSearchResult();
      }
      this.render();
      return;
    }
    if (key.name === "backspace") {
      if (this.searchQuery.length > 0) {
        this.searchQuery = Array.from(this.searchQuery).slice(0, -1).join("");
        this.refreshSearch();
      }
      return;
    }
    if (key.name === "delete") {
      return;
    }
    if (key.name === "up") {
      if (this.searchMatches.length > 0) {
        this.searchMatchIndex = (this.searchMatchIndex - 1 + this.searchMatches.length) % this.searchMatches.length;
        this.jumpToCurrentSearchResult();
      }
      this.render();
      return;
    }
    if (key.name === "down") {
      if (this.searchMatches.length > 0) {
        this.searchMatchIndex = (this.searchMatchIndex + 1) % this.searchMatches.length;
        this.jumpToCurrentSearchResult();
      }
      this.render();
      return;
    }
    if (text && !key.ctrl && !key.meta) {
      this.searchQuery += text;
      this.refreshSearch();
    }
  }

  private insertText(text: string): void {
    const chars = Array.from(this.input);
    chars.splice(this.cursorIndex, 0, ...Array.from(text));
    this.input = chars.join("");
    this.cursorIndex += Array.from(text).length;
    this.render();
  }

  private deleteBackward(): void {
    if (this.cursorIndex === 0) return;
    const chars = Array.from(this.input);
    chars.splice(this.cursorIndex - 1, 1);
    this.input = chars.join("");
    this.cursorIndex -= 1;
    this.render();
  }

  private deleteForward(): void {
    const chars = Array.from(this.input);
    if (this.cursorIndex >= chars.length) return;
    chars.splice(this.cursorIndex, 1);
    this.input = chars.join("");
    this.render();
  }

  private navigateHistory(delta: -1 | 1): boolean {
    if (this.inputHistory.length === 0) return false;

    if (this.historyIndex === -1) {
      this.historyDraft = this.input;
      this.historyIndex = this.inputHistory.length;
    }

    const nextIndex = clamp(this.historyIndex + delta, 0, this.inputHistory.length);
    this.historyIndex = nextIndex;
    this.input = nextIndex === this.inputHistory.length
      ? this.historyDraft
      : this.inputHistory[nextIndex];
    this.cursorIndex = Array.from(this.input).length;
    this.render();
    return true;
  }

  private enterSearchMode(initialQuery = ""): void {
    this.searchMode = true;
    this.searchQuery = initialQuery;
    this.refreshSearch();
  }

  private exitSearchMode(): void {
    this.searchMode = false;
    this.searchQuery = "";
    this.searchMatches = [];
    this.searchMatchIndex = 0;
    this.render();
  }

  private refreshSearch(): void {
    const query = this.searchQuery.trim().toLowerCase();
    if (!query) {
      this.searchMatches = [];
      this.searchMatchIndex = 0;
      this.render();
      return;
    }
    this.searchMatches = this.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => `${message.title}\n${message.content}`.toLowerCase().includes(query))
      .map(({ index }) => index);
    this.searchMatchIndex = 0;
    this.jumpToCurrentSearchResult();
    this.render();
  }

  private jumpToCurrentSearchResult(): void {
    if (this.searchMatches.length === 0) return;
    const targetMessageIndex = this.searchMatches[this.searchMatchIndex];
    const lineIndex = this.messageLineIndexForMessage(targetMessageIndex, this.messageBodyWidth());
    this.autoScroll = false;
    this.scrollOffset = clamp(lineIndex, 0, this.maxScrollOffset());
  }

  private async submitInput(): Promise<void> {
    const content = this.input.trimEnd();
    if (!content.trim()) return;

    this.pushMessage("user", "You", content);
    if (this.inputHistory[this.inputHistory.length - 1] !== content) {
      this.inputHistory.push(content);
    }
    this.input = "";
    this.cursorIndex = 0;
    this.historyIndex = -1;
    this.historyDraft = "";
    this.busy = true;
    this.autoScroll = true;
    this.footerHint = "Busy... Wheel/PgUp/PgDn scroll | Ctrl+C exit";
    this.render();

    try {
      if (this.chatHistory[this.chatHistory.length - 1]?.content !== content) {
        this.chatHistory.push({ role: "user", content });
        this.trimChatHistory();
      }
      if (content.startsWith("/")) {
        await this.handleCommand(content);
      } else {
        const decision = await this.coordinateConversation(content);
        if (decision.action === "run_workflow") {
          this.pushMessage("status", "Conversation Coordinator", [
            `decision: run ${decision.goal}`,
            `reason: ${decision.reason}`,
            `input: ${decision.input}`,
          ].join("\n"));
          await this.runWorkflowCommand(decision.goal, decision.input, decision.output ?? `outputs/${decision.goal}`);
        } else if (decision.action === "ask_clarification") {
          this.pendingFilePath = decision.filePath;
          this.pushAssistantMessage("Clarification", decision.message);
        } else if (decision.action === "respond") {
          this.pushAssistantMessage(decision.title, decision.content);
        } else {
          await this.handleChat();
        }
      }
    } catch (error: unknown) {
      this.pushMessage("error", "Error", error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
      this.footerHint = "Enter send | Wheel/PgUp/PgDn scroll | Ctrl+R search | Ctrl+C exit";
      this.render();
    }
  }

  /** Decide whether a user message should chat, ask a follow-up, or start a workflow. */
  private async coordinateConversation(input: string): Promise<ConversationDecision> {
    const pendingChoice = this.resolvePendingFileChoice(input);
    if (pendingChoice) {
      this.pendingFilePath = null;
      return pendingChoice;
    }

    const followUpChoice = this.resolveFollowUpAction(input);
    if (followUpChoice) {
      this.followUpActions.length = 0;
      return followUpChoice;
    }

    const filePath = this.findExistingFilePath(input);
    if (!filePath) return { action: "chat" };

    const llmDecision = await this.decideWorkflowWithLlm(input, filePath);
    if (llmDecision.action === "run_workflow" || llmDecision.action === "ask_clarification") {
      return llmDecision;
    }

    return this.fallbackFileDecision(input, filePath);
  }

  private fallbackFileDecision(input: string, filePath: string): ConversationDecision {
    const explicitGoal = this.detectExplicitWorkflowGoal(input, filePath);
    if (explicitGoal) {
      return {
        action: "run_workflow",
        goal: explicitGoal,
        input: filePath,
        output: `outputs/${explicitGoal}`,
        reason: `explicit ${explicitGoal} intent with local file path`,
      };
    }

    return {
      action: "ask_clarification",
      filePath,
      message: [
        `我检测到本地文件路径：${filePath}`,
        "",
        "你想让我怎么处理它？",
        "1. /analyze 只做需求分析，产出结构化需求和 Markdown 摘要。",
        "2. /design 做完整设计流程，包含需求分析、系统设计、Mermaid 图和测试用例。",
        "",
        "回复 1 或 analyze 运行需求分析；回复 2 或 design 运行完整设计。",
      ].join("\n"),
    };
  }

  private async decideWorkflowWithLlm(input: string, filePath: string): Promise<ConversationDecision> {
    const prompt = [
      "You are the Conversation Coordinator for a terminal software-design assistant.",
      "Decide whether the user wants to chat, needs clarification, or explicitly wants to run a workflow.",
      "Return JSON only, no Markdown.",
      "",
      "Allowed JSON shape:",
      '{"action":"chat"|"ask_clarification"|"run_workflow","goal":"analyze"|"design"|null,"question":string,"reason":string}',
      "",
      "Policy:",
      "- Never run a workflow from a bare file path alone.",
      "- Run analyze only when the user explicitly asks for analysis, extraction, requirements, or structure.",
      "- Run design only when the user explicitly asks for design, architecture, diagrams, drawing, tests, or a full workflow.",
      "- If unclear, ask a concise clarification question.",
      "- The local file exists and is safe to reference.",
      "",
      `Detected file: ${filePath}`,
      `User message: ${input}`,
      "",
      "Recent session memory:",
      this.memoryForPrompt(1200),
    ].join("\n");

    try {
      const raw = await this.llm.chat([
        { role: "system", content: "Return strict JSON only. Do not use emoji or icons." },
        { role: "user", content: prompt },
      ]);
      const parsed = this.parseCoordinatorDecision(raw);
      if (!parsed) return this.fallbackFileDecision(input, filePath);
      if (parsed.action === "run_workflow" && (parsed.goal === "analyze" || parsed.goal === "design")) {
        return {
          action: "run_workflow",
          goal: parsed.goal,
          input: filePath,
          output: `outputs/${parsed.goal}`,
          reason: parsed.reason || "LLM coordinator selected workflow",
        };
      }
      if (parsed.action === "ask_clarification") {
        const fallback = this.fallbackFileDecision(input, filePath);
        const fallbackMessage = fallback.action === "ask_clarification" ? fallback.message : "请选择 analyze 或 design。";
        return {
          action: "ask_clarification",
          filePath,
          message: parsed.question || fallbackMessage,
        };
      }
      return { action: "chat" };
    } catch {
      return this.fallbackFileDecision(input, filePath);
    }
  }

  private parseCoordinatorDecision(raw: string): { action?: string; goal?: string | null; question?: string; reason?: string } | null {
    const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      return {
        action: typeof parsed.action === "string" ? parsed.action : undefined,
        goal: typeof parsed.goal === "string" ? parsed.goal : null,
        question: typeof parsed.question === "string" ? parsed.question : undefined,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      };
    } catch {
      return null;
    }
  }

  private resolvePendingFileChoice(input: string): ConversationDecision | null {
    if (!this.pendingFilePath) return null;
    const normalized = input.trim().toLowerCase();
    const wantsAnalyze = /^(1|a|analyze|分析|需求分析)$/.test(normalized);
    const wantsDesign = /^(2|d|design|设计|画图|生成图|完整设计)$/.test(normalized);
    if (wantsAnalyze) {
      return {
        action: "run_workflow",
        goal: "analyze",
        input: this.pendingFilePath,
        output: "outputs/analyze",
        reason: "user selected analyze for pending file",
      };
    }
    if (wantsDesign) {
      return {
        action: "run_workflow",
        goal: "design",
        input: this.pendingFilePath,
        output: "outputs/design",
        reason: "user selected design for pending file",
      };
    }
    return null;
  }

  private resolveFollowUpAction(input: string): ConversationDecision | null {
    if (this.followUpActions.length === 0) return null;
    const normalized = input.trim().toLowerCase();
    const action = this.followUpActions.find((item) =>
      normalized === item.id ||
      normalized === `action ${item.id}` ||
      normalized === item.label.toLowerCase(),
    );
    return action?.decision ?? null;
  }

  private detectExplicitWorkflowGoal(input: string, filePath: string): "analyze" | "design" | null {
    // Detect intent from explicit keywords only. A bare path should not launch
    // a workflow because the user may want to ask about options first.
    const analyzeKeywords = /分析|analyze|解析|提取|extract|requirement|需求|结构/i;
    const designKeywords = /设计|design|架构|architecture|生成|generate|系统|system/i;

    const lower = input.toLowerCase();
    const intentText = lower.replace(filePath.toLowerCase(), "");

    if (designKeywords.test(intentText)) {
      return "design";
    }
    if (analyzeKeywords.test(intentText)) {
      return "analyze";
    }

    return null;
  }

  private findExistingFilePath(input: string): string | null {
    const pathPatterns = [
      // Quoted paths: "C:\..." or '/path/to/file'
      /["']([^"']+\.(?:md|txt|docx?|pdf|yaml|yml|json))["']/i,
      // Unquoted paths with separators: C:\... or /path/... or ./...
      /(?:(?:[A-Za-z]:[\\/]|\.?[\/\\])\S+\.(?:md|txt|docx?|pdf|yaml|yml|json))/i,
      // Bare filename with extension
      /\b(\w+[\w-]*\.(?:md|txt|yaml|yml|json))\b/i,
    ];

    let filePath: string | null = null;
    for (const pattern of pathPatterns) {
      const match = input.match(pattern);
      if (match) {
        filePath = match[1] ?? match[0];
        // Strip surrounding quotes
        if (filePath.startsWith('"') || filePath.startsWith("'")) {
          filePath = filePath.slice(1, -1);
        }
        break;
      }
    }

    return filePath && existsSync(filePath) ? filePath : null;
  }

  private async handleChat(): Promise<void> {
    this.panel.mode = "chat";
    this.panel.runStatus = "chatting";
    const assistantMessage: UiMessage = { role: "assistant", title: "Assistant", content: "" };
    this.messages.push(assistantMessage);
    this.pinScroll();
    this.render();

    const systemPrompt = [
      "You are ReqDesign-Agent, a multi-agent LLM system for requirements-driven software design, running inside a terminal chat UI.",
      "",
      "## Auto-Detection",
      "When the user provides a file path plus explicit intent keywords (e.g. 分析, 设计, analyze, design), the terminal UI may run the matching workflow command before this chat prompt is used.",
      "A bare file path should not be treated as implicit permission to analyze or design. Ask what the user wants to do, or suggest explicit /analyze and /design commands.",
      "",
      "## Your Role",
      "- Answer questions about software design, architecture, requirements engineering directly.",
      "- When discussing a specific file, do not assume a workflow has already launched unless the transcript shows a workflow event.",
      "- If the user asks about your capabilities, mention /design, /analyze, /benchmark commands.",
      "- Be concise, technical, and action-oriented.",
      "- Respond in the same language the user uses (Chinese -> Chinese, English -> English).",
      "- Do not use emoji, icons, pictographs, decorative symbols, or icon-like bullets in replies. Use plain text and standard Markdown only.",
      "",
      "## Session Memory",
      this.memoryForPrompt(6000),
    ].join("\n");

    const history = this.chatHistory.slice(-18);
    try {
      const response = await this.llm.chat(
        [
          { role: "system", content: systemPrompt },
          ...history,
        ],
        undefined,
        (chunk) => {
          assistantMessage.content += chunk;
          this.pinScroll();
          this.render();
        },
      );

      if (!assistantMessage.content) {
        assistantMessage.content = response;
      }
      this.chatHistory.push({ role: "assistant", content: assistantMessage.content });
      this.trimChatHistory();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      assistantMessage.content = `[Error] ${msg}`;
      this.pushMessage("error", "Chat Error", msg);
    }
    this.panel.runStatus = "idle";
  }

  private async handleCommand(raw: string): Promise<void> {
    const [command, ...args] = raw.trim().split(/\s+/);
    if (command === "/help") {
      this.pushMessage("status", "Commands", [
        "/help",
        "/clear",
        "/search <keyword>",
        "/design <file> [outputDir]",
        "/analyze <file> [outputDir]",
        "/benchmark [casesDir] [outputDir]",
        "/cancel",
        "/quit",
      ].join("\n"));
      return;
    }
    if (command === "/clear") {
      this.messages.length = 0;
      this.chatHistory.length = 0;
      this.sessionMemory.length = 0;
      this.workflowMemories.length = 0;
      this.followUpActions.length = 0;
      this.pendingFilePath = null;
      this.streamMessageIndex.clear();
      this.scrollOffset = 0;
      this.autoScroll = true;
      this.pushMessage("system", "ReqDesign Chat", "会话已清空。");
      return;
    }
    if (command === "/search") {
      const query = args.join(" ").trim();
      this.enterSearchMode(query);
      return;
    }
    if (command === "/quit" || command === "/exit") {
      this.shutdown(0);
      return;
    }
    if (command === "/cancel") {
      this.requestCancelWorkflow("cancelled by /cancel");
      return;
    }
    if (command === "/design" || command === "/analyze") {
      if (args.length < 1) {
        this.pushMessage("error", "Command Error", `${command} 需要文件路径参数。`);
        return;
      }
      const goal = command.slice(1);
      const input = args[0];
      const output = args[1] ?? `outputs/${goal}`;
      await this.runWorkflowCommand(goal, input, output);
      return;
    }
    if (command === "/benchmark") {
      const casesDir = args[0] ?? "benchmark/cases";
      const outputDir = args[1] ?? "benchmark/results";
      await this.runBenchmarkCommand(casesDir, outputDir);
      return;
    }

    this.pushMessage("error", "Command Error", `未知命令: ${command}`);
  }

  private async runWorkflowCommand(goal: string, input: string, output: string): Promise<void> {
    this.resetWorkflowPanel();
    this.panel.mode = "workflow";
    this.panel.goal = goal;
    this.panel.outputDir = output;
    this.panel.runStatus = "running";
    this.cancelRequested = false;
    this.pushMessage("status", "Workflow", `Running ${goal}\nInput: ${input}\nOutput: ${output}`);

    const runtime = new MultiAgentRuntime(this.config, this.executionBackend);
    this.currentRuntime = runtime;
    try {
      await runtime.run(goal, input, output, {
        onEvent: (event) => this.consumeWorkflowEvent(event),
      });
      if (!this.cancelRequested) {
        this.pushWorkflowCompletionGuide(goal, input, output);
      }
    } finally {
      if (this.currentRuntime === runtime) {
        this.currentRuntime = null;
      }
    }
  }

  private pushWorkflowCompletionGuide(goal: string, input: string, output: string): void {
    this.followUpActions.length = 0;
    const lines: string[] = [
      `goal: ${goal}`,
      `input: ${input}`,
      `output: ${output}`,
    ];
    const artifacts: Record<string, string> = {};
    let preview = "";

    if (goal === "analyze") {
      const analysisMd = path.join(output, "requirement", "analysis.md");
      const analysisJson = path.join(output, "requirement", "analysis.json");
      artifacts.analysisMd = analysisMd;
      artifacts.analysisJson = analysisJson;
      lines.push(
        "",
        "artifacts",
        `  markdown: ${analysisMd}`,
        `  json:     ${analysisJson}`,
      );

      if (existsSync(analysisMd)) {
        preview = readFileSync(analysisMd, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .slice(0, 18)
          .join("\n");
        if (preview) {
          lines.push("", "analysis preview", preview);
        }
      }

      this.followUpActions.push(
        {
          id: "1",
          label: "Generate design from this file",
          decision: {
            action: "run_workflow",
            goal: "design",
            input,
            output: "outputs/design",
            reason: "follow-up action after analyze",
          },
        },
        {
          id: "2",
          label: "Explain analysis result",
          decision: {
            action: "respond",
            title: "Analysis Explanation",
            content: preview || `Analysis artifact is available at ${analysisMd}. Ask a specific question if you want a focused review.`,
          },
        },
      );
      lines.push(
        "",
        "next",
        "  1. Generate design from this file",
        "  2. Explain analysis result",
        "  Or ask a follow-up question about the generated analysis.",
      );
    } else if (goal === "design") {
      artifacts.outputDir = output;
      artifacts.systemDesign = path.join(output, "design", "system_design.md");
      artifacts.diagramsDir = path.join(output, "diagrams");
      artifacts.tests = path.join(output, "tests", "test_cases.md");
      const designPreviewPath = artifacts.systemDesign;
      if (existsSync(designPreviewPath)) {
        preview = readFileSync(designPreviewPath, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .slice(0, 18)
          .join("\n");
      }
      this.followUpActions.push({
        id: "1",
        label: "Explain design outputs",
        decision: {
          action: "respond",
          title: "Design Outputs",
          content: preview || `Design outputs are available under ${output}.`,
        },
      });
      lines.push(
        "",
        "artifacts",
        `  output: ${output}`,
        `  diagrams: ${artifacts.diagramsDir}`,
        "",
        "next",
        "  1. Explain design outputs",
        "  Review system design, diagrams, and tests under the output directory.",
        "  Ask a follow-up question if you want a focused explanation or revision.",
      );
    }

    const summary = lines.join("\n");
    this.workflowMemories.push({
      goal,
      input,
      output,
      artifacts,
      preview,
      completedAt: new Date().toISOString(),
    });
    while (this.workflowMemories.length > 6) {
      this.workflowMemories.shift();
    }
    this.rememberSession([
      `Workflow completed: ${goal}`,
      `input: ${input}`,
      `output: ${output}`,
      `artifacts: ${JSON.stringify(artifacts)}`,
      summary,
    ].join("\n"));
    this.pushAssistantMessage("Workflow Summary", summary);
  }

  private async runBenchmarkCommand(casesDir: string, outputDir: string): Promise<void> {
    this.resetWorkflowPanel();
    this.panel.mode = "benchmark";
    this.panel.outputDir = outputDir;
    this.panel.runStatus = "running";
    this.pushMessage("status", "Benchmark", `Cases: ${casesDir}\nOutput: ${outputDir}`);

    const runner = new BenchmarkRunner(this.config, casesDir, "benchmark/gold_labels", outputDir);
    await runner.runAll({
      onEvent: (event) => this.consumeWorkflowEvent(event),
    });
  }

  private consumeWorkflowEvent(event: WorkflowEvent): void {
    this.updatePanelFromEvent(event);

    // --- Streaming LLM chunks: append to the live stream card ---
    if (event.kind === "llm_chunk") {
      this.appendStreamChunk(event);
      return;
    }

    // --- Heartbeat: refresh runtime liveness without adding transcript noise. ---
    if (event.kind === "worker_heartbeat") {
      this.panel.lastHeartbeatAt = Date.now();
      this.panel.llmStatus = this.panel.llmChunkCount > 0 ? "streaming" : "waiting first chunk";
      this.render();
      return;
    }

    // --- Close stream cards when tasks finish ---
    if (event.taskId && (
      event.kind === "task_completed" ||
      event.kind === "task_failed" ||
      event.kind === "repair_task_completed" ||
      event.kind === "repair_task_failed" ||
      event.kind === "worker_result" ||
      event.kind === "worker_timeout"
    )) {
      this.closeStreamMessagesForTask(event.taskId);
    }

    // --- Worker lifecycle: keep this visible so the left pane shows what the agent is doing. ---
    if (event.kind === "worker_started" || event.kind === "worker_resumed") {
      const body = [
        "agent",
        `  phase:   ${compactValue(event.phase ?? "")}`,
        `  task:    ${compactValue(event.taskId ?? "")}`,
        `  type:    ${compactValue(event.taskType ?? "")}`,
        `  session: ${compactValue(event.sessionId ?? "")}`,
        `  status:  ${compactValue(event.status ?? "")}`,
        "",
        "activity",
        "  session submitted, waiting for model/tool output",
      ].join("\n");
      this.pushMessage("status", `Agent ${event.kind === "worker_resumed" ? "resumed" : "started"}`, body, {
        variant: "plain",
        subtitle: this.workflowEventSubtitle(event),
      });
      return;
    }

    // --- Filter out noisy internal events that don't belong in the transcript ---
    const suppressedKinds = new Set([
      "worker_heartbeat",       // already handled above, but double-check
      "artifact_saved",         // save success is expected, not noteworthy
      "input_loaded",           // implementation detail
      "planning_started",       // subsumed by planning_completed
      "evaluation_started",     // subsumed by evaluation_completed
      "persist_started",        // subsumed by persist_completed
      "repair_round_started",   // subsumed by repair_round_completed
      "repair_started",         // subsumed by repair_completed
      "repair_task_started",    // subsumed by repair_task_completed
      "task_started",           // subsumed by llm_started which shows the actual prompt
    ]);
    if (suppressedKinds.has(event.kind)) {
      return;
    }

    // --- LLM started: show prompt context as a card ---
    if (event.kind === "llm_started") {
      const data = event.data ?? {};
      const tag = String(event.tag ?? "").replace(/^\[|\]$/g, "");
      const promptChars = data.promptChars ?? 0;
      const messageRoles = (data.messageRoles as string[]) ?? [];
      const preview = sanitizeTerminalText(String(data.promptPreview ?? ""));

      const providerModel = `${String(data.provider ?? "-")}:${String(data.model ?? "-")}`;
      this.panel.activeLlmStartedAt = Date.now();
      this.panel.lastLlmChunkAt = 0;
      this.panel.llmChunkCount = 0;
      this.panel.llmStatus = "request sent, waiting first chunk";
      this.panel.activeSessionId = event.sessionId ?? this.panel.activeSessionId;
      this.ensureActivityRefreshTimer();

      // Keep enough prompt text to make the model request understandable
      // without letting one prompt take over the whole viewport.
      const maxPreviewLines = 10;
      const maxPreviewChars = 900;
      const previewLines: string[] = [];
      let previewUsed = 0;
      for (const rawLine of preview.split("\n")) {
        if (previewUsed >= maxPreviewChars || previewLines.length >= maxPreviewLines) break;
        const remaining = maxPreviewChars - previewUsed;
        const truncated = rawLine.length > remaining ? rawLine.slice(0, remaining) + "..." : rawLine;
        previewLines.push(truncated);
        previewUsed += truncated.length;
      }
      const hasMore = preview.length > maxPreviewChars || preview.split("\n").length > maxPreviewLines;

      const body = [
        "request",
        `  model:   ${providerModel}`,
        `  agent:   ${compactValue(event.phase ?? "")}`,
        `  task:    ${compactValue(event.taskId ?? "")}`,
        `  type:    ${compactValue(event.taskType ?? "")}`,
        `  roles:   ${String(messageRoles.join(" -> ")) || "-"}`,
        `  prompt:  ~${estimateTokens(preview)} tok preview / ${String(promptChars)} chars total`,
        "",
        "asking",
        ...(previewLines.length > 0 ? previewLines.map((line) => `  ${line}`) : ["  -"]),
        ...(hasMore ? [`  ... ${String(promptChars)} chars total`] : []),
      ].join("\n");

      const msg: UiMessage = {
        role: "status",
        title: `LLM request${tag ? ` ${tag}` : ""}`,
        content: body,
        variant: "plain",
        subtitle: this.workflowEventSubtitle(event),
      };
      this.messages.push(msg);
      this.pinScroll();
      this.render();
      return;
    }

    if (event.kind === "llm_completed") {
      const data = event.data ?? {};
      const providerModel = `${String(data.provider ?? "-")}:${String(data.model ?? "-")}`;
      const promptTokens = Number(data.promptTokens ?? 0);
      const completionTokens = Number(data.completionTokens ?? 0);
      const totalTokens = Number(data.totalTokens ?? 0);
      const body = [
        `model:      ${providerModel}`,
        `response:   ${String(data.responseChars ?? 0)} chars`,
        `tokens:     ${totalTokens > 0 ? `${promptTokens} prompt + ${completionTokens} completion = ${totalTokens}` : "not reported by provider"}`,
        `status:     ${compactValue(event.status ?? "")}`,
      ].join("\n");
      this.panel.llmStatus = event.status === "error" ? "failed" : "completed";
      this.stopActivityRefreshTimer();
      this.pushMessage(event.status === "error" ? "error" : "status", "LLM completed", body, {
        variant: "event",
        subtitle: this.workflowEventSubtitle(event),
      });
      return;
    }

    // --- Determine role and whether it's a milestone ---
    const role: UiRole = event.status === "failed" || event.status === "error" || event.kind.endsWith("_failed")
      ? "error"
      : "status";

    const milestoneKinds = new Set([
      "run_started",
      "run_completed",
      "run_failed",
      "planning_completed",
      "evaluation_completed",
      "persist_completed",
      "persist_skipped",
      "benchmark_started",
      "benchmark_completed",
      "benchmark_case_completed",
      "trace_exported",
      "runtime_budget_exhausted",
    ]);
    const isMilestone = milestoneKinds.has(event.kind);

    this.pushMessage(role, this.workflowEventTitle(event), event.message, {
      variant: isMilestone ? "plain" : "event",
      subtitle: this.workflowEventSubtitle(event),
    });
  }

  private updatePanelFromEvent(event: WorkflowEvent): void {
    if (event.scope === "benchmark") {
      this.panel.mode = "benchmark";
    } else if (event.scope === "runtime" || event.scope === "llm") {
      this.panel.mode = "workflow";
    }

    if (event.goal) this.panel.goal = event.goal;
    if (event.caseName) this.panel.currentCase = event.caseName;
    if (event.taskId) this.panel.currentTaskId = event.taskId;
    if (event.taskType) this.panel.currentTaskType = event.taskType;
    if (event.tag) this.panel.lastStreamTag = event.tag;
    if (event.phase) this.panel.currentAgent = event.phase;
    if (event.status) this.panel.runStatus = event.status;

    const data = event.data ?? {};
    this.panel.goal = String(data.goal ?? this.panel.goal);
    this.panel.outputDir = String(data.outputDir ?? this.panel.outputDir);
    this.panel.runStatus = String(data.runStatus ?? this.panel.runStatus);
    this.panel.qualityStatus = String(data.qualityStatus ?? this.panel.qualityStatus);
    this.panel.persistStatus = String(data.persistStatus ?? this.panel.persistStatus);
    this.panel.totalArtifacts = Number(data.totalArtifacts ?? this.panel.totalArtifacts);
    this.panel.plannedTasks = Number(data.plannedTasks ?? this.panel.plannedTasks);
    this.panel.completedTasks = Number(data.completedTasks ?? this.panel.completedTasks);
    this.panel.runningTasks = Number(data.runningTasks ?? this.panel.runningTasks);
    this.panel.pendingTasks = Number(data.pendingTasks ?? this.panel.pendingTasks);
    this.panel.blockedTasks = Number(data.blockedTasks ?? this.panel.blockedTasks);
    this.panel.failedTasks = Number(data.failedTasks ?? this.panel.failedTasks);
    this.panel.readyTasks = Number(data.readyTasks ?? this.panel.readyTasks);

    if (event.kind === "llm_started") {
      const provider = String(data.provider ?? "");
      const model = String(data.model ?? "");
      this.panel.currentModel = provider || model ? `${provider || "-"}:${model || "-"}` : this.panel.currentModel;
      this.panel.currentPromptPreview = String(data.promptPreview ?? this.panel.currentPromptPreview);
      this.panel.activeSessionId = event.sessionId ?? this.panel.activeSessionId;
    }
    if (event.kind === "llm_completed") {
      this.panel.promptTokens = Number(data.promptTokens ?? this.panel.promptTokens);
      this.panel.completionTokens = Number(data.completionTokens ?? this.panel.completionTokens);
      this.panel.totalTokens = Number(data.totalTokens ?? this.panel.totalTokens);
    }

    if (event.kind === "benchmark_started") {
      this.panel.benchmarkTotal = Number(data.totalCases ?? this.panel.benchmarkTotal);
      this.panel.benchmarkDone = 0;
      this.panel.benchmarkPassed = 0;
      this.panel.benchmarkFailed = 0;
      this.panel.benchmarkError = 0;
    }
    if (event.kind === "benchmark_case_completed") {
      this.panel.benchmarkDone += 1;
      if (event.status === "completed") {
        this.panel.benchmarkPassed += 1;
      } else if (event.status === "error") {
        this.panel.benchmarkError += 1;
      } else {
        this.panel.benchmarkFailed += 1;
      }
    }

    const recent = `${event.scope}/${event.kind}${event.taskId ? ` ${event.taskId}` : ""}${event.caseName ? ` ${event.caseName}` : ""}`;
    this.panel.recentEvents = [...this.panel.recentEvents.slice(-7), recent];
    this.render();
  }

  private appendStreamChunk(event: WorkflowEvent): void {
    this.panel.lastLlmChunkAt = Date.now();
    this.panel.llmChunkCount += 1;
    this.panel.llmStatus = "streaming";
    const streamKey = [
      event.caseName ?? "",
      event.taskId ?? "no-task",
      event.tag ?? "llm",
    ].join(":");

    let index = this.streamMessageIndex.get(streamKey);
    if (index === undefined) {
      index = this.messages.length;
      this.messages.push({
        role: "assistant",
        title: this.streamTitle(event),
        content: "",
        variant: "stream",
        subtitle: this.streamSubtitle(event),
        active: true,
        collapsed: false,
      });
      this.streamMessageIndex.set(streamKey, index);
    } else {
      this.messages[index].subtitle = this.streamSubtitle(event);
      this.messages[index].active = true;
      this.messages[index].collapsed = false;
    }

    this.messages[index].content += event.chunk ?? event.message;
    this.pinScroll();
    this.render();
  }

  private closeStreamMessagesForTask(taskId: string): void {
    for (const key of [...this.streamMessageIndex.keys()]) {
      if (key.includes(`:${taskId}:`)) {
        const messageIndex = this.streamMessageIndex.get(key);
        if (messageIndex !== undefined) {
          this.messages[messageIndex].active = false;
          this.messages[messageIndex].collapsed = true;
        }
        this.streamMessageIndex.delete(key);
      }
    }
  }

  private workflowEventTitle(event: WorkflowEvent): string {
    return `${event.scope === "benchmark" ? "Benchmark" : "Workflow"} ${event.kind.replace(/_/g, " ")}`;
  }

  private workflowEventSubtitle(event: WorkflowEvent): string {
    const parts: string[] = [];
    if (event.phase) parts.push(event.phase);
    if (event.taskId) parts.push(event.taskId);
    if (event.taskType) parts.push(event.taskType);
    if (event.caseName) parts.push(event.caseName);
    if (event.status) parts.push(event.status);
    return parts.join(" | ");
  }

  private streamTitle(event: WorkflowEvent): string {
    const tag = (event.tag ?? "stream").replace(/^\[|\]$/g, "");
    return tag || "stream";
  }

  private streamSubtitle(event: WorkflowEvent): string {
    const parts: string[] = [];
    if (event.phase) parts.push(event.phase);
    if (event.taskId) parts.push(event.taskId);
    if (event.taskType) parts.push(event.taskType);
    return parts.join(" | ");
  }

  private pushMessage(
    role: UiRole,
    title: string,
    content: string,
    extras: Partial<Omit<UiMessage, "role" | "title" | "content">> = {},
  ): void {
    this.messages.push({ role, title, content, variant: "plain", ...extras });
    this.pinScroll();
    this.render();
  }

  private pushAssistantMessage(title: string, content: string): void {
    this.pushMessage("assistant", title, content);
    this.chatHistory.push({ role: "assistant", content: `${title}\n${content}` });
    this.trimChatHistory();
  }

  private rememberSession(content: string): void {
    this.sessionMemory.push(truncateToWidth(content, 4000));
    while (this.sessionMemory.length > 8) {
      this.sessionMemory.shift();
    }
  }

  private memoryForPrompt(maxChars: number): string {
    const structured = this.workflowMemories.slice(-4).map((memory) => {
      return [
        `Workflow: ${memory.goal}`,
        `completedAt: ${memory.completedAt}`,
        `input: ${memory.input}`,
        `output: ${memory.output}`,
        `artifacts: ${JSON.stringify(memory.artifacts)}`,
        memory.preview ? `preview:\n${memory.preview}` : "",
      ].filter(Boolean).join("\n");
    });
    const text = [...structured, ...this.sessionMemory.slice(-4)].filter(Boolean).join("\n\n---\n\n");
    return text ? truncateToWidth(text, maxChars) : "No workflow artifacts have been completed in this TUI session yet.";
  }

  private trimChatHistory(): void {
    const maxMessages = 24;
    if (this.chatHistory.length <= maxMessages) return;
    this.chatHistory.splice(0, this.chatHistory.length - maxMessages);
  }

  private requestCancelWorkflow(reason: string): void {
    if (!this.currentRuntime) {
      this.pushMessage("status", "Cancel", "No active workflow is running.");
      return;
    }
    if (this.cancelRequested) {
      this.pushMessage("status", "Cancel", "Cancellation is already requested. Waiting for the active model call to return.");
      return;
    }
    this.cancelRequested = true;
    this.panel.runStatus = "cancelling";
    this.panel.llmStatus = "cancelling";
    this.currentRuntime.cancel(reason);
    this.pushMessage("status", "Cancel Requested", [
      reason,
      "The active LLM call may not stop immediately if the provider does not support aborting in-flight requests.",
    ].join("\n"));
  }

  private ensureActivityRefreshTimer(): void {
    if (this.activityRefreshTimer) return;
    this.activityRefreshTimer = setInterval(() => {
      if (!this.busy && this.panel.llmStatus !== "request sent, waiting first chunk") {
        this.stopActivityRefreshTimer();
        return;
      }
      this.render();
    }, 1000);
  }

  private stopActivityRefreshTimer(): void {
    if (!this.activityRefreshTimer) return;
    clearInterval(this.activityRefreshTimer);
    this.activityRefreshTimer = null;
  }

  private shutdown(exitCode?: number): void {
    if (this.exiting) return;
    this.exiting = true;
    while (this.cleanupHandlers.length > 0) {
      const cleanup = this.cleanupHandlers.pop();
      cleanup?.();
    }
    if (exitCode !== undefined) {
      setImmediate(() => {
        process.exit(exitCode);
      });
    }
  }

  private resetWorkflowPanel(): void {
    const next = defaultPanelState();
    Object.assign(this.panel, next);
  }

  private pinScroll(): void {
    this.clearPendingScroll();
    if (this.autoScroll) {
      this.scrollOffset = this.maxScrollOffset();
    }
  }

  private scrollTranscriptBy(delta: number): void {
    this.clearPendingScroll();
    this.applyTranscriptScroll(delta, true);
  }

  private applyTranscriptScroll(delta: number, renderAfter: boolean): number {
    const max = this.maxScrollOffset();
    if (max <= 0) {
      this.scrollOffset = 0;
      this.autoScroll = true;
      if (renderAfter) this.render();
      return 0;
    }

    const before = this.scrollOffset;
    if (delta < 0) {
      this.autoScroll = false;
    }

    this.scrollOffset = clamp(this.scrollOffset + delta, 0, max);
    if (this.scrollOffset >= max) {
      this.autoScroll = true;
    }
    if (renderAfter) this.render();
    return this.scrollOffset - before;
  }

  private scrollTranscriptByPage(direction: -1 | 1): void {
    const amount = Math.max(3, Math.floor(this.messageViewportHeight() / 2));
    this.scrollTranscriptBy(direction * amount);
  }

  private queueWheelScroll(direction: -1 | 1): void {
    const step = computeWheelStep(this.wheelAccel, direction, Date.now());
    if (step <= 0) return;
    this.pendingScrollDelta += direction * step;
    this.panel.pendingScrollDelta = this.pendingScrollDelta;
    this.scheduleScrollDrain();
  }

  private scheduleScrollDrain(): void {
    if (this.scrollDrainTimer) return;
    this.scrollDrainTimer = setTimeout(() => {
      this.scrollDrainTimer = null;
      this.drainPendingScroll();
    }, 16);
  }

  private drainPendingScroll(): void {
    if (this.pendingScrollDelta === 0) {
      this.panel.pendingScrollDelta = 0;
      return;
    }

    const pending = this.pendingScrollDelta;
    const magnitude = Math.max(1, Math.ceil(Math.abs(pending) * 0.35));
    const chunk = Math.sign(pending) * Math.min(Math.abs(pending), magnitude);
    const applied = this.applyTranscriptScroll(chunk, true);
    if (applied === 0) {
      this.clearPendingScroll();
      return;
    }

    this.pendingScrollDelta -= applied;
    this.panel.pendingScrollDelta = this.pendingScrollDelta;
    if (this.pendingScrollDelta !== 0) {
      this.scheduleScrollDrain();
    }
  }

  private clearPendingScroll(): void {
    this.pendingScrollDelta = 0;
    this.panel.pendingScrollDelta = 0;
    if (this.scrollDrainTimer) {
      clearTimeout(this.scrollDrainTimer);
      this.scrollDrainTimer = null;
    }
  }

  private maxScrollOffset(): number {
    const totalLines = this.buildTranscriptLayout(this.messageBodyWidth()).lines.length;
    return Math.max(0, totalLines - this.messageViewportHeight());
  }

  private messageBodyWidth(): number {
    const width = process.stdout.columns ?? 120;
    const body = this.bodyWidths(width);
    return body.messageInner;
  }

  private bodyWidths(width: number): { messageInner: number; statusInner: number } {
    const contentWidth = Math.max(70, width - 8);
    const messageInner = clamp(Math.floor(contentWidth * 0.72), 48, Math.max(48, contentWidth - 28));
    const statusInner = Math.max(24, contentWidth - messageInner - 1);
    return { messageInner, statusInner };
  }

  private renderCardBodyLines(text: string, bodyWidth: number, frameColor: string): string[] {
    const safeText = sanitizeTerminalText(text);
    const lines: string[] = [];
    for (const logicalLine of safeText.split("\n")) {
      const wrapped = wrapLineAnsiAware(logicalLine, bodyWidth);
      for (const segment of wrapped) {
        lines.push(`${frameColor}\u2502 ${ANSI.reset}${fitToWidth(segment, bodyWidth)} ${frameColor}\u2502${ANSI.reset}`);
      }
    }
    return lines.length > 0
      ? lines
      : [`${frameColor}\u2502 ${ANSI.reset}${padToWidth("", bodyWidth)} ${frameColor}\u2502${ANSI.reset}`];
  }

  private renderTimelineEvent(message: UiMessage, width: number): string[] {
    const timelineWidth = Math.max(20, width);
    const markerColor = message.role === "error" ? COLORS.error : COLORS.status;
    const isLlmEvent = message.title.toLowerCase().includes("llm");
    const labelColor = isLlmEvent ? COLORS.accent : markerColor;
    const prefixText = `${labelColor}${isLlmEvent ? "LLM" : ">"}${ANSI.reset} `;
    const titleWidth = Math.max(1, timelineWidth - stringWidth(prefixText));
    const title = truncateToWidth(stripAnsi(sanitizeTerminalText(`${message.title}${message.subtitle ? ` | ${message.subtitle}` : ""}`)), titleWidth);
    const result = [
      `${prefixText}${COLORS.header}${padToWidth(title, titleWidth)}${ANSI.reset}`,
    ];
    const content = message.content.trim();
    if (content) {
      const contentLines = wrapLine(content.replace(/\s+/g, " "), titleWidth);
      for (const line of contentLines.slice(0, isLlmEvent ? 3 : 1)) {
        result.push(`  ${COLORS.placeholder}${padToWidth(line, Math.max(1, titleWidth - 2))}${ANSI.reset}`);
      }
    }
    return result.map((line) => fitToWidth(line, timelineWidth));
  }

  private renderMessageCard(message: UiMessage, width: number): string[] {
    if (message.variant === "event") {
      return this.renderTimelineEvent(message, width);
    }

    const cardWidth = Math.max(20, width);
    const bodyWidth = Math.max(8, cardWidth - 4);
    const frameColor = message.variant === "stream"
      ? COLORS.accent
      : message.role === "error"
        ? COLORS.error
        : message.role === "status"
          ? COLORS.status
          : COLORS.border;
    const category = message.variant === "stream"
      ? message.active ? "STREAM LIVE" : "STREAM DONE"
      : message.role === "status"
        ? "WORKFLOW"
        : message.role === "user"
          ? "USER"
          : message.role === "assistant"
            ? "CHAT"
            : "SYSTEM";
    const titlePrefix = `${category} `;
    const titleText = truncateToWidth(stripAnsi(sanitizeTerminalText(`${titlePrefix}${message.title}`)), Math.max(1, bodyWidth - 1));
    const subtitleLine = message.subtitle
      ? `${ANSI.dim}${COLORS.placeholder}${message.subtitle}${ANSI.reset}`
      : "";
    const streamStatusLine = message.variant === "stream"
      ? `${COLORS.placeholder}${streamStats(message.content)}${message.active ? " | receiving" : " | complete"}${ANSI.reset}`
      : "";
    const displayContent = message.variant === "stream" && message.collapsed
      ? compactStreamPreview(message.content)
      : message.variant === "stream" && message.active
        ? activeStreamTail(message.content)
        : message.content;
    const renderedContent = message.role === "user" || message.role === "status" || (message.variant === "stream" && message.active)
      ? displayContent
      : renderMarkdown(displayContent);

    const topInnerWidth = Math.max(0, cardWidth - 2);
    const titleLabelWidth = stringWidth(` ${titleText} `);
    const titleFill = repeat("─", Math.max(0, topInnerWidth - titleLabelWidth));
    const lines: string[] = [
      `${frameColor}╭ ${ANSI.bold}${roleColor(message.role)}${titleText}${ANSI.reset}${frameColor} ${titleFill}╮${ANSI.reset}`,
    ];

    if (subtitleLine) {
      lines.push(...this.renderCardBodyLines(subtitleLine, bodyWidth, frameColor));
    }
    if (streamStatusLine) {
      lines.push(...this.renderCardBodyLines(streamStatusLine, bodyWidth, frameColor));
    }

    lines.push(...this.renderCardBodyLines(renderedContent || "", bodyWidth, frameColor));
    lines.push(`${frameColor}╰${repeat("─", Math.max(0, cardWidth - 2))}╯${ANSI.reset}`);
    return lines;
  }

  private buildTranscriptLayout(width: number): TranscriptLayout {
    const transcriptWidth = Math.max(20, width);
    const lines: string[] = [];
    const messageStarts: number[] = [];
    for (const message of this.messages) {
      messageStarts.push(lines.length);
      lines.push(...this.renderMessageCard(message, transcriptWidth));
      lines.push(padToWidth("", transcriptWidth));
    }
    return {
      lines: lines.length > 0 ? lines : [padToWidth("", transcriptWidth)],
      messageStarts,
    };
  }

  private messageLineIndexForMessage(messageIndex: number, width: number): number {
    return this.buildTranscriptLayout(width).messageStarts[messageIndex] ?? 0;
  }

  private render(): void {
    if (this.exiting) return;
    const width = process.stdout.columns ?? 120;
    const height = process.stdout.rows ?? 32;
    const headerLines = this.renderHeader(width);
    const composer = this.renderComposer(width);
    const bodyHeight = Math.max(8, height - headerLines.length - composer.lines.length - 2);
    const widths = this.bodyWidths(width);
    const layout = this.buildTranscriptLayout(widths.messageInner);
    const bodyTop = this.renderBodyBorder(widths.messageInner, widths.statusInner, "Transcript", "Inspector");
    const bodyBottom = this.renderBodyBorder(widths.messageInner, widths.statusInner);
    this.scrollOffset = clamp(this.scrollOffset, 0, Math.max(0, layout.lines.length - bodyHeight));
    const visibleTranscript = layout.lines.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
    const statusLines = this.renderStatusPane(widths.statusInner, bodyHeight);

    const output: string[] = [];
    output.push(ANSI.home);
    output.push(...headerLines);
    output.push(bodyTop);
    for (let index = 0; index < bodyHeight; index++) {
      const leftRaw = visibleTranscript[index] ?? "";
      const rightRaw = statusLines[index] ?? "";
      const left = fitToWidth(leftRaw, widths.messageInner);
      const right = fitToWidth(rightRaw, widths.statusInner);
      output.push(`${COLORS.border}│ ${ANSI.reset}${left}${COLORS.border} │ ${ANSI.reset}${right}${COLORS.border} │${ANSI.reset}`);
    }
    output.push(bodyBottom);
    output.push(...composer.lines);

    process.stdout.write(ANSI.hideCursor + ANSI.clear + output.join("\n"));
    const cursorRow = headerLines.length + bodyHeight + 3 + composer.cursorRow;
    process.stdout.write(`\u001b[${cursorRow};${composer.cursorCol}H${ANSI.showCursor}`);
  }

  private renderHeader(width: number): string[] {
    const appName = `${COLORS.accent}${ANSI.bold}ReqDesign${ANSI.reset}`;
    const modelInfo = `${COLORS.header}${this.config.llm.provider}:${this.config.llm.model}${ANSI.reset}`;
    const state = this.searchMode
      ? `${COLORS.status}search${ANSI.reset}`
      : this.busy
        ? `${COLORS.warning}streaming${ANSI.reset}`
        : `${COLORS.placeholder}idle${ANSI.reset}`;
    const hints = `${COLORS.placeholder}${this.footerHint}${ANSI.reset}`;
    const left = `${appName} ${COLORS.muted}|${ANSI.reset} ${modelInfo}`;
    const right = `${COLORS.muted}state:${ANSI.reset} ${state}`;
    const spacer = repeat(" ", Math.max(1, width - stringWidth(left) - stringWidth(right)));
    return [
      `${left}${spacer}${right}`,
      `${COLORS.borderStrong}${repeat("─", width)}${ANSI.reset}`,
      `${hints}${repeat(" ", Math.max(0, width - stringWidth(hints)))}`,
    ];
  }

  private renderBodyBorder(messageInner: number, statusInner: number, leftTitle = "", rightTitle = ""): string {
    if (leftTitle || rightTitle) {
      const leftLine = lineWithLabel(messageInner, leftTitle);
      const rightLine = lineWithLabel(statusInner, rightTitle);
      return `${COLORS.border}╭─${leftLine}─┬─${rightLine}─╮${ANSI.reset}`;
    }
    return `${COLORS.border}╰─${repeat("─", messageInner)}─┴─${repeat("─", statusInner)}─╯${ANSI.reset}`;
  }

  private renderStatusPane(width: number, height: number): string[] {
    const lines: string[] = [];
    const pushWrapped = (text: string, color = COLORS.placeholder) => {
      for (const line of wrapText(text, width)) {
        lines.push(color + padToWidth(line, width) + ANSI.reset);
      }
    };

    const pushBlank = () => lines.push(padToWidth("", width));
    const pushSection = (title: string) => {
      const text = `${COLORS.accentSoft}${title}${ANSI.reset} ${COLORS.muted}${repeat("─", Math.max(0, width - stringWidth(title) - 1))}${ANSI.reset}`;
      lines.push(padToWidth(text, width));
    };
    const pushKV = (label: string, value: string | number, color = COLORS.placeholder) => {
      const labelText = `${label}:`;
      const available = Math.max(1, width - stringWidth(labelText) - 1);
      const valueText = truncateToWidth(String(value), available);
      lines.push(`${COLORS.muted}${labelText}${ANSI.reset} ${color}${padToWidth(valueText, available)}${ANSI.reset}`);
    };
    const pushMeter = (label: string, done: number, total: number) => {
      const meterWidth = Math.max(6, Math.min(14, width - stringWidth(label) - 8));
      const ratio = total > 0 ? clamp(done / total, 0, 1) : 0;
      const filled = Math.round(meterWidth * ratio);
      const bar = `${COLORS.status}${repeat("=", filled)}${COLORS.border}${repeat("-", meterWidth - filled)}${ANSI.reset}`;
      const text = `${COLORS.muted}${label}:${ANSI.reset} ${bar} ${COLORS.placeholder}${done}/${total}${ANSI.reset}`;
      lines.push(padToWidth(text, width));
    };

    pushSection("Session");
    pushKV("mode", this.panel.mode, COLORS.header);
    pushKV("run", this.panel.runStatus, statusColor(this.panel.runStatus));
    pushKV("goal", compactValue(this.panel.goal));
    pushKV("output", compactValue(this.panel.outputDir));
    pushBlank();

    pushSection("Task");
    pushKV("case", compactValue(this.panel.currentCase));
    pushKV("id", compactValue(this.panel.currentTaskId));
    pushKV("type", compactValue(this.panel.currentTaskType));
    pushKV("quality", this.panel.qualityStatus, statusColor(this.panel.qualityStatus));
    pushKV("persist", this.panel.persistStatus, statusColor(this.panel.persistStatus));
    pushKV("artifacts", this.panel.totalArtifacts, COLORS.header);
    pushBlank();

    pushSection("Progress");
    pushMeter("tasks", this.panel.completedTasks, this.panel.plannedTasks);
    pushKV("running", this.panel.runningTasks, COLORS.warning);
    pushKV("pending", this.panel.pendingTasks);
    pushKV("blocked", this.panel.blockedTasks, this.panel.blockedTasks > 0 ? COLORS.error : COLORS.placeholder);
    pushKV("failed", this.panel.failedTasks, this.panel.failedTasks > 0 ? COLORS.error : COLORS.placeholder);
    pushKV("ready", this.panel.readyTasks, COLORS.status);
    if (this.panel.mode === "benchmark") {
      pushBlank();
      pushSection("Benchmark");
      pushMeter("cases", this.panel.benchmarkDone, this.panel.benchmarkTotal);
      pushKV("pass", this.panel.benchmarkPassed, COLORS.status);
      pushKV("fail", this.panel.benchmarkFailed, this.panel.benchmarkFailed > 0 ? COLORS.error : COLORS.placeholder);
      pushKV("error", this.panel.benchmarkError, this.panel.benchmarkError > 0 ? COLORS.error : COLORS.placeholder);
    }
    pushBlank();

    pushSection("Viewport");
    pushKV("follow", this.autoScroll ? "tail" : "manual", this.autoScroll ? COLORS.status : COLORS.warning);
    pushKV("scroll", `${this.scrollOffset}/${this.maxScrollOffset()}`);
    pushKV("wheel", this.panel.mouseWheelEvents, this.panel.mouseWheelEvents > 0 ? COLORS.status : COLORS.placeholder);
    pushKV("pending", this.panel.pendingScrollDelta);
    pushKV("last key", compactValue(this.panel.lastParsedKey));
    if (this.panel.lastMouseSequence || this.panel.lastRawChunk) {
      pushKV("mouse", compactValue(this.panel.lastMouseSequence));
      pushKV("raw", compactValue(this.panel.lastRawChunk));
    }
    pushBlank();

    pushSection("Stream");
    pushKV("state", this.panel.llmStatus, this.panel.llmStatus.includes("waiting") ? COLORS.warning : statusColor(this.panel.llmStatus));
    pushKV("elapsed", elapsedSeconds(this.panel.activeLlmStartedAt));
    pushKV("chunks", this.panel.llmChunkCount, this.panel.llmChunkCount > 0 ? COLORS.status : COLORS.warning);
    pushKV("last hb", elapsedSeconds(this.panel.lastHeartbeatAt));
    pushKV("tag", compactValue(this.panel.lastStreamTag));
    pushKV("agent", compactValue(this.panel.currentAgent), COLORS.header);
    pushKV("model", compactValue(this.panel.currentModel), COLORS.header);
    pushKV("session", compactValue(this.panel.activeSessionId));
    pushKV("tokens", this.panel.totalTokens > 0
      ? `${this.panel.promptTokens}+${this.panel.completionTokens}=${this.panel.totalTokens}`
      : "waiting usage");
    if (this.panel.currentPromptPreview) {
      pushWrapped(`asking: ${truncateToWidth(this.panel.currentPromptPreview.replace(/\s+/g, " "), Math.max(10, width - 8))}`, COLORS.placeholder);
    }
    if (this.searchMode || this.searchQuery) {
      pushKV("search", compactValue(this.searchQuery), COLORS.status);
      pushKV("hits", `${this.searchMatches.length}${this.searchMatches.length > 0 ? ` (${this.searchMatchIndex + 1}/${this.searchMatches.length})` : ""}`, COLORS.status);
    }
    pushBlank();

    pushSection("Recent");
    for (const event of this.panel.recentEvents.slice(-6)) {
      pushWrapped(`- ${event}`, COLORS.placeholder);
    }
    pushBlank();

    pushSection("Keys");
    pushWrapped("Wheel / PgUp PgDn   scroll", COLORS.placeholder);
    pushWrapped("Ctrl+R search       Ctrl+J newline", COLORS.placeholder);

    return lines.slice(0, height);
  }

  private renderComposer(width: number): {
    lines: string[];
    cursorRow: number;
    cursorCol: number;
  } {
    const contentWidth = Math.max(70, width - 8);
    const innerWidth = Math.max(16, contentWidth);
    const label = this.searchMode ? `${COLORS.status}Search${COLORS.border}` : `${COLORS.accentSoft}Compose${COLORS.border}`;
    const activeValue = this.searchMode ? this.searchQuery : this.input;
    const inputTokens = estimateTokens(this.input);
    const contextTokens = estimateTokens([
      ...this.sessionMemory.slice(-6),
      ...this.chatHistory.slice(-18).map((message) => message.content),
    ].join("\n")) + inputTokens;
    const tokenMeta = this.searchMode
      ? `${COLORS.placeholder}${Array.from(this.searchQuery).length} chars${COLORS.border}`
      : `${COLORS.placeholder}input ~${inputTokens} tok | ctx ~${contextTokens}/${this.config.llm.maxTokens}${COLORS.border}`;
    const labelText = ` ${label} `;
    const metaText = ` ${tokenMeta} `;
    const titleGap = repeat("─", Math.max(0, innerWidth - stringWidth(labelText) - stringWidth(metaText)));
    const top = `${COLORS.border}╭─${labelText}${titleGap}${metaText}─╮${ANSI.reset}`;
    const bottom = `${COLORS.border}╰─${repeat("─", innerWidth)}─╯${ANSI.reset}`;
    const placeholder = this.searchMode
      ? " Type to search transcript, Enter next match, Esc exit"
      : " Type a message or /help";
    const activeCursorIndex = this.searchMode ? Array.from(this.searchQuery).length : this.cursorIndex;
    const composerLines: string[] = [];
    let cursorRow = 1;
    let cursorCol = 3;

    if (activeValue.length === 0) {
      const hintText = wrapLine(placeholder, Math.max(1, innerWidth - 1))[0] ?? "";
      const hint = `${COLORS.placeholder}${hintText}${ANSI.reset}`;
      const padded = repeat(" ", Math.max(0, innerWidth - stringWidth(hintText)));
      composerLines.push(`${COLORS.border}│ ${ANSI.reset}${hint}${padded}${COLORS.border} │${ANSI.reset}`);
    } else {
      const layout = layoutInputLines(activeValue, innerWidth, activeCursorIndex);
      const windowStart = clamp(layout.cursorLine - 5, 0, Math.max(0, layout.lines.length - 6));
      const visibleLines = layout.lines.slice(windowStart, windowStart + 6);
      cursorRow = 1 + clamp(layout.cursorLine - windowStart, 0, Math.max(0, visibleLines.length - 1));
      cursorCol = 3 + clamp(layout.cursorCol, 0, innerWidth);

      for (let index = 0; index < visibleLines.length; index++) {
        const line = visibleLines[index] ?? "";
        composerLines.push(
          `${COLORS.border}│ ${ANSI.reset}${COLORS.input}${line}${ANSI.reset}${repeat(" ", Math.max(0, innerWidth - stringWidth(line)))}${COLORS.border} │${ANSI.reset}`,
        );
      }
    }

    return {
      lines: [top, ...composerLines, bottom],
      cursorRow,
      cursorCol,
    };
  }

  private messageViewportHeight(): number {
    const height = process.stdout.rows ?? 32;
    const headerLines = this.renderHeader(process.stdout.columns ?? 120).length;
    const composerLines = this.renderComposer(process.stdout.columns ?? 120).lines.length;
    return Math.max(8, height - headerLines - composerLines - 2);
  }
}
