/**
 * Terminal chat app — slim controller.
 *
 * Assembles the TUI submodules (renderer, input, commands, workflow bridge)
 * around a single shared {@link ChatState}, owns the process lifecycle, routes
 * submitted input (commands vs. conversation), and runs the conversation
 * coordinator (deciding chat vs. workflow, streaming the coordinator LLM call).
 *
 * Bug fixes applied here:
 *  - #1: the coordinator decision call and the chat response call now stream
 *    via an onChunk that yields the event loop (coordinator) / request a
 *    throttled render (chat), instead of blocking synchronously.
 *  - #5: `/analyze` is gone; the coordinator never returns an analyze goal and
 *    the completion guide has no analyze branch.
 *
 * @module
 */

import { existsSync } from "node:fs";
import process from "node:process";
import { LLMClient } from "../llmClient.js";
import {
  ANSI,
  defaultPanelState,
  memoryForPrompt,
  pushAssistantMessage,
  pushMessage,
  resolveDefaultOutput,
  trimChatHistory,
  type ChatAppOptions,
  type ChatState,
  type ConversationDecision,
  type UiMessage,
} from "./state.js";
import { Renderer } from "./renderer.js";
import { InputController } from "./input.js";
import { CommandRouter } from "./commands.js";
import { WorkflowBridge } from "./workflowBridge.js";

export class TerminalChatApp {
  private readonly state: ChatState;
  private readonly renderer: Renderer;
  private readonly input: InputController;
  private readonly workflow: WorkflowBridge;
  private readonly commands: CommandRouter;
  private resolveExit: (() => void) | null = null;

