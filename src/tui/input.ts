/**
 * Input controller: raw-mode terminal input, key/mouse dispatch, composer text
 * editing, input history, search mode, and screen enter/leave.
 *
 * Windows console mode helpers are async (bug #2): they spawn PowerShell via
 * the asynchronous {@link execFile} instead of the blocking `execFileSync`,
 * which froze the process and is unavailable on non-Windows hosts. Cleanup
 * restores the prior console mode on the way out.
 *
 * User-driven paths call {@link Renderer.renderNow} (no input latency); only
 * streaming/workflow paths use the throttled {@link Renderer.requestRender}.
 *
 * @module
 */

import { execFile, type ExecFileException } from "node:child_process";
import process from "node:process";
import {
  createInitialTerminalInputState,
  parseTerminalInput,
  type InputKey,
  type TerminalInputEvent,
  type TerminalInputState,
} from "../utils/terminalInput.js";
import {
  ANSI,
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  NATIVE_CONSOLE_CSHARP,
  WINDOWS_INPUT_MODE_ENABLE_EXTENDED_FLAGS,
  WINDOWS_INPUT_MODE_ENABLE_MOUSE_INPUT,
  WINDOWS_INPUT_MODE_ENABLE_QUICK_EDIT,
  WINDOWS_INPUT_MODE_ENABLE_VT_INPUT,
  clamp,
  formatMouseSequenceDebug,
  type ChatState,
} from "./state.js";
import type { Renderer } from "./renderer.js";

const NORMAL_INPUT_TIMEOUT_MS = 50;
const PASTE_INPUT_TIMEOUT_MS = 500;

/** Handlers the input controller delegates to (keeps it free of chatApp/bridge types). */
export interface InputHandlers {
  submit: () => Promise<void>;
  cancel: (reason: string) => void;
  shutdown: (exitCode?: number) => void;
}

export class InputController {
  private readonly state: ChatState;
  private readonly renderer: Renderer;
  private readonly handlers: InputHandlers;
  private terminalInputState: TerminalInputState = createInitialTerminalInputState();
  private incompleteInputTimer: NodeJS.Timeout | null = null;

  constructor(state: ChatState, renderer: Renderer, handlers: InputHandlers) {
    this.state = state;
    this.renderer = renderer;
    this.handlers = handlers;
  }

  // -------------------------------------------------------------------------
  // Screen enter / leave (async Windows helpers — bug #2)
  // -------------------------------------------------------------------------

  async enterScreen(): Promise<void> {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    this.state.windowsInputModeBeforeTui = await configureWindowsVirtualTerminalInput();
    process.stdin.setEncoding("utf8");
    process.stdin.resume();

    process.stdout.write(ANSI.altOn + ANSI.clear + ANSI.home + ENABLE_MOUSE_TRACKING + ANSI.hideCursor);

    const inputHandler = (chunk: string | Buffer) => {
      this.processTerminalChunk(chunk);
    };
    const resizeHandler = () => {
      this.reassertTerminalModes();
      this.renderer.renderNow();
    };

    process.stdin.on("data", inputHandler);
    process.stdout.on("resize", resizeHandler);
    setTimeout(() => this.reassertTerminalModes(), 0);
  }

