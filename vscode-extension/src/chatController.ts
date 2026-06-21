/**
 * ChatController — the in-process brain of the sidebar.
 *
 * Ports three pieces of the terminal chat app into a UI-agnostic controller:
 *   - the conversation coordinator (chat vs. clarification vs. run workflow)
 *     from src/tui/chatApp.ts
 *   - the streamed chat response from src/tui/chatApp.ts
 *   - the WorkflowEvent -> UI translation + run/cancel from
 *     src/tui/workflowBridge.ts
 *
 * Instead of mutating ChatState + repainting a terminal renderer, it emits
 * HostToWebview messages through an injected `emit` sink. It runs the real
 * MultiAgentRuntime in-process via runtime.run({ onEvent }).
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
// Value imports of the ReqDesign runtime are deliberately DYNAMIC (loaded in
// ensureReady, after prepareEnvironment). The parent's promptLoader resolves
// its prompt directory at module-init time from REQDESIGN_PROMPT_DIR / cwd, so
// that module must not be initialised until the env var is set. Importing the
// runtime graph statically would init it at extension-activation time (too
// early). Types below are erased at build time and cause no early init.
import type { AgentConfig } from "../../src/config.js";
import type { ChatMessage } from "../../src/llmClient.js";
import type { LLMClient } from "../../src/llmClient.js";
import type { MultiAgentRuntime } from "../../src/runtime.js";
import type { WorkflowEvent } from "../../src/workflowEvents.js";
import type { HostToWebview, PanelSnapshot, WebviewMessage } from "./protocol.js";
import {
  buildConfig,
  prepareEnvironment,
  resolveOutputDir,
  resolveProjectRoot,
} from "./projectEnv.js";

type ConversationDecision =
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

export interface ChatControllerOptions {
  emit: (msg: HostToWebview) => void;
  /** Open a native file picker; resolves to an absolute path or null. */
  pickFile: () => Promise<string | null>;
}

function emptyPanel(): PanelSnapshot {
  return {
    mode: "idle",
    goal: "",
    runStatus: "idle",
    currentAgent: "",
    currentTaskId: "",
    currentModel: "",
    plannedTasks: 0,
    completedTasks: 0,
    runningTasks: 0,
    failedTasks: 0,
    totalTokens: 0,
    outputDir: "",
    llmStatus: "idle",
  };
}

/** Workflow event kinds that are pure noise in a chat transcript. */
const SUPPRESSED_KINDS = new Set([
  "worker_heartbeat",
  "artifact_saved",
  "input_loaded",
  "planning_started",
  "evaluation_started",
  "persist_started",
  "repair_round_started",
  "repair_started",
  "repair_task_started",
  "task_started",
]);

const MILESTONE_KINDS = new Set([
  "run_started",
  "run_completed",
  "run_failed",
  "planning_completed",
  "evaluation_completed",
  "persist_completed",
  "persist_skipped",
  "trace_exported",
  "runtime_budget_exhausted",
]);

const TASK_CLOSE_KINDS = new Set([
  "task_completed",
  "task_failed",
  "repair_task_completed",
  "repair_task_failed",
  "worker_result",
  "worker_timeout",
]);

export class ChatController {
  private readonly emit: (msg: HostToWebview) => void;
  private readonly pickFileImpl: () => Promise<string | null>;

  private root: string | null = null;
  private configPath: string | null = null;
  private config: AgentConfig | null = null;
  private llm: LLMClient | null = null;

  // Dynamically-imported runtime modules (see import note at top of file).
  private llmModule: typeof import("../../src/llmClient.js") | null = null;
  private runtimeModule: typeof import("../../src/runtime.js") | null = null;

  private chatHistory: ChatMessage[] = [];
  private sessionMemory: string[] = [];
  private workflowMemories: WorkflowMemory[] = [];
  private pendingFilePath: string | null = null;
  private followUpActions: FollowUpAction[] = [];

