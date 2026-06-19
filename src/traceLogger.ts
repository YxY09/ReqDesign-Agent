/**
 * 全链路追踪日志模块。
 *
 * 源自 governance/trace_logger.py。
 *
 * 提供 TraceLogger 用于记录执行追踪。
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Logger, setupLogger } from "./logger.js";

export interface TraceEntryData {
  timestamp: number;
  stage: string;
  eventType: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// TraceLogger（追踪日志器）
// ---------------------------------------------------------------------------

export class TraceLogger {
  static readonly MAX_ENTRIES = 5000;

  entries: TraceEntryData[] = [];
  outputDir: string;
  private readonly _logger: Logger;
  private _persistPath: string = "";

  constructor(outputDir = "") {
    this.outputDir = outputDir;
    this._logger = setupLogger("reqdesign.trace");
  }

  /** 设置自动刷新的文件路径。设置后，每次 log() 调用都会写入磁盘。 */
  setPersistPath(path: string): void {
    this._persistPath = path;
  }

  /** 记录一条追踪条目。 */
  log(
    stage: string,
    eventType: string,
    data: Record<string, unknown> = {},
  ): void {
    const entry: TraceEntryData = {
      timestamp: Date.now() / 1000,
      stage,
      eventType,
      data: data ?? {},
    };
    this.entries.push(entry);
    if (this.entries.length > TraceLogger.MAX_ENTRIES) {
      this.entries = this.entries.slice(-TraceLogger.MAX_ENTRIES);
    }
    this._logger.debug(
      `[追踪] ${stage}/${eventType}: ${summarizeData(data)}`,
    );

    // 设置了持久化路径时自动刷新到磁盘
    if (this._persistPath) {
      this._flushToDisk();
    }
  }

  /** 记录一次 LLM 调用。 */
  logLlmCall(
    stage: string,
    method: string,
    messages: Record<string, unknown>[],
    result: string,
    duration: number,
  ): void {
    let inputChars = 0;
    for (const m of messages) {
      if (typeof m === "object" && m !== null) {
        inputChars += String(m["content"] ?? "").length;
      }
    }
    const outputChars = result != null ? result.length : 0;

    this.log(stage, "llm_call", {
      method,
      input_messages: messages.length,
      input_chars: inputChars,
      output_chars: outputChars,
      output_text: outputChars <= 50000 ? result : result.slice(0, 50000),
      duration_seconds: Math.round(duration * 1000) / 1000,
    });
  }

  /** 记录验证结果。 */
  logValidation(
    stage: string,
    isValid: boolean,
    errors: string[],
    warnings: string[],
    score: number,
  ): void {
    this.log(stage, "validation", {
      is_valid: isValid,
      errors,
      warnings,
      score,
    });
  }

  /** 记录修复操作。 */
  logRepair(
    stage: string,
    attempt: number,
    error: string,
    action: string,
    success: boolean,
  ): void {
    this.log(stage, "repair", {
      attempt,
      error,
      action,
      success,
    });
  }

  /** 记录门控决策。 */
  logGateDecision(stage: string, decision: string, reason = ""): void {
    this.log(stage, "gate_decision", {
      decision,
      reason,
    });
  }

  /** 记录人工输入。 */
  logHumanInput(stage: string, action: string, feedback = ""): void {
    this.log(stage, "human_input", {
      action,
      feedback,
    });
  }

  /** 记录阶段开始。 */
  logStageStart(stage: string): void {
    this.log(stage, "stage_start");
  }

  /** 记录阶段结束。 */
  logStageEnd(stage: string, status: string, duration: number): void {
    this.log(stage, "stage_end", {
      status,
      duration_seconds: Math.round(duration * 1000) / 1000,
    });
  }

  /** 按阶段和/或事件类型筛选追踪条目。 */
  getEntries(stage?: string, eventType?: string): TraceEntryData[] {
    let result = this.entries;
    if (stage) {
      result = result.filter((e) => e.stage === stage);
    }
    if (eventType) {
      result = result.filter((e) => e.eventType === eventType);
    }
    return result;
  }

  /** 获取追踪活动的摘要。 */
  getSummary(): Record<string, unknown> {
    const stages: Record<
      string,
      { events: number; llmCalls: number; validations: number; repairs: number }
    > = {};

    for (const e of this.entries) {
      if (!stages[e.stage]) {
        stages[e.stage] = { events: 0, llmCalls: 0, validations: 0, repairs: 0 };
      }
      stages[e.stage].events++;
      if (e.eventType === "llm_call") stages[e.stage].llmCalls++;
      else if (e.eventType === "validation") stages[e.stage].validations++;
      else if (e.eventType === "repair") stages[e.stage].repairs++;
    }

    return {
      total_entries: this.entries.length,
      stages,
    };
  }

  /** 将追踪记录导出为 JSON 字符串。可选择写入文件。 */
  exportJson(path?: string): string {
    const data = {
      summary: this.getSummary(),
      entries: this.entries,
    };

    let jsonStr: string;
    try {
      jsonStr = JSON.stringify(data, null, 2);
    } catch {
      jsonStr = JSON.stringify(data, (_key, value) => {
        if (typeof value === "bigint" || typeof value === "function") {
          return String(value);
        }
        return value;
      }, 2);
    }

    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, jsonStr, { encoding: "utf8" });
      this._logger.info(`追踪记录已导出: ${path}`);
    }

    return jsonStr;
  }

// -------------------------------------------------------------------
// 持久化
// -------------------------------------------------------------------

  /** 将当前追踪写入磁盘（设置 persistPath 后自动调用）。 */
  private _flushToDisk(): void {
    try {
      const data = {
        summary: this.getSummary(),
        entries: this.entries,
      };
      const jsonStr = JSON.stringify(data, null, 2);
      mkdirSync(dirname(this._persistPath), { recursive: true });
      writeFileSync(this._persistPath, jsonStr, { encoding: "utf8" });
    } catch {
      // 追踪刷新不能导致主工作流失败
    }
  }

  /** 清除所有追踪条目。 */
  clear(): void {
    this.entries.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers（辅助函数）
// ---------------------------------------------------------------------------

function summarizeData(data: Record<string, unknown> | null, maxLen = 100): string {
  if (data == null) return "";
  const s = String(data);
  if (s.length > maxLen) {
    return s.slice(0, maxLen) + "...";
  }
  return s;
}
