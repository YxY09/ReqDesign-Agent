/**
 * Slash-command router: registers and dispatches commands entered in the
 * composer (/help, /clear, /search, /quit, /cancel, /design, /benchmark).
 *
 * Bug fixes:
 *  - #5: `/analyze` is removed entirely (it was a disabled dead command); it is
 *    no longer listed in /help and dispatching it returns an unknown-command error.
 *  - #3: `/benchmark` derives its cases dir from config instead of a hard-coded path.
 *
 * @module
 */

import { resolveDefaultOutput, type ChatState } from "./state.js";
import type { Renderer } from "./renderer.js";
import type { WorkflowBridge } from "./workflowBridge.js";
import type { InputController } from "./input.js";

/** Callbacks the router needs but should not own (lives in chatApp). */
export interface CommandCallbacks {
  quit: () => void;
}

export class CommandRouter {
  private readonly state: ChatState;
  private readonly renderer: Renderer;
  private readonly workflow: WorkflowBridge;
  private readonly input: InputController;
  private readonly callbacks: CommandCallbacks;

  constructor(
    state: ChatState,
    renderer: Renderer,
    workflow: WorkflowBridge,
    input: InputController,
    callbacks: CommandCallbacks,
  ) {
    this.state = state;
    this.renderer = renderer;
    this.workflow = workflow;
    this.input = input;
    this.callbacks = callbacks;
  }

  async handle(raw: string): Promise<void> {
    const state = this.state;
    const [command, ...args] = raw.trim().split(/\s+/);

    if (command === "/help") {
      pushCommandHelp(state);
      return;
    }
    if (command === "/clear") {
      state.messages.length = 0;
      state.chatHistory.length = 0;
      state.sessionMemory.length = 0;
      state.workflowMemories.length = 0;
      state.followUpActions.length = 0;
      state.pendingFilePath = null;
      state.streamMessageIndex.clear();
      state.scrollOffset = 0;
      state.autoScroll = true;
      state.messages.push({ role: "system", title: "ReqDesign Chat", content: "会话已清空。", variant: "plain" });
      this.renderer.pinScroll();
      this.renderer.renderNow();
      return;
    }
    if (command === "/search") {
      const query = args.join(" ").trim();
      this.input.enterSearchMode(query);
      return;
    }
    if (command === "/quit" || command === "/exit") {
      this.callbacks.quit();
      return;
    }
    if (command === "/cancel") {
      this.workflow.requestCancelWorkflow("cancelled by /cancel");
      return;
    }
    if (command === "/design") {
      if (args.length < 1) {
        pushCommandError(state, `${command} 需要文件路径参数。`);
        return;
      }
      const input = args[0];
      const output = args[1] ?? resolveDefaultOutput(state.config, "design");
      await this.workflow.runWorkflowCommand("design", input, output);
      return;
    }
    if (command === "/benchmark") {
      const casesDir = args[0] ?? state.config.benchmark.casesDir;
      const outputDir = args[1] ?? "benchmark/results";
      await this.workflow.runBenchmarkCommand(casesDir, outputDir);
      return;
    }

    pushCommandError(state, `未知命令: ${command}`);
  }
}

// ---------------------------------------------------------------------------
// Command-specific helpers
// ---------------------------------------------------------------------------

function pushCommandHelp(state: ChatState): void {
  state.messages.push({
    role: "status",
    title: "Commands",
    content: [
      "/help",
      "/clear",
      "/search <keyword>",
      "/design <file> [outputDir]",
      "/benchmark [casesDir] [outputDir]",
      "/cancel",
      "/quit",
    ].join("\n"),
    variant: "plain",
  });
  state.renderer.pinScroll();
  state.renderer.requestRender();
}

function pushCommandError(state: ChatState, message: string): void {
  state.messages.push({
    role: "error",
    title: "Command Error",
    content: message,
    variant: "plain",
  });
  state.renderer.pinScroll();
  state.renderer.requestRender();
}