  private currentRuntime: MultiAgentRuntime | null = null;
  private cancelRequested = false;
  private busy = false;
  private idCounter = 0;
  private panel: PanelSnapshot = emptyPanel();
  private readonly streamIndex = new Map<string, string>();

  constructor(options: ChatControllerOptions) {
    this.emit = options.emit;
    this.pickFileImpl = options.pickFile;
  }

  // -------------------------------------------------------------------------
  // Setup / readiness
  // -------------------------------------------------------------------------

  /** Send the initial state + greeting to a freshly-attached webview. */
  async sendInit(): Promise<void> {
    const ready = await this.ensureReady(false);
    const model = this.config ? `${this.config.llm.provider}:${this.config.llm.model}` : "未配置";
    this.emit({
      type: "init",
      projectRoot: this.root,
      ready,
      model,
    });
    this.pushPanel();
    if (ready) {
      this.append("system", "ReqDesign Agent", [
        "对话模式已就绪。直接提问可与设计助手对话。",
        "提供需求文件路径并表达「设计 / 架构 / 画图 / 测试」意图时，会就地运行完整设计流程，并实时流式展示各 Agent 的工作。",
        "也可用 `/design <文件路径>` 显式触发，或点击输入框左侧按钮选择文件。",
      ].join("\n"));
    } else {
      this.append("error", "尚未就绪", this.readinessHint());
    }
  }

  private readinessHint(): string {
    if (!this.root) {
      return "未找到 ReqDesign-Agent 项目根目录。请在设置 `reqdesign.projectRoot` 中填入包含 config.yaml 与 prompts/ 的目录绝对路径，然后新建会话。";
    }
    return [
      `已定位项目根：${this.root}`,
      "但配置校验未通过或缺少 API Key。请检查该目录下的 config.yaml 与 .env（或对应的 *_API_KEY 环境变量），然后新建会话重试。",
    ].join("\n");
  }

