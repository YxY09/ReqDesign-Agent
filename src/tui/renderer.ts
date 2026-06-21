/**
 * Terminal renderer: full-screen ANSI drawing + scroll + render throttling.
 *
 * Throttling (bug #4): high-frequency updates (streaming tokens, workflow
 * events) call {@link Renderer.requestRender}, which coalesces into ~30fps
 * (~33ms) batched redraws via a `dirty` flag + timer. User-driven paths
 * (keypress, scroll, submit, resize) call {@link Renderer.renderNow} for an
 * immediate redraw to avoid input latency.
 *
 * @module
 */

import process from "node:process";
import {
  ANSI,
  COLORS,
  activeStreamTail,
  charWidth,
  clamp,
  compactStreamPreview,
  compactValue,
  elapsedSeconds,
  estimateTokens,
  fitToWidth,
  lineWithLabel,
  padToWidth,
  repeat,
  renderMarkdown,
  roleColor,
  sanitizeTerminalText,
  statusColor,
  streamStats,
  stripAnsi,
  stringWidth,
  truncateToWidth,
  wrapLine,
  wrapLineAnsiAware,
  wrapText,
  type ChatState,
  type TranscriptLayout,
  type UiMessage,
} from "./state.js";
import {
  computeWheelStep,
  detectXtermJsWheelHost,
  initWheelAccel,
  type WheelAccelState,
} from "./wheelAccel.js";

/** Coalescing window for throttled renders (~30fps). */
const RENDER_THROTTLE_MS = 33;

export class Renderer {
  private readonly state: ChatState;
  private readonly wheelAccel: WheelAccelState;
  private dirty = false;
  private renderTimer: NodeJS.Timeout | null = null;
  private scrollDrainTimer: NodeJS.Timeout | null = null;

  constructor(state: ChatState) {
    this.state = state;
    this.wheelAccel = initWheelAccel(detectXtermJsWheelHost(), 1);
  }

  // -------------------------------------------------------------------------
  // Throttled render entry points
  // -------------------------------------------------------------------------

