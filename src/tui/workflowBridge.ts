/**
 * Workflow bridge: builds + runs the MultiAgentRuntime / BenchmarkRunnerV2,
 * translates WorkflowEvents into UI messages, throttles streaming renders, and
 * handles cancellation.
 *
 * This module has zero dependence on stdin/ANSI — it only mutates shared state
 * and asks the renderer to paint. That makes it reusable for a future VSCode
 * extension: replace the renderer/state plumbing with an LSP-style view.
 *
 * Bug fixes applied here:
 *  - #3: benchmark gold/cases dirs come from config instead of a hard-coded path
 *  - #4: streaming chunks / workflow events request a throttled render instead
 *    of forcing a full redraw on every token
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BenchmarkRunnerV2 } from "../benchmark/benchmarkRunner.js";
import { MultiAgentRuntime } from "../runtime.js";
import type { WorkflowEvent } from "../workflowEvents.js";
import {
  compactValue,
  defaultPanelState,
  estimateTokens,
  pushAssistantMessage,
  pushMessage,
  rememberSession,
  sanitizeTerminalText,
  type ChatState,
  type UiMessage,
} from "./state.js";
import type { Renderer } from "./renderer.js";

export class WorkflowBridge {
  private readonly state: ChatState;
  private readonly renderer: Renderer;
  private activityRefreshTimer: NodeJS.Timeout | null = null;

  constructor(state: ChatState, renderer: Renderer) {
    this.state = state;
    this.renderer = renderer;
  }

  /** Stop any activity-refresh timer on shutdown. */
  dispose(): void {
    this.stopActivityRefreshTimer();
  }

  // -------------------------------------------------------------------------
  // Run commands
  // -------------------------------------------------------------------------

  async runWorkflowCommand(goal: "design", input: string, output: string): Promise<void> {
    const state = this.state;
    this.resetWorkflowPanel();
    state.panel.mode = "workflow";
    state.panel.goal = goal;
    state.panel.outputDir = output;
    state.panel.runStatus = "running";
    state.cancelRequested = false;
    pushMessage(state, "status", "Workflow", `Running ${goal}\nInput: ${input}\nOutput: ${output}`);

    const runtime = new MultiAgentRuntime(state.config);
    state.currentRuntime = runtime;
    try {
      await runtime.run(goal, input, output, {
        onEvent: (event) => this.consumeWorkflowEvent(event),
      });
      if (!state.cancelRequested) {
        this.pushWorkflowCompletionGuide(goal, input, output);
      }
    } finally {
      if (state.currentRuntime === runtime) {
        state.currentRuntime = null;
      }
    }
  }

  async runBenchmarkCommand(casesDir: string, outputDir: string): Promise<void> {
    const state = this.state;
    const benchmark = state.config.benchmark;
    this.resetWorkflowPanel();
    state.panel.mode = "benchmark";
    state.panel.outputDir = outputDir;
    state.panel.runStatus = "running";
    pushMessage(state, "status", "Benchmark", `Cases: ${casesDir}\nOutput: ${outputDir}`);

    const runner = new BenchmarkRunnerV2(
      state.config,
      casesDir || benchmark.casesDir,
      benchmark.goldDir,
      (config) => new MultiAgentRuntime(config),
    );
    await runner.run({
      mode: "dev",
      numRuns: 1,
      resume: false,
      onlyFailed: false,
      resultsBaseDir: outputDir,
      onEvent: (event) => this.consumeWorkflowEvent(event),
    });
  }

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  requestCancelWorkflow(reason: string): void {
    const state = this.state;
    if (!state.currentRuntime) {
      pushMessage(state, "status", "Cancel", "No active workflow is running.");
      return;
    }
    if (state.cancelRequested) {
      pushMessage(state, "status", "Cancel", "Cancellation is already requested. Waiting for the active model call to return.");
      return;
    }
    state.cancelRequested = true;
    state.panel.runStatus = "cancelling";
    state.panel.llmStatus = "cancelling";
    state.currentRuntime.cancel(reason);
    pushMessage(state, "status", "Cancel Requested", [
      reason,
      "The active LLM call may not stop immediately if the provider does not support aborting in-flight requests.",
    ].join("\n"));
  }

  /** Exposed so the future VSCode bridge can drive the same cancel path. */
  cancelCurrent(reason: string): void {
    this.requestCancelWorkflow(reason);
  }

  private resetWorkflowPanel(): void {
    const next = defaultPanelState();
    Object.assign(this.state.panel, next);
  }

  // -------------------------------------------------------------------------
  // Workflow completion guide (analyze branch removed — bug #5)
  // -------------------------------------------------------------------------

  private pushWorkflowCompletionGuide(goal: "design", input: string, output: string): void {
    const state = this.state;
    state.followUpActions.length = 0;
    const lines: string[] = [
      `goal: ${goal}`,
      `input: ${input}`,
      `output: ${output}`,
    ];
    const artifacts: Record<string, string> = {};
    let preview = "";

    if (goal === "design") {
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
      state.followUpActions.push({
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
    state.workflowMemories.push({
      goal,
      input,
      output,
      artifacts,
      preview,
      completedAt: new Date().toISOString(),
    });
    while (state.workflowMemories.length > 6) {
      state.workflowMemories.shift();
    }
    rememberSession(state, [
      `Workflow completed: ${goal}`,
      `input: ${input}`,
      `output: ${output}`,
      `artifacts: ${JSON.stringify(artifacts)}`,
      summary,
    ].join("\n"));
    pushAssistantMessage(state, "Workflow Summary", summary);
  }

  // -------------------------------------------------------------------------
  // Workflow event → UI translation
  // -------------------------------------------------------------------------

  private consumeWorkflowEvent(event: WorkflowEvent): void {
    const state = this.state;
    this.updatePanelFromEvent(event);

    // --- 流式 LLM 块：追加到实时流卡片 ---
    if (event.kind === "llm_chunk") {
      this.appendStreamChunk(event);
      return;
    }

    // --- 心跳：刷新运行时活跃状态，不添加转录噪音。 ---
    if (event.kind === "worker_heartbeat") {
      state.panel.lastHeartbeatAt = Date.now();
      state.panel.llmStatus = state.panel.llmChunkCount > 0 ? "streaming" : "waiting first chunk";
      this.renderer.requestRender();
      return;
    }

    // --- 任务完成时关闭流卡片 ---
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

    // --- Worker 生命周期：保持可见，以便左侧面板显示代理正在执行的操作。 ---
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
      pushMessage(state, "status", `Agent ${event.kind === "worker_resumed" ? "resumed" : "started"}`, body, {
        variant: "plain",
        subtitle: this.workflowEventSubtitle(event),
      });
      return;
    }

    // --- 过滤掉不属于转录的嘈杂内部事件 ---
    const suppressedKinds = new Set([
      "worker_heartbeat",       // 上方已处理，此处仅作双重检查
      "artifact_saved",         // 保存成功是预期行为，无需关注
      "input_loaded",           // 实现细节
      "planning_started",       // 由 planning_completed 替代
      "evaluation_started",     // 由 evaluation_completed 替代
      "persist_started",        // 由 persist_completed 替代
      "repair_round_started",   // 由 repair_round_completed 替代
      "repair_started",         // 由 repair_completed 替代
      "repair_task_started",    // 由 repair_task_completed 替代
      "task_started",           // 由 llm_started 替代，后者显示实际提示词
    ]);
    if (suppressedKinds.has(event.kind)) {
      return;
    }

    // --- LLM 启动：显示提示词上下文为卡片 ---
    if (event.kind === "llm_started") {
      const data = event.data ?? {};
      const tag = String(event.tag ?? "").replace(/^\[|\]$/g, "");
      const promptChars = data.promptChars ?? 0;
      const messageRoles = (data.messageRoles as string[]) ?? [];
      const preview = sanitizeTerminalText(String(data.promptPreview ?? ""));

      const providerModel = `${String(data.provider ?? "-")}:${String(data.model ?? "-")}`;
      state.panel.activeLlmStartedAt = Date.now();
      state.panel.lastLlmChunkAt = 0;
      state.panel.llmChunkCount = 0;
      state.panel.llmStatus = "request sent, waiting first chunk";
      state.panel.activeSessionId = event.sessionId ?? state.panel.activeSessionId;
      this.ensureActivityRefreshTimer();

      // 保留足够的提示文本以使模型请求可理解，
      // 但不要让一个提示占据整个视口。
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
      state.messages.push(msg);
      this.renderer.pinScroll();
      this.renderer.requestRender();
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
      state.panel.llmStatus = event.status === "error" ? "failed" : "completed";
      this.stopActivityRefreshTimer();
      pushMessage(state, event.status === "error" ? "error" : "status", "LLM completed", body, {
        variant: "event",
        subtitle: this.workflowEventSubtitle(event),
      });
      return;
    }

    // --- 确定角色及其是否为里程碑 ---
    const role: UiMessage["role"] = event.status === "failed" || event.status === "error" || event.kind.endsWith("_failed")
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

    pushMessage(state, role, this.workflowEventTitle(event), event.message, {
      variant: isMilestone ? "plain" : "event",
      subtitle: this.workflowEventSubtitle(event),
    });
  }

  private updatePanelFromEvent(event: WorkflowEvent): void {
    const state = this.state;
    const panel = state.panel;
    if (event.scope === "benchmark") {
      panel.mode = "benchmark";
    } else if (event.scope === "runtime" || event.scope === "llm") {
      panel.mode = "workflow";
    }

    if (event.goal) panel.goal = event.goal;
    if (event.caseName) panel.currentCase = event.caseName;
    if (event.taskId) panel.currentTaskId = event.taskId;
    if (event.taskType) panel.currentTaskType = event.taskType;
    if (event.tag) panel.lastStreamTag = event.tag;
    if (event.phase) panel.currentAgent = event.phase;
    if (event.status) panel.runStatus = event.status;

    const data = event.data ?? {};
    panel.goal = String(data.goal ?? panel.goal);
    panel.outputDir = String(data.outputDir ?? panel.outputDir);
    panel.runStatus = String(data.runStatus ?? panel.runStatus);
    panel.qualityStatus = String(data.qualityStatus ?? panel.qualityStatus);
    panel.persistStatus = String(data.persistStatus ?? panel.persistStatus);
    panel.totalArtifacts = Number(data.totalArtifacts ?? panel.totalArtifacts);
    panel.plannedTasks = Number(data.plannedTasks ?? panel.plannedTasks);
    panel.completedTasks = Number(data.completedTasks ?? panel.completedTasks);
    panel.runningTasks = Number(data.runningTasks ?? panel.runningTasks);
    panel.pendingTasks = Number(data.pendingTasks ?? panel.pendingTasks);
    panel.blockedTasks = Number(data.blockedTasks ?? panel.blockedTasks);
    panel.failedTasks = Number(data.failedTasks ?? panel.failedTasks);
    panel.readyTasks = Number(data.readyTasks ?? panel.readyTasks);

    if (event.kind === "llm_started") {
      const provider = String(data.provider ?? "");
      const model = String(data.model ?? "");
      panel.currentModel = provider || model ? `${provider || "-"}:${model || "-"}` : panel.currentModel;
      panel.currentPromptPreview = String(data.promptPreview ?? panel.currentPromptPreview);
      panel.activeSessionId = event.sessionId ?? panel.activeSessionId;
    }
    if (event.kind === "llm_completed") {
      panel.promptTokens = Number(data.promptTokens ?? panel.promptTokens);
      panel.completionTokens = Number(data.completionTokens ?? panel.completionTokens);
      panel.totalTokens = Number(data.totalTokens ?? panel.totalTokens);
    }

    if (event.kind === "benchmark_started") {
      panel.benchmarkTotal = Number(data.totalCases ?? panel.benchmarkTotal);
      panel.benchmarkDone = 0;
      panel.benchmarkPassed = 0;
      panel.benchmarkFailed = 0;
      panel.benchmarkError = 0;
    }
    if (event.kind === "benchmark_case_completed") {
      panel.benchmarkDone += 1;
      if (event.status === "completed") {
        panel.benchmarkPassed += 1;
      } else if (event.status === "error") {
        panel.benchmarkError += 1;
      } else {
        panel.benchmarkFailed += 1;
      }
    }

    const recent = `${event.scope}/${event.kind}${event.taskId ? ` ${event.taskId}` : ""}${event.caseName ? ` ${event.caseName}` : ""}`;
    panel.recentEvents = [...panel.recentEvents.slice(-7), recent];
    this.renderer.requestRender();
  }

  /** Append a streaming token to the live stream card (throttled render — bug #4). */
  private appendStreamChunk(event: WorkflowEvent): void {
    const state = this.state;
    const panel = state.panel;
    panel.lastLlmChunkAt = Date.now();
    panel.llmChunkCount += 1;
    panel.llmStatus = "streaming";
    const streamKey = [
      event.caseName ?? "",
      event.taskId ?? "no-task",
      event.tag ?? "llm",
    ].join(":");

    let index = state.streamMessageIndex.get(streamKey);
    if (index === undefined) {
      index = state.messages.length;
      state.messages.push({
        role: "assistant",
        title: this.streamTitle(event),
        content: "",
        variant: "stream",
        subtitle: this.streamSubtitle(event),
        active: true,
        collapsed: false,
      });
      state.streamMessageIndex.set(streamKey, index);
    } else {
      state.messages[index].subtitle = this.streamSubtitle(event);
      state.messages[index].active = true;
      state.messages[index].collapsed = false;
    }

    state.messages[index].content += event.chunk ?? event.message;
    this.renderer.pinScroll();
    this.renderer.requestRender();
  }

  private closeStreamMessagesForTask(taskId: string): void {
    const state = this.state;
    for (const key of [...state.streamMessageIndex.keys()]) {
      if (key.includes(`:${taskId}:`)) {
        const messageIndex = state.streamMessageIndex.get(key);
        if (messageIndex !== undefined) {
          state.messages[messageIndex].active = false;
          state.messages[messageIndex].collapsed = true;
        }
        state.streamMessageIndex.delete(key);
      }
    }
  }

  private ensureActivityRefreshTimer(): void {
    if (this.activityRefreshTimer) return;
    this.activityRefreshTimer = setInterval(() => {
      if (!this.state.busy && this.state.panel.llmStatus !== "request sent, waiting first chunk") {
        this.stopActivityRefreshTimer();
        return;
      }
      this.renderer.requestRender();
    }, 1000);
  }

  private stopActivityRefreshTimer(): void {
    if (!this.activityRefreshTimer) return;
    clearInterval(this.activityRefreshTimer);
    this.activityRefreshTimer = null;
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
}