  /**
   * Resolve root + build config + LLM client. Returns whether everything is
   * ready to talk to a model. `announce` controls whether failures are pushed
   * as transcript messages (avoid double-posting from sendInit).
   */
  private async ensureReady(announce = true): Promise<boolean> {
    if (this.config && this.llm && this.root) return true;
    const resolved = resolveProjectRoot();
    if (!resolved) {
      this.root = null;
      if (announce) this.emit({ type: "notice", level: "error", text: "未找到项目根目录。" });
      return false;
    }
    this.root = resolved.root;
    this.configPath = resolved.configPath;
    // MUST run before the runtime graph is loaded so promptLoader picks up the
    // right prompt directory and getApiKey() sees the project .env.
    prepareEnvironment(this.root);

    try {
      const overrides = readSettingsOverrides();
      const config = buildConfig(this.root, this.configPath, overrides);
      const errors = config.validate();
      if (errors.length > 0) {
        if (announce) this.append("error", "配置校验失败", errors.join("\n"));
        return false;
      }
      if (!config.getApiKey()) {
        if (announce) this.append("error", "缺少 API Key", this.readinessHint());
        return false;
      }
      // Lazy-load the runtime graph now that the environment is prepared.
      this.llmModule ??= await import("../../src/llmClient.js");
      this.runtimeModule ??= await import("../../src/runtime.js");
      this.config = config;
      this.llm = new this.llmModule.LLMClient(config);
      return true;
    } catch (error) {
      if (announce) this.append("error", "初始化失败", errorText(error));
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Public actions
  // -------------------------------------------------------------------------

  async submit(rawText: string): Promise<void> {
    const content = rawText.trimEnd();
    if (!content.trim()) return;
    if (this.busy) {
      this.emit({ type: "notice", level: "info", text: "正在处理中，请等待当前任务完成或点击停止。" });
      return;
    }

    this.append("user", "你", content);
    this.setBusy(true);
    try {
      if (!(await this.ensureReady())) return;
      this.chatHistory.push({ role: "user", content });
      this.trimChatHistory();

      if (content.startsWith("/")) {
        await this.handleCommand(content);
        return;
      }

      const decision = await this.coordinateConversation(content);
      await this.applyDecision(decision);
    } catch (error) {
      this.append("error", "错误", errorText(error));
    } finally {
      this.setBusy(false);
    }
  }

  /** Entry point for the editor command "design current file". */
  async runDesignForFile(filePath: string): Promise<void> {
    if (this.busy) {
      this.emit({ type: "notice", level: "info", text: "已有任务在运行。" });
      return;
    }
    this.append("user", "你", `/design ${filePath}`);
    this.setBusy(true);
    try {
      if (!(await this.ensureReady())) return;
      const resolved = this.resolveFile(filePath);
      if (!resolved) {
        this.append("error", "文件不存在", `无法找到文件：${filePath}`);
        return;
      }
      await this.runWorkflow("design", resolved, resolveOutputDir(this.root!, this.config!, "design"));
    } catch (error) {
      this.append("error", "错误", errorText(error));
    } finally {
      this.setBusy(false);
    }
  }

  /** Open the native picker and, if a file is chosen, run design on it. */
  async pickAndDesign(): Promise<void> {
    const picked = await this.pickFileImpl();
    if (!picked) return;
    await this.runDesignForFile(picked);
  }

  cancel(): void {
    if (!this.currentRuntime) {
      this.emit({ type: "notice", level: "info", text: "当前没有正在运行的工作流。" });
      return;
    }
    if (this.cancelRequested) {
      this.emit({ type: "notice", level: "info", text: "已请求取消，正在等待当前模型调用返回。" });
      return;
    }
    this.cancelRequested = true;
    this.panel.runStatus = "cancelling";
    this.panel.llmStatus = "cancelling";
    this.pushPanel();
    this.currentRuntime.cancel("cancelled from VSCode sidebar");
    this.append("status", "已请求取消", "若 provider 不支持中断在途请求，当前这次模型调用可能不会立即停止。");
  }

  newSession(): void {
    if (this.busy) {
      this.emit({ type: "notice", level: "info", text: "请先停止当前任务再新建会话。" });
      return;
    }
    this.chatHistory = [];
    this.sessionMemory = [];
    this.workflowMemories = [];
    this.pendingFilePath = null;
    this.followUpActions = [];
    this.streamIndex.clear();
    this.panel = emptyPanel();
    // Force a fresh config read so changed settings take effect.
    this.config = null;
    this.llm = null;
    this.root = null;
    this.emit({ type: "clear" });
    void this.sendInit();
  }

  dispose(): void {
    if (this.currentRuntime) {
      try {
        this.currentRuntime.cancel("extension deactivated");
      } catch {
        /* best effort */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Command handling
  // -------------------------------------------------------------------------

  private async handleCommand(content: string): Promise<void> {
    const [command, ...rest] = content.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (command.toLowerCase()) {
      case "design": {
        if (!arg) {
          this.pendingFilePath = null;
          this.append("assistant", "用法", "`/design <需求文件路径>`，或点击输入框左侧按钮选择文件。");
          return;
        }
        const resolved = this.resolveFile(arg);
        if (!resolved) {
          this.append("error", "文件不存在", `无法找到文件：${arg}`);
          return;
        }
        await this.runWorkflow("design", resolved, resolveOutputDir(this.root!, this.config!, "design"));
        return;
      }
      case "new":
      case "clear":
        this.newSession();
        return;
      case "help":
        this.append("assistant", "帮助", [
          "命令：",
          "- `/design <文件路径>` 运行完整设计流程（需求分析 → 系统设计 → Mermaid 三图 → 测试用例 → 评审）",
          "- `/new` 新建会话",
          "- `/help` 显示本帮助",
          "",
          "直接输入问题即可与助手对话；带文件路径并表达设计意图时会自动触发设计流程。",
        ].join("\n"));
        return;
      default:
        this.append("assistant", "未知命令", `不认识的命令：/${command}。输入 /help 查看可用命令。`);
    }
  }

  // -------------------------------------------------------------------------
  // Conversation coordinator (ported from chatApp.ts)
  // -------------------------------------------------------------------------

  private async applyDecision(decision: ConversationDecision): Promise<void> {
    switch (decision.action) {
      case "run_workflow":
        this.append("status", "对话协调器", [
          `决策：运行 ${decision.goal}`,
          `理由：${decision.reason}`,
          `输入：${decision.input}`,
        ].join("\n"));
        await this.runWorkflow(
          decision.goal,
          decision.input,
          decision.output ?? resolveOutputDir(this.root!, this.config!, decision.goal),
        );
        return;
      case "ask_clarification":
        this.pendingFilePath = decision.filePath;
        this.appendAssistant("需要确认", decision.message);
        return;
      case "respond":
        this.appendAssistant(decision.title, decision.content);
        return;
      default:
        await this.handleChat();
    }
  }

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
        output: resolveOutputDir(this.root!, this.config!, explicitGoal),
        reason: `explicit ${explicitGoal} intent with local file path`,
      };
    }
    return {
      action: "ask_clarification",
      filePath,
      message: [
        `我检测到文件路径：${filePath}`,
        "",
        "想让我做什么？",
        "回复 `design`（或 `1`）运行完整设计流程：需求分析、系统设计、Mermaid 三图与测试用例。",
      ].join("\n"),
    };
  }

  private async decideWorkflowWithLlm(input: string, filePath: string): Promise<ConversationDecision> {
    const prompt = [
      "You are the Conversation Coordinator for a software-design assistant.",
      "Decide whether the user wants to chat, needs clarification, or explicitly wants to run a workflow.",
      "Return JSON only, no Markdown.",
      "",
      "Allowed JSON shape:",
      '{"action":"chat"|"ask_clarification"|"run_workflow","goal":"design"|null,"question":string,"reason":string}',
      "",
      "Policy:",
      "- Never run a workflow from a bare file path alone.",
      "- Run design only when the user explicitly asks for design, architecture, diagrams, drawing, tests, or a full workflow.",
      "- Standalone analysis/extraction workflows are disabled; ask the user to run design for the full workflow.",
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
      const raw = await this.llm!.chat(
        [
          { role: "system", content: "Return strict JSON only. Do not use emoji or icons." },
          { role: "user", content: prompt },
        ],
        undefined,
        undefined,
        true,
      );
      const parsed = this.parseCoordinatorDecision(raw);
      if (!parsed) return this.fallbackFileDecision(input, filePath);
      if (parsed.action === "run_workflow" && parsed.goal === "design") {
        return {
          action: "run_workflow",
          goal: "design",
          input: filePath,
          output: resolveOutputDir(this.root!, this.config!, "design"),
          reason: parsed.reason || "LLM coordinator selected workflow",
        };
      }
      if (parsed.action === "ask_clarification") {
        const fallback = this.fallbackFileDecision(input, filePath);
        const fallbackMessage = fallback.action === "ask_clarification" ? fallback.message : "请回复 design 运行设计。";
        return { action: "ask_clarification", filePath, message: parsed.question || fallbackMessage };
      }
      return { action: "chat" };
    } catch {
      return this.fallbackFileDecision(input, filePath);
    }
  }

  private parseCoordinatorDecision(
    raw: string,
  ): { action?: string; goal?: string | null; question?: string; reason?: string } | null {
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
    const wantsDesign = /^(1|d|design|设计|画图|生成图|完整设计)$/.test(normalized);
    if (wantsDesign) {
      return {
        action: "run_workflow",
        goal: "design",
        input: this.pendingFilePath,
        output: resolveOutputDir(this.root!, this.config!, "design"),
        reason: "user selected design for pending file",
      };
    }
    return null;
  }

  private resolveFollowUpAction(input: string): ConversationDecision | null {
    if (this.followUpActions.length === 0) return null;
    const normalized = input.trim().toLowerCase();
    const action = this.followUpActions.find(
      (item) =>
        normalized === item.id ||
        normalized === `action ${item.id}` ||
        normalized === item.label.toLowerCase(),
    );
    return action?.decision ?? null;
  }

  private detectExplicitWorkflowGoal(input: string, filePath: string): "design" | null {
    const designKeywords =
      /设计|design|架构|architecture|生成|generate|系统|system|画图|diagram|测试|test|完整流程|full workflow/i;
    const lower = input.toLowerCase();
    const intentText = lower.replace(filePath.toLowerCase(), "");
    return designKeywords.test(intentText) ? "design" : null;
  }

  private findExistingFilePath(input: string): string | null {
    const patterns = [
      /["']([^"']+\.(?:md|txt|docx?|pdf|yaml|yml|json))["']/i,
      /(?:(?:[A-Za-z]:[\\/]|\.?[\/\\])\S+\.(?:md|txt|docx?|pdf|yaml|yml|json))/i,
      /\b(\w+[\w-]*\.(?:md|txt|yaml|yml|json))\b/i,
    ];
    for (const pattern of patterns) {
      const match = input.match(pattern);
      if (!match) continue;
      let candidate = match[1] ?? match[0];
      if (candidate.startsWith('"') || candidate.startsWith("'")) {
        candidate = candidate.slice(1, -1);
      }
      const resolved = this.resolveFile(candidate);
      if (resolved) return resolved;
    }
    return null;
  }

  /** Resolve a possibly-relative path against the project root and cwd. */
  private resolveFile(candidate: string): string | null {
    const tries = [candidate];
    if (this.root && !path.isAbsolute(candidate)) {
      tries.push(path.join(this.root, candidate));
    }
    for (const t of tries) {
      if (existsSync(t)) return path.resolve(t);
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Streamed chat response (ported from chatApp.handleChat)
  // -------------------------------------------------------------------------

  private async handleChat(): Promise<void> {
    this.panel.mode = "chat";
    this.panel.runStatus = "chatting";
    this.pushPanel();

    const id = this.nextId();
    this.emit({
      type: "append",
      message: { id, role: "assistant", title: "助手", content: "", variant: "plain" },
    });

    const systemPrompt = [
      "You are ReqDesign-Agent, a multi-agent LLM system for requirements-driven software design, running inside a VSCode sidebar chat.",
      "",
      "## Your Role",
      "- Answer questions about software design, architecture and requirements engineering directly.",
      "- A bare file path is not permission to run design; suggest the /design command or ask what the user wants.",
      "- If asked about capabilities, mention the /design command. Analyze is an internal stage of /design.",
      "- Be concise, technical and action-oriented.",
      "- Respond in the same language the user uses (Chinese -> Chinese, English -> English).",
      "- Use plain text and standard Markdown only; no emoji or decorative icons.",
      "",
      "## Session Memory",
      this.memoryForPrompt(6000),
    ].join("\n");

    const history = this.chatHistory.slice(-18);
    let streamed = "";
    try {
      const response = await this.llm!.chat(
        [{ role: "system", content: systemPrompt }, ...history],
        undefined,
        (chunk) => {
          streamed += chunk;
          this.emit({ type: "stream", id, chunk });
        },
      );
      const finalText = streamed || response;
      if (!streamed && response) {
        this.emit({ type: "stream", id, chunk: response });
      }
      this.chatHistory.push({ role: "assistant", content: finalText });
      this.trimChatHistory();
    } catch (error) {
      const msg = errorText(error);
      this.emit({ type: "stream", id, chunk: `\n\n[错误] ${msg}` });
      this.chatHistory.push({ role: "assistant", content: `[错误] ${msg}` });
    } finally {
      this.panel.runStatus = "idle";
      this.pushPanel();
    }
  }

  // -------------------------------------------------------------------------
  // Workflow run + event translation (ported from workflowBridge.ts)
  // -------------------------------------------------------------------------

  private async runWorkflow(goal: "design", input: string, output: string): Promise<void> {
    this.panel = emptyPanel();
    this.panel.mode = "workflow";
    this.panel.goal = goal;
    this.panel.outputDir = output;
    this.panel.runStatus = "running";
    this.pushPanel();
    this.cancelRequested = false;
    this.append("status", "工作流", `运行 ${goal}\n输入：${input}\n输出：${output}`);

    const runtime = new this.runtimeModule!.MultiAgentRuntime(this.config!);
    this.currentRuntime = runtime;
    try {
      await runtime.run(goal, input, output, {
        onEvent: (event) => this.consumeWorkflowEvent(event),
      });
      if (!this.cancelRequested) {
        this.pushWorkflowCompletion(goal, input, output);
      }
    } finally {
      if (this.currentRuntime === runtime) {
        this.currentRuntime = null;
      }
      this.panel.runStatus = this.cancelRequested ? "cancelled" : "completed";
      this.panel.llmStatus = "idle";
      this.pushPanel();
    }
  }

  private consumeWorkflowEvent(event: WorkflowEvent): void {
    this.updatePanelFromEvent(event);

    if (event.kind === "llm_chunk") {
      this.appendStreamChunk(event);
      return;
    }
    if (event.kind === "worker_heartbeat") {
      this.panel.llmStatus = this.panel.totalTokens > 0 ? "streaming" : "waiting";
      this.pushPanel();
      return;
    }
    if (event.taskId && TASK_CLOSE_KINDS.has(event.kind)) {
      this.closeStreamMessagesForTask(event.taskId);
    }
    if (event.kind === "worker_started" || event.kind === "worker_resumed") {
      const body = [
        `phase:   ${event.phase ?? "-"}`,
        `task:    ${event.taskId ?? "-"}`,
        `type:    ${event.taskType ?? "-"}`,
        `status:  ${event.status ?? "-"}`,
        "",
        "已提交会话，等待模型/工具输出…",
      ].join("\n");
      this.append("status", `Agent ${event.kind === "worker_resumed" ? "resumed" : "started"}`, fence(body), {
        variant: "card",
        collapsed: true,
        subtitle: this.subtitle(event),
      });
      return;
    }
    if (SUPPRESSED_KINDS.has(event.kind)) return;

    if (event.kind === "llm_started") {
      const data = event.data ?? {};
      const tag = String(event.tag ?? "").replace(/^\[|\]$/g, "");
      const provider = String(data.provider ?? "-");
      const model = String(data.model ?? "-");
      const promptChars = Number(data.promptChars ?? 0);
      const roles = ((data.messageRoles as string[]) ?? []).join(" -> ") || "-";
      const preview = String(data.promptPreview ?? "").slice(0, 1200);
      const body = [
        `model:  ${provider}:${model}`,
        `agent:  ${event.phase ?? "-"}`,
        `task:   ${event.taskId ?? "-"} (${event.taskType ?? "-"})`,
        `roles:  ${roles}`,
        `prompt: ${promptChars} chars`,
        "",
        "asking:",
        preview || "-",
      ].join("\n");
      this.append("status", `LLM 请求${tag ? ` ${tag}` : ""}`, fence(body), {
        variant: "card",
        collapsed: true,
        subtitle: this.subtitle(event),
      });
      return;
    }

    if (event.kind === "llm_completed") {
      const data = event.data ?? {};
      const provider = String(data.provider ?? "-");
      const model = String(data.model ?? "-");
      const total = Number(data.totalTokens ?? 0);
      const promptTokens = Number(data.promptTokens ?? 0);
      const completion = Number(data.completionTokens ?? 0);
      const body = [
        `model:    ${provider}:${model}`,
        `response: ${String(data.responseChars ?? 0)} chars`,
        `tokens:   ${total > 0 ? `${promptTokens} + ${completion} = ${total}` : "provider 未上报"}`,
        `status:   ${event.status ?? "-"}`,
      ].join("\n");
      this.append(event.status === "error" ? "error" : "status", "LLM 完成", fence(body), {
        variant: "card",
        collapsed: true,
        subtitle: this.subtitle(event),
      });
      return;
    }

    const role = event.status === "failed" || event.status === "error" || event.kind.endsWith("_failed")
      ? "error"
      : "status";
    const title = `${event.scope === "benchmark" ? "Benchmark" : "Workflow"} ${event.kind.replace(/_/g, " ")}`;
    this.append(role, title, event.message, {
      variant: MILESTONE_KINDS.has(event.kind) ? "plain" : "event",
      subtitle: this.subtitle(event),
    });
  }

  private updatePanelFromEvent(event: WorkflowEvent): void {
    const p = this.panel;
    if (event.scope === "benchmark") p.mode = "benchmark";
    else if (event.scope === "runtime" || event.scope === "llm") p.mode = "workflow";

    if (event.goal) p.goal = event.goal;
    if (event.taskId) p.currentTaskId = event.taskId;
    if (event.phase) p.currentAgent = event.phase;
    if (event.status) p.runStatus = event.status;

    const data = event.data ?? {};
    p.goal = String(data.goal ?? p.goal);
    p.outputDir = String(data.outputDir ?? p.outputDir);
    p.runStatus = String(data.runStatus ?? p.runStatus);
    p.plannedTasks = Number(data.plannedTasks ?? p.plannedTasks);
    p.completedTasks = Number(data.completedTasks ?? p.completedTasks);
    p.runningTasks = Number(data.runningTasks ?? p.runningTasks);
    p.failedTasks = Number(data.failedTasks ?? p.failedTasks);

    if (event.kind === "llm_started") {
      const provider = String(data.provider ?? "");
      const model = String(data.model ?? "");
      if (provider || model) p.currentModel = `${provider || "-"}:${model || "-"}`;
      p.llmStatus = "request sent";
    }
    if (event.kind === "llm_completed") {
      p.totalTokens += Number(data.totalTokens ?? 0);
      p.llmStatus = "completed";
    }
    this.pushPanel();
  }

  private appendStreamChunk(event: WorkflowEvent): void {
    this.panel.llmStatus = "streaming";
    const streamKey = [event.caseName ?? "", event.taskId ?? "no-task", event.tag ?? "llm"].join(":");
    let id = this.streamIndex.get(streamKey);
    if (id === undefined) {
      id = this.nextId();
      this.streamIndex.set(streamKey, id);
      this.emit({
        type: "append",
        message: {
          id,
          role: "assistant",
          title: this.streamTitle(event),
          content: "",
          variant: "stream",
          subtitle: this.subtitle(event),
          active: true,
          collapsed: false,
        },
      });
    }
    this.emit({ type: "stream", id, chunk: event.chunk ?? event.message });
  }

  private closeStreamMessagesForTask(taskId: string): void {
    for (const key of [...this.streamIndex.keys()]) {
      if (key.includes(`:${taskId}:`)) {
        const id = this.streamIndex.get(key)!;
        this.emit({ type: "patch", id, patch: { active: false, collapsed: true } });
        this.streamIndex.delete(key);
      }
    }
  }

  private pushWorkflowCompletion(goal: "design", input: string, output: string): void {
    this.followUpActions.length = 0;
    const artifacts: Record<string, string> = {
      outputDir: output,
      systemDesign: path.join(output, "design", "system_design.md"),
      diagramsDir: path.join(output, "diagrams"),
      tests: path.join(output, "tests", "test_cases.md"),
      report: path.join(output, "summary_report.md"),
    };

    const parts: string[] = ["## 设计完成", "", `输出目录：${output}`, ""];

    const designPath = artifacts.systemDesign;
    let preview = "";
    if (existsSync(designPath)) {
      preview = readFileSync(designPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .slice(0, 16)
        .join("\n");
      parts.push("### 系统设计（节选）", "", preview, "");
    }

    const diagrams: Array<[string, string]> = [
      ["类图", path.join(output, "diagrams", "class_diagram.mmd")],
      ["活动图", path.join(output, "diagrams", "activity_diagram.mmd")],
      ["状态图", path.join(output, "diagrams", "state_diagram.mmd")],
    ];
    for (const [label, file] of diagrams) {
      if (!existsSync(file)) continue;
      const code = readFileSync(file, "utf8").trim();
      if (!code) continue;
      parts.push(`### ${label}`, "", "```mermaid", code, "```", "");
    }

    parts.push(
      "### 产物",
      "",
      `- [系统设计](${toLink(artifacts.systemDesign)})`,
      `- [测试用例](${toLink(artifacts.tests)})`,
      `- [评审报告](${toLink(artifacts.report)})`,
      `- [输出目录](${toLink(artifacts.outputDir)})`,
    );

    const message = parts.join("\n");
    this.workflowMemories.push({
      goal,
      input,
      output,
      artifacts,
      preview,
      completedAt: new Date().toISOString(),
    });
    while (this.workflowMemories.length > 6) this.workflowMemories.shift();
    this.rememberSession(`Workflow completed: ${goal}\ninput: ${input}\noutput: ${output}`);
    this.appendAssistant("", message);
  }

  // -------------------------------------------------------------------------
  // Memory helpers (ported/simplified from state.ts)
  // -------------------------------------------------------------------------

  private memoryForPrompt(maxChars: number): string {
    const structured = this.workflowMemories.slice(-4).map((m) =>
      [
        `Workflow: ${m.goal}`,
        `completedAt: ${m.completedAt}`,
        `input: ${m.input}`,
        `output: ${m.output}`,
        `artifacts: ${JSON.stringify(m.artifacts)}`,
        m.preview ? `preview:\n${m.preview}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const text = [...structured, ...this.sessionMemory.slice(-4)].filter(Boolean).join("\n\n---\n\n");
    return text ? truncate(text, maxChars) : "本会话尚未完成任何工作流产物。";
  }

  private rememberSession(content: string): void {
    this.sessionMemory.push(truncate(content, 4000));
    while (this.sessionMemory.length > 8) this.sessionMemory.shift();
  }

  private trimChatHistory(): void {
    const max = 24;
    if (this.chatHistory.length <= max) return;
    this.chatHistory.splice(0, this.chatHistory.length - max);
  }

  // -------------------------------------------------------------------------
  // Emit helpers
  // -------------------------------------------------------------------------

  private append(
    role: WebviewMessage["role"],
    title: string,
    content: string,
    extras: Partial<Omit<WebviewMessage, "id" | "role" | "title" | "content">> = {},
  ): string {
    const id = this.nextId();
    this.emit({
      type: "append",
      message: { id, role, title, content, variant: "plain", ...extras },
    });
    return id;
  }

  private appendAssistant(title: string, content: string): void {
    this.append("assistant", title, content);
    this.chatHistory.push({ role: "assistant", content: title ? `${title}\n${content}` : content });
    this.trimChatHistory();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.emit({ type: "busy", busy });
  }

  private pushPanel(): void {
    this.emit({ type: "panel", panel: { ...this.panel } });
  }

  private nextId(): string {
    this.idCounter += 1;
    return `m${this.idCounter}`;
  }

  private subtitle(event: WorkflowEvent): string {
    return [event.phase, event.taskId, event.taskType, event.status].filter(Boolean).join(" | ");
  }

  private streamTitle(event: WorkflowEvent): string {
    return (event.tag ?? "stream").replace(/^\[|\]$/g, "") || "stream";
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function readSettingsOverrides(): { provider?: string; model?: string } {
  const cfg = vscode.workspace.getConfiguration("reqdesign");
  return {
    provider: cfg.get<string>("provider") || undefined,
    model: cfg.get<string>("model") || undefined,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function fence(body: string): string {
  return "```text\n" + body + "\n```";
}

/** Encode an absolute path as a link the webview intercepts as openPath. */
function toLink(p: string): string {
  return "reqdesign:open?" + encodeURIComponent(p);
}