  /** Request a coalesced render (~30fps). Safe to call on every streaming token. */
  requestRender(): void {
    if (this.state.exiting) return;
    this.dirty = true;
    if (this.renderTimer) return; // already scheduled
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      if (this.dirty) {
        this.dirty = false;
        this.render();
      }
    }, RENDER_THROTTLE_MS);
  }

  /** Render immediately, cancelling any pending throttled render. */
  renderNow(): void {
    if (this.state.exiting) return;
    this.dirty = false;
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.render();
  }

  /** Clear pending timers. Called during shutdown. */
  dispose(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    if (this.scrollDrainTimer) {
      clearTimeout(this.scrollDrainTimer);
      this.scrollDrainTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Scroll management (couples to layout because it needs line counts)
  // -------------------------------------------------------------------------

  pinScroll(): void {
    this.clearPendingScroll();
    if (this.state.autoScroll) {
      this.state.scrollOffset = this.maxScrollOffset();
    }
  }

  scrollTranscriptBy(delta: number): void {
    this.clearPendingScroll();
    this.applyTranscriptScroll(delta, true);
  }

  scrollTranscriptByPage(direction: -1 | 1): void {
    const amount = Math.max(3, Math.floor(this.messageViewportHeight() / 2));
    this.scrollTranscriptBy(direction * amount);
  }

  queueWheelScroll(direction: -1 | 1): void {
    const step = computeWheelStep(this.wheelAccel, direction, Date.now());
    if (step <= 0) return;
    this.state.pendingScrollDelta += direction * step;
    this.state.panel.pendingScrollDelta = this.state.pendingScrollDelta;
    this.scheduleScrollDrain();
  }

  maxScrollOffset(): number {
    const totalLines = this.buildTranscriptLayout(this.messageBodyWidth()).lines.length;
    return Math.max(0, totalLines - this.messageViewportHeight());
  }

  messageBodyWidth(): number {
    const width = process.stdout.columns ?? 120;
    const body = this.bodyWidths(width);
    return body.messageInner;
  }

  messageLineIndexForMessage(messageIndex: number, width: number): number {
    return this.buildTranscriptLayout(width).messageStarts[messageIndex] ?? 0;
  }

  private applyTranscriptScroll(delta: number, renderAfter: boolean): number {
    const max = this.maxScrollOffset();
    if (max <= 0) {
      this.state.scrollOffset = 0;
      this.state.autoScroll = true;
      if (renderAfter) this.renderNow();
      return 0;
    }

    const before = this.state.scrollOffset;
    if (delta < 0) {
      this.state.autoScroll = false;
    }

    this.state.scrollOffset = clamp(this.state.scrollOffset + delta, 0, max);
    if (this.state.scrollOffset >= max) {
      this.state.autoScroll = true;
    }
    if (renderAfter) this.renderNow();
    return this.state.scrollOffset - before;
  }

  private scheduleScrollDrain(): void {
    if (this.scrollDrainTimer) return;
    this.scrollDrainTimer = setTimeout(() => {
      this.scrollDrainTimer = null;
      this.drainPendingScroll();
    }, 16);
  }

  private drainPendingScroll(): void {
    if (this.state.pendingScrollDelta === 0) {
      this.state.panel.pendingScrollDelta = 0;
      return;
    }

    const pending = this.state.pendingScrollDelta;
    const magnitude = Math.max(1, Math.ceil(Math.abs(pending) * 0.35));
    const chunk = Math.sign(pending) * Math.min(Math.abs(pending), magnitude);
    const applied = this.applyTranscriptScroll(chunk, true);
    if (applied === 0) {
      this.clearPendingScroll();
      return;
    }

    this.state.pendingScrollDelta -= applied;
    this.state.panel.pendingScrollDelta = this.state.pendingScrollDelta;
    if (this.state.pendingScrollDelta !== 0) {
      this.scheduleScrollDrain();
    }
  }

  private clearPendingScroll(): void {
    this.state.pendingScrollDelta = 0;
    this.state.panel.pendingScrollDelta = 0;
    if (this.scrollDrainTimer) {
      clearTimeout(this.scrollDrainTimer);
      this.scrollDrainTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Layout sizing
  // -------------------------------------------------------------------------

  private messageViewportHeight(): number {
    const height = process.stdout.rows ?? 32;
    const headerLines = this.renderHeader(process.stdout.columns ?? 120).length;
    const composerLines = this.renderComposer(process.stdout.columns ?? 120).lines.length;
    return Math.max(8, height - headerLines - composerLines - 2);
  }

  private bodyWidths(width: number): { messageInner: number; statusInner: number } {
    const contentWidth = Math.max(70, width - 8);
    const messageInner = clamp(Math.floor(contentWidth * 0.72), 48, Math.max(48, contentWidth - 28));
    const statusInner = Math.max(24, contentWidth - messageInner - 1);
    return { messageInner, statusInner };
  }

  // -------------------------------------------------------------------------
  // Full-screen draw
  // -------------------------------------------------------------------------

  private render(): void {
    if (this.state.exiting) return;
    const width = process.stdout.columns ?? 120;
    const height = process.stdout.rows ?? 32;
    const headerLines = this.renderHeader(width);
    const composer = this.renderComposer(width);
    const bodyHeight = Math.max(8, height - headerLines.length - composer.lines.length - 2);
    const widths = this.bodyWidths(width);
    const layout = this.buildTranscriptLayout(widths.messageInner);
    const bodyTop = this.renderBodyBorder(widths.messageInner, widths.statusInner, "Transcript", "Inspector");
    const bodyBottom = this.renderBodyBorder(widths.messageInner, widths.statusInner);
    this.state.scrollOffset = clamp(this.state.scrollOffset, 0, Math.max(0, layout.lines.length - bodyHeight));
    const visibleTranscript = layout.lines.slice(this.state.scrollOffset, this.state.scrollOffset + bodyHeight);
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
    const modelInfo = `${COLORS.header}${this.state.config.llm.provider}:${this.state.config.llm.model}${ANSI.reset}`;
    const state = this.state.searchMode
      ? `${COLORS.status}search${ANSI.reset}`
      : this.state.busy
        ? `${COLORS.warning}streaming${ANSI.reset}`
        : `${COLORS.placeholder}idle${ANSI.reset}`;
    const hints = `${COLORS.placeholder}${this.state.footerHint}${ANSI.reset}`;
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
    const panel = this.state.panel;
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
    pushKV("mode", panel.mode, COLORS.header);
    pushKV("run", panel.runStatus, statusColor(panel.runStatus));
    pushKV("goal", compactValue(panel.goal));
    pushKV("output", compactValue(panel.outputDir));
    pushBlank();

    pushSection("Task");
    pushKV("case", compactValue(panel.currentCase));
    pushKV("id", compactValue(panel.currentTaskId));
    pushKV("type", compactValue(panel.currentTaskType));
    pushKV("quality", panel.qualityStatus, statusColor(panel.qualityStatus));
    pushKV("persist", panel.persistStatus, statusColor(panel.persistStatus));
    pushKV("artifacts", panel.totalArtifacts, COLORS.header);
    pushBlank();

    pushSection("Progress");
    pushMeter("tasks", panel.completedTasks, panel.plannedTasks);
    pushKV("running", panel.runningTasks, COLORS.warning);
    pushKV("pending", panel.pendingTasks);
    pushKV("blocked", panel.blockedTasks, panel.blockedTasks > 0 ? COLORS.error : COLORS.placeholder);
    pushKV("failed", panel.failedTasks, panel.failedTasks > 0 ? COLORS.error : COLORS.placeholder);
    pushKV("ready", panel.readyTasks, COLORS.status);
    if (panel.mode === "benchmark") {
      pushBlank();
      pushSection("Benchmark");
      pushMeter("cases", panel.benchmarkDone, panel.benchmarkTotal);
      pushKV("pass", panel.benchmarkPassed, COLORS.status);
      pushKV("fail", panel.benchmarkFailed, panel.benchmarkFailed > 0 ? COLORS.error : COLORS.placeholder);
      pushKV("error", panel.benchmarkError, panel.benchmarkError > 0 ? COLORS.error : COLORS.placeholder);
    }
    pushBlank();

    pushSection("Viewport");
    pushKV("follow", this.state.autoScroll ? "tail" : "manual", this.state.autoScroll ? COLORS.status : COLORS.warning);
    pushKV("scroll", `${this.state.scrollOffset}/${this.maxScrollOffset()}`);
    pushKV("wheel", panel.mouseWheelEvents, panel.mouseWheelEvents > 0 ? COLORS.status : COLORS.placeholder);
    pushKV("pending", panel.pendingScrollDelta);
    pushKV("last key", compactValue(panel.lastParsedKey));
    if (panel.lastMouseSequence || panel.lastRawChunk) {
      pushKV("mouse", compactValue(panel.lastMouseSequence));
      pushKV("raw", compactValue(panel.lastRawChunk));
    }
    pushBlank();

    pushSection("Stream");
    pushKV("state", panel.llmStatus, panel.llmStatus.includes("waiting") ? COLORS.warning : statusColor(panel.llmStatus));
    pushKV("elapsed", elapsedSeconds(panel.activeLlmStartedAt));
    pushKV("chunks", panel.llmChunkCount, panel.llmChunkCount > 0 ? COLORS.status : COLORS.warning);
    pushKV("last hb", elapsedSeconds(panel.lastHeartbeatAt));
    pushKV("tag", compactValue(panel.lastStreamTag));
    pushKV("agent", compactValue(panel.currentAgent), COLORS.header);
    pushKV("model", compactValue(panel.currentModel), COLORS.header);
    pushKV("session", compactValue(panel.activeSessionId));
    pushKV("tokens", panel.totalTokens > 0
      ? `${panel.promptTokens}+${panel.completionTokens}=${panel.totalTokens}`
      : "waiting usage");
    if (panel.currentPromptPreview) {
      pushWrapped(`asking: ${truncateToWidth(panel.currentPromptPreview.replace(/\s+/g, " "), Math.max(10, width - 8))}`, COLORS.placeholder);
    }
    if (this.state.searchMode || this.state.searchQuery) {
      pushKV("search", compactValue(this.state.searchQuery), COLORS.status);
      pushKV("hits", `${this.state.searchMatches.length}${this.state.searchMatches.length > 0 ? ` (${this.state.searchMatchIndex + 1}/${this.state.searchMatches.length})` : ""}`, COLORS.status);
    }
    pushBlank();

    pushSection("Recent");
    for (const event of panel.recentEvents.slice(-6)) {
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
    const state = this.state;
    const contentWidth = Math.max(70, width - 8);
    const innerWidth = Math.max(16, contentWidth);
    const label = state.searchMode ? `${COLORS.status}Search${COLORS.border}` : `${COLORS.accentSoft}Compose${COLORS.border}`;
    const activeValue = state.searchMode ? state.searchQuery : state.input;
    const inputTokens = estimateTokens(state.input);
    const contextTokens = estimateTokens([
      ...state.sessionMemory.slice(-6),
      ...state.chatHistory.slice(-18).map((message) => message.content),
    ].join("\n")) + inputTokens;
    const tokenMeta = state.searchMode
      ? `${COLORS.placeholder}${Array.from(state.searchQuery).length} chars${COLORS.border}`
      : `${COLORS.placeholder}input ~${inputTokens} tok | ctx ~${contextTokens}/${state.config.llm.maxTokens}${COLORS.border}`;
    const labelText = ` ${label} `;
    const metaText = ` ${tokenMeta} `;
    const titleGap = repeat("─", Math.max(0, innerWidth - stringWidth(labelText) - stringWidth(metaText)));
    const top = `${COLORS.border}╭─${labelText}${titleGap}${metaText}─╮${ANSI.reset}`;
    const bottom = `${COLORS.border}╰─${repeat("─", innerWidth)}─╯${ANSI.reset}`;
    const placeholder = state.searchMode
      ? " Type to search transcript, Enter next match, Esc exit"
      : " Type a message or /help";
    const activeCursorIndex = state.searchMode ? Array.from(state.searchQuery).length : state.cursorIndex;
    const composerLines: string[] = [];
    let cursorRow = 1;
    let cursorCol = 3;

    if (activeValue.length === 0) {
      const hintText = wrapLine(placeholder, Math.max(1, innerWidth - 1))[0] ?? "";
      const hint = `${COLORS.placeholder}${hintText}${ANSI.reset}`;
      const padded = repeat(" ", Math.max(0, innerWidth - stringWidth(hintText)));
      composerLines.push(`${COLORS.border}│ ${ANSI.reset}${hint}${padded}${COLORS.border} │${ANSI.reset}`);
    } else {
      const layout = this.layoutInputLines(activeValue, innerWidth, activeCursorIndex);
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

  private layoutInputLines(
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
    for (const message of this.state.messages) {
      messageStarts.push(lines.length);
      lines.push(...this.renderMessageCard(message, transcriptWidth));
      lines.push(padToWidth("", transcriptWidth));
    }
    return {
      lines: lines.length > 0 ? lines : [padToWidth("", transcriptWidth)],
      messageStarts,
    };
  }
}