  constructor(options: ChatAppOptions) {
    const state: ChatState = {
      config: options.config,
      llm: new LLMClient(options.config),
      renderer: undefined as unknown as Renderer, // wired below
      messages: [],
      chatHistory: [],
      sessionMemory: [],
      workflowMemories: [],
      followUpActions: [],
      streamMessageIndex: new Map(),
      input: "",
      cursorIndex: 0,
      inputHistory: [],
      historyIndex: -1,
      historyDraft: "",
      scrollOffset: 0,
      autoScroll: true,
      pendingScrollDelta: 0,
      panel: defaultPanelState(),
      searchMode: false,
      searchQuery: "",
      searchMatches: [],
      searchMatchIndex: 0,
      busy: false,
      exiting: false,
      footerHint: "Enter send | Wheel/PgUp/PgDn scroll | Ctrl+R search | Ctrl+C exit",
      pendingFilePath: null,
      currentRuntime: null,
      cancelRequested: false,
      windowsInputModeBeforeTui: null,
    };
    this.state = state;
    const renderer = new Renderer(state);
    state.renderer = renderer;
    this.renderer = renderer;
    this.input = new InputController(state, renderer, {
      submit: () => this.submitInput(),
      cancel: (reason) => this.workflow.requestCancelWorkflow(reason),
      shutdown: (code) => {
        void this.shutdown(code);
      },
    });
    this.workflow = new WorkflowBridge(state, renderer);
    this.commands = new CommandRouter(state, renderer, this.workflow, this.input, {
      quit: () => {
        void this.shutdown(0);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    await this.input.enterScreen();
    pushMessage(this.state, "system", "ReqDesign Chat", [
      "交互模式已启动。",
      "普通输入走对话模型；/design /benchmark 会把本地流程实时流式输出到左侧会话区。",
      "支持 Ctrl+R 搜索记录、Up/Down 输入历史、右侧状态面板实时查看任务进度。",
    ].join("\n"));

    // 安全网：确保即使在未捕获的异常时也能恢复终端状态
    const emergencyCleanup = () => {
      try {
        process.stdout.write("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1007l"); // 禁用所有鼠标模式
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdout.write(ANSI.showCursor + ANSI.altOff + ANSI.reset + "\n");
      } catch { /* 尽力而为 */ }
    };
    process.on("uncaughtException", emergencyCleanup);
    process.on("SIGINT", emergencyCleanup);
    process.on("exit", emergencyCleanup);

    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  async shutdown(exitCode?: number): Promise<void> {
    const state = this.state;
    if (state.exiting) return;
    state.exiting = true;
    await this.input.dispose();
    this.renderer.dispose();
    this.workflow.dispose();
    this.resolveExit?.();
    if (exitCode !== undefined) {
      setImmediate(() => {
        process.exit(exitCode);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Submit routing (commands vs. conversation)
  // -------------------------------------------------------------------------

  private async submitInput(): Promise<void> {
    const state = this.state;
    const content = state.input.trimEnd();
    if (!content.trim()) return;

    pushMessage(state, "user", "You", content);
    if (state.inputHistory[state.inputHistory.length - 1] !== content) {
      state.inputHistory.push(content);
    }
    state.input = "";
    state.cursorIndex = 0;
    state.historyIndex = -1;
    state.historyDraft = "";
    state.busy = true;
    state.autoScroll = true;
    state.footerHint = "Busy... Wheel/PgUp/PgDn scroll | Ctrl+C exit";
    this.renderer.renderNow();

    try {
      if (state.chatHistory[state.chatHistory.length - 1]?.content !== content) {
        state.chatHistory.push({ role: "user", content });
        trimChatHistory(state);
      }
      if (content.startsWith("/")) {
        await this.commands.handle(content);
      } else {
        const decision = await this.coordinateConversation(content);
        if (decision.action === "run_workflow") {
          pushMessage(state, "status", "Conversation Coordinator", [
            `decision: run ${decision.goal}`,
            `reason: ${decision.reason}`,
            `input: ${decision.input}`,
          ].join("\n"));
          await this.workflow.runWorkflowCommand(decision.goal, decision.input, decision.output ?? resolveDefaultOutput(state.config, decision.goal));
        } else if (decision.action === "ask_clarification") {
          state.pendingFilePath = decision.filePath;
          pushAssistantMessage(state, "Clarification", decision.message);
        } else if (decision.action === "respond") {
          pushAssistantMessage(state, decision.title, decision.content);
        } else {
          await this.handleChat();
        }
      }
    } catch (error: unknown) {
      pushMessage(state, "error", "Error", error instanceof Error ? error.message : String(error));
    } finally {
      state.busy = false;
      state.footerHint = "Enter send | Wheel/PgUp/PgDn scroll | Ctrl+R search | Ctrl+C exit";
      this.renderer.renderNow();
    }
  }

  // -------------------------------------------------------------------------
  // Conversation coordinator
  // -------------------------------------------------------------------------

  /** 决定用户消息是应该对话、请求澄清，还是启动工作流。 */
  private async coordinateConversation(input: string): Promise<ConversationDecision> {
    const state = this.state;
    const pendingChoice = this.resolvePendingFileChoice(input);
    if (pendingChoice) {
      state.pendingFilePath = null;
      return pendingChoice;
    }

    const followUpChoice = this.resolveFollowUpAction(input);
    if (followUpChoice) {
      state.followUpActions.length = 0;
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
    const state = this.state;
    const explicitGoal = this.detectExplicitWorkflowGoal(input, filePath);
    if (explicitGoal) {
      return {
        action: "run_workflow",
        goal: explicitGoal,
        input: filePath,
        output: resolveDefaultOutput(state.config, explicitGoal),
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
        "1. /design 做完整设计流程，包含需求分析、系统设计、Mermaid 图和测试用例。",
        "",
        "回复 1 或 design 运行完整设计。",
      ].join("\n"),
    };
  }

  /**
   * Coordinator decision call (bug #1): stream via an onChunk + JSON mode so the
   * event loop yields between tokens (UI stays responsive). The chunk callback
   * only requests a throttled render for liveness; the final text is parsed as
   * JSON by {@link parseCoordinatorDecision}.
   */
  private async decideWorkflowWithLlm(input: string, filePath: string): Promise<ConversationDecision> {
    const state = this.state;
    const prompt = [
      "You are the Conversation Coordinator for a terminal software-design assistant.",
      "Decide whether the user wants to chat, needs clarification, or explicitly wants to run a workflow.",
      "Return JSON only, no Markdown.",
      "",
      "Allowed JSON shape:",
      '{"action":"chat"|"ask_clarification"|"run_workflow","goal":"design"|null,"question":string,"reason":string}',
      "",
      "Policy:",
      "- Never run a workflow from a bare file path alone.",
      "- Run design only when the user explicitly asks for design, architecture, diagrams, drawing, tests, or a full workflow.",
      "- Standalone analysis/extraction/requirements-structure workflows are disabled; ask the user to run design if they want the full workflow.",
      "- If unclear, ask a concise clarification question.",
      "- The local file exists and is safe to reference.",
      "",
      `Detected file: ${filePath}`,
      `User message: ${input}`,
      "",
      "Recent session memory:",
      memoryForPrompt(state, 1200),
    ].join("\n");

    try {
      const raw = await state.llm.chat(
        [
          { role: "system", content: "Return strict JSON only. Do not use emoji or icons." },
          { role: "user", content: prompt },
        ],
        undefined,
        // onChunk: yield the event loop (streaming path) + request a throttled
        // render so the status panel ticks. The text itself is parsed below.
        () => {
          state.renderer.requestRender();
        },
        true, // jsonMode
      );
      const parsed = this.parseCoordinatorDecision(raw);
      if (!parsed) return this.fallbackFileDecision(input, filePath);
      if (parsed.action === "run_workflow" && parsed.goal === "design") {
        return {
          action: "run_workflow",
          goal: parsed.goal,
          input: filePath,
          output: resolveDefaultOutput(state.config, parsed.goal),
          reason: parsed.reason || "LLM coordinator selected workflow",
        };
      }
      if (parsed.action === "ask_clarification") {
        const fallback = this.fallbackFileDecision(input, filePath);
        const fallbackMessage = fallback.action === "ask_clarification" ? fallback.message : "请选择 design。";
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
    const state = this.state;
    if (!state.pendingFilePath) return null;
    const normalized = input.trim().toLowerCase();
    const wantsAnalyze = /^(a|analyze|分析|需求分析)$/.test(normalized);
    const wantsDesign = /^(1|d|design|设计|画图|生成图|完整设计)$/.test(normalized);
    if (wantsAnalyze) {
      return {
        action: "respond",
        title: "Analyze Is Internal",
        content: "analyze 现在只作为完整设计流程的内部需求结构化阶段，不再作为单独工作流入口。请使用 /design 运行完整流程。",
      };
    }
    if (wantsDesign) {
      return {
        action: "run_workflow",
        goal: "design",
        input: state.pendingFilePath,
        output: resolveDefaultOutput(state.config, "design"),
        reason: "user selected design for pending file",
      };
    }
    return null;
  }

  private resolveFollowUpAction(input: string): ConversationDecision | null {
    const state = this.state;
    if (state.followUpActions.length === 0) return null;
    const normalized = input.trim().toLowerCase();
    const action = state.followUpActions.find((item) =>
      normalized === item.id ||
      normalized === `action ${item.id}` ||
      normalized === item.label.toLowerCase(),
    );
    return action?.decision ?? null;
  }

  private detectExplicitWorkflowGoal(input: string, filePath: string): "design" | null {
    // 仅从显式关键词检测意图。裸露的路径不应启动
    // 工作流，因为用户可能想先询问选项。
    const designKeywords = /设计|design|架构|architecture|生成|generate|系统|system|画图|diagram|测试|test|完整流程|full workflow/i;

    const lower = input.toLowerCase();
    const intentText = lower.replace(filePath.toLowerCase(), "");

    if (designKeywords.test(intentText)) {
      return "design";
    }
    return null;
  }

  private findExistingFilePath(input: string): string | null {
    const pathPatterns = [
      // 带引号的路径："C:\..." 或 '/path/to/file'
      /["']([^"']+\.(?:md|txt|docx?|pdf|yaml|yml|json))["']/i,
      // 带分隔符的无引号路径：C:\... 或 /path/... 或 ./...
      /(?:(?:[A-Za-z]:[\\/]|\.?[\/\\])\S+\.(?:md|txt|docx?|pdf|yaml|yml|json))/i,
      // 带扩展名的裸露文件名
      /\b(\w+[\w-]*\.(?:md|txt|yaml|yml|json))\b/i,
    ];

    let filePath: string | null = null;
    for (const pattern of pathPatterns) {
      const match = input.match(pattern);
      if (match) {
        filePath = match[1] ?? match[0];
        // 去除周围引号
        if (filePath.startsWith('"') || filePath.startsWith("'")) {
          filePath = filePath.slice(1, -1);
        }
        break;
      }
    }

    return filePath && existsSync(filePath) ? filePath : null;
  }

  // -------------------------------------------------------------------------
  // Chat response (streamed, throttled render — bug #1)
  // -------------------------------------------------------------------------

  private async handleChat(): Promise<void> {
    const state = this.state;
    state.panel.mode = "chat";
    state.panel.runStatus = "chatting";
    const assistantMessage: UiMessage = { role: "assistant", title: "Assistant", content: "" };
    state.messages.push(assistantMessage);
    this.renderer.pinScroll();
    this.renderer.renderNow();

    const systemPrompt = [
      "You are ReqDesign-Agent, a multi-agent LLM system for requirements-driven software design, running inside a terminal chat UI.",
      "",
      "## Auto-Detection",
      "When the user provides a file path plus explicit design intent keywords (e.g. 设计, architecture, diagram, test, full workflow), the terminal UI may run the design workflow before this chat prompt is used.",
      "A bare file path should not be treated as implicit permission to run design. Ask what the user wants to do, or suggest the explicit /design command.",
      "",
      "## Your Role",
      "- Answer questions about software design, architecture, requirements engineering directly.",
      "- When discussing a specific file, do not assume a workflow has already launched unless the transcript shows a workflow event.",
      "- If the user asks about your capabilities, mention /design and /benchmark commands. Analyze is an internal stage of /design.",
      "- Be concise, technical, and action-oriented.",
      "- Respond in the same language the user uses (Chinese -> Chinese, English -> English).",
      "- Do not use emoji, icons, pictographs, decorative symbols, or icon-like bullets in replies. Use plain text and standard Markdown only.",
      "",
      "## Session Memory",
      memoryForPrompt(state, 6000),
    ].join("\n");

    const history = state.chatHistory.slice(-18);
    try {
      const response = await state.llm.chat(
        [
          { role: "system", content: systemPrompt },
          ...history,
        ],
        undefined,
        (chunk) => {
          assistantMessage.content += chunk;
          this.renderer.pinScroll();
          // Throttled render: coalesce per-token redraws (bug #1/#4).
          this.renderer.requestRender();
        },
      );

      if (!assistantMessage.content) {
        assistantMessage.content = response;
      }
      state.chatHistory.push({ role: "assistant", content: assistantMessage.content });
      trimChatHistory(state);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      assistantMessage.content = `[Error] ${msg}`;
      pushMessage(state, "error", "Chat Error", msg);
    }
    state.panel.runStatus = "idle";
  }
}