  /** Restore terminal state. Async so the Windows console mode restore can run. */
  async dispose(): Promise<void> {
    process.stdout.write(DISABLE_MOUSE_TRACKING);
    if (this.incompleteInputTimer) {
      clearTimeout(this.incompleteInputTimer);
      this.incompleteInputTimer = null;
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    if (this.state.windowsInputModeBeforeTui !== null) {
      try {
        await setWindowsConsoleMode(this.state.windowsInputModeBeforeTui);
      } catch {
        // 尽力恢复
      }
      this.state.windowsInputModeBeforeTui = null;
    }
    process.stdout.write(ANSI.showCursor + ANSI.altOff + ANSI.reset);
  }

  private reassertTerminalModes(): void {
    process.stdout.write(ENABLE_MOUSE_TRACKING + ANSI.hideCursor);
  }

  // -------------------------------------------------------------------------
  // Input dispatch
  // -------------------------------------------------------------------------

  private processTerminalChunk(input: string | Buffer | null): void {
    if (input !== null) {
      const rawText = typeof input === "string" ? input : String(input);
      this.state.panel.lastRawChunk = formatMouseSequenceDebug(rawText);
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
            this.incompleteInputTimer = setTimeout(() => this.processTerminalChunk(null), NORMAL_INPUT_TIMEOUT_MS);
            return;
          }
          this.processTerminalChunk(null);
        },
        this.terminalInputState.mode === "IN_PASTE" ? PASTE_INPUT_TIMEOUT_MS : NORMAL_INPUT_TIMEOUT_MS,
      );
    }
  }

  private async handleTerminalInputEvent(event: TerminalInputEvent): Promise<void> {
    if (event.kind === "mouse") {
      this.state.panel.lastMouseSequence = formatMouseSequenceDebug(event.sequence);
      this.state.panel.lastParsedKey = `mouse:${event.button}:${event.action}@${event.col},${event.row}`;
      this.renderer.renderNow();
      return;
    }

    const { key, text } = event;
    this.state.panel.lastParsedKey = [
      key.name ?? "(text)",
      key.ctrl ? "ctrl" : "",
      key.meta ? "meta" : "",
      key.shift ? "shift" : "",
      text ? `text=${JSON.stringify(text)}` : "",
    ].filter(Boolean).join(" ");
    if (key.name === "wheelup") {
      this.state.panel.mouseWheelEvents += 1;
      this.state.panel.lastMouseSequence = formatMouseSequenceDebug(key.sequence);
      this.renderer.queueWheelScroll(-1);
      return;
    }
    if (key.name === "wheeldown") {
      this.state.panel.mouseWheelEvents += 1;
      this.state.panel.lastMouseSequence = formatMouseSequenceDebug(key.sequence);
      this.renderer.queueWheelScroll(1);
      return;
    }
    await this.handleKeypress(text ?? "", key);
  }

  private async handleKeypress(text: string, key: InputKey): Promise<void> {
    const state = this.state;
    if (state.exiting) return;

    if (key.ctrl && key.name === "c") {
      if (state.busy && state.currentRuntime) {
        this.handlers.cancel("cancelled by Ctrl+C");
        return;
      }
      this.handlers.shutdown(130);
      return;
    }

    if (state.busy && key.name === "escape") {
      this.handlers.cancel("cancelled by Escape");
      return;
    }

    if (key.name === "pageup") {
      this.renderer.scrollTranscriptByPage(-1);
      return;
    }
    if (key.name === "pagedown") {
      this.renderer.scrollTranscriptByPage(1);
      return;
    }

    if (key.ctrl && key.name === "l") {
      this.renderer.renderNow();
      return;
    }
    if (key.ctrl && key.name === "r") {
      if (state.searchMode) {
        this.exitSearchMode();
      } else {
        this.enterSearchMode();
      }
      return;
    }

    if (state.searchMode) {
      this.handleSearchKeypress(text, key);
      return;
    }

    if (key.name === "escape") {
      return;
    }

    if (state.busy) {
      return;
    }

    if (key.ctrl && key.name === "j") {
      this.insertText("\n");
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      await this.handlers.submit();
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
      state.cursorIndex = Math.max(0, state.cursorIndex - 1);
      this.renderer.renderNow();
      return;
    }
    if (key.name === "right") {
      state.cursorIndex = Math.min(Array.from(state.input).length, state.cursorIndex + 1);
      this.renderer.renderNow();
      return;
    }
    if (key.name === "home") {
      state.cursorIndex = 0;
      this.renderer.renderNow();
      return;
    }
    if (key.name === "end") {
      state.cursorIndex = Array.from(state.input).length;
      this.renderer.renderNow();
      return;
    }
    if (key.name === "up") {
      // 如果输入为空，向上滚动而非浏览历史
      if (!state.input) {
        this.renderer.scrollTranscriptBy(-3);
        return;
      }
      if (this.navigateHistory(-1)) return;
      return;
    }
    if (key.name === "down") {
      // 如果输入为空，向下滚动而非浏览历史
      if (!state.input) {
        this.renderer.scrollTranscriptBy(3);
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
    const state = this.state;
    if (key.name === "escape") {
      this.exitSearchMode();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      if (state.searchMatches.length > 0) {
        state.searchMatchIndex = (state.searchMatchIndex + 1) % state.searchMatches.length;
        this.jumpToCurrentSearchResult();
      }
      this.renderer.renderNow();
      return;
    }
    if (key.name === "backspace") {
      if (state.searchQuery.length > 0) {
        state.searchQuery = Array.from(state.searchQuery).slice(0, -1).join("");
        this.refreshSearch();
      }
      return;
    }
    if (key.name === "delete") {
      return;
    }
    if (key.name === "up") {
      if (state.searchMatches.length > 0) {
        state.searchMatchIndex = (state.searchMatchIndex - 1 + state.searchMatches.length) % state.searchMatches.length;
        this.jumpToCurrentSearchResult();
      }
      this.renderer.renderNow();
      return;
    }
    if (key.name === "down") {
      if (state.searchMatches.length > 0) {
        state.searchMatchIndex = (state.searchMatchIndex + 1) % state.searchMatches.length;
        this.jumpToCurrentSearchResult();
      }
      this.renderer.renderNow();
      return;
    }
    if (text && !key.ctrl && !key.meta) {
      state.searchQuery += text;
      this.refreshSearch();
    }
  }

  // -------------------------------------------------------------------------
  // Composer text editing
  // -------------------------------------------------------------------------

  private insertText(text: string): void {
    const state = this.state;
    const chars = Array.from(state.input);
    chars.splice(state.cursorIndex, 0, ...Array.from(text));
    state.input = chars.join("");
    state.cursorIndex += Array.from(text).length;
    this.renderer.renderNow();
  }

  private deleteBackward(): void {
    const state = this.state;
    if (state.cursorIndex === 0) return;
    const chars = Array.from(state.input);
    chars.splice(state.cursorIndex - 1, 1);
    state.input = chars.join("");
    state.cursorIndex -= 1;
    this.renderer.renderNow();
  }

  private deleteForward(): void {
    const state = this.state;
    const chars = Array.from(state.input);
    if (state.cursorIndex >= chars.length) return;
    chars.splice(state.cursorIndex, 1);
    state.input = chars.join("");
    this.renderer.renderNow();
  }

  private navigateHistory(delta: -1 | 1): boolean {
    const state = this.state;
    if (state.inputHistory.length === 0) return false;

    if (state.historyIndex === -1) {
      state.historyDraft = state.input;
      state.historyIndex = state.inputHistory.length;
    }

    const nextIndex = clamp(state.historyIndex + delta, 0, state.inputHistory.length);
    state.historyIndex = nextIndex;
    state.input = nextIndex === state.inputHistory.length
      ? state.historyDraft
      : state.inputHistory[nextIndex];
    state.cursorIndex = Array.from(state.input).length;
    this.renderer.renderNow();
    return true;
  }

  // -------------------------------------------------------------------------
  // Search mode
  // -------------------------------------------------------------------------

  enterSearchMode(initialQuery = ""): void {
    const state = this.state;
    state.searchMode = true;
    state.searchQuery = initialQuery;
    this.refreshSearch();
  }

  private exitSearchMode(): void {
    const state = this.state;
    state.searchMode = false;
    state.searchQuery = "";
    state.searchMatches = [];
    state.searchMatchIndex = 0;
    this.renderer.renderNow();
  }

  private refreshSearch(): void {
    const state = this.state;
    const query = state.searchQuery.trim().toLowerCase();
    if (!query) {
      state.searchMatches = [];
      state.searchMatchIndex = 0;
      this.renderer.renderNow();
      return;
    }
    state.searchMatches = state.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => `${message.title}\n${message.content}`.toLowerCase().includes(query))
      .map(({ index }) => index);
    state.searchMatchIndex = 0;
    this.jumpToCurrentSearchResult();
    this.renderer.renderNow();
  }

  private jumpToCurrentSearchResult(): void {
    const state = this.state;
    if (state.searchMatches.length === 0) return;
    const targetMessageIndex = state.searchMatches[state.searchMatchIndex];
    const lineIndex = this.renderer.messageLineIndexForMessage(targetMessageIndex, this.renderer.messageBodyWidth());
    state.autoScroll = false;
    state.scrollOffset = clamp(lineIndex, 0, this.renderer.maxScrollOffset());
  }
}

// ---------------------------------------------------------------------------
// Windows console mode helpers — async (bug #2)
// ---------------------------------------------------------------------------

/** Run a PowerShell console-mode script asynchronously, returning its stdout. */
function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8" },
      (err: ExecFileException | null, stdout: string, _stderr: string) => {
        if (err) {
          reject(err);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/** Asynchronously set the Windows console input mode. */
async function setWindowsConsoleMode(mode: number): Promise<void> {
  const script = [
    ...NATIVE_CONSOLE_CSHARP,
    "$handle = [NativeConsole]::GetStdHandle(-10)",
    `if (-not [NativeConsole]::SetConsoleMode($handle, ${mode})) { exit 1 }`,
  ].join("\n");
  await runPowerShell(script);
}

/** Enable VT/mouse input and disable QuickEdit on Windows; returns the prior mode. */
async function configureWindowsVirtualTerminalInput(): Promise<number | null> {
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
    const output = (await runPowerShell(script)).trim();
    const mode = Number.parseInt(output, 10);
    return Number.isFinite(mode) ? mode : null;
  } catch {
    return null;
  }
}

