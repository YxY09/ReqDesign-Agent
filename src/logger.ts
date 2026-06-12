/**
 * 日志配置模块——提供双输出（控制台 + 文件）的自定义 Logger。
 *
 * 一次运行中的所有 logger 共享同一个日志文件路径。
 * 日志文件通过 initSharedLog() 在 logs/ 目录中创建。
 *
 * @module logger
 */

import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let consoleLoggingEnabled = true;

export function setConsoleLoggingEnabled(enabled: boolean): void {
  consoleLoggingEnabled = enabled;
}

function formatMessage(
  level: LogLevel,
  name: string,
  message: string,
): string {
  const now = new Date();
  const ts = now.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  return `[${ts}] ${level} ${name} - ${message}`;
}

// ---------------------------------------------------------------------------
// Logger class
// ---------------------------------------------------------------------------

export class Logger {
  constructor(
    public readonly name: string,
    public level: LogLevel,
  ) {}

  debug(message: string): void { this._emit("DEBUG", message); }
  info(message: string): void { this._emit("INFO", message); }
  warn(message: string): void { this._emit("WARN", message); }
  error(message: string): void { this._emit("ERROR", message); }

  close(): void {
    // Logger 实例是共享日志文件的轻量句柄。
    // 关闭一个 logger 不应关闭整个进程的日志记录。
  }

  private _emit(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const line = formatMessage(level, this.name, message);

    if (consoleLoggingEnabled) {
      if (level === "ERROR") {
        process.stderr.write(line + "\n");
      } else {
        process.stdout.write(line + "\n");
      }
    }

    if (_sharedLogFilePath) {
      try {
        fs.appendFileSync(_sharedLogFilePath, line + "\n", { encoding: "utf8" });
      } catch {
        // 日志记录绝不能导致主工作流程失败。
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 模块状态
// ---------------------------------------------------------------------------

const _loggers = new Map<string, Logger>();
let _sharedLogFilePath: string | null = null;
let _globalLevel: LogLevel = "INFO";

/**
 * 初始化共享日志文件流。
 * 在程序启动时调用一次。所有 setupLogger() 调用共享此流。
 */
export function initSharedLog(
  filePath: string,
  level: string = "INFO",
): void {
  _globalLevel = level.toUpperCase() as LogLevel;

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(filePath, "", { encoding: "utf8", flag: "w" });
  _sharedLogFilePath = filePath;
}

/** 关闭共享日志流。可以安全地多次调用。 */
export function closeSharedLog(): void {
  _sharedLogFilePath = null;
}

/**
 * 直接向共享日志文件写入原始行（无时间戳/级别前缀）。
 * 用于工作流事件、流式块和绕过 Logger 类但仍应出现在
 * 日志文件中的最终摘要。
 */
export function writeToSharedLog(line: string): void {
  if (!_sharedLogFilePath) return;
  try {
    fs.appendFileSync(_sharedLogFilePath, line + "\n", { encoding: "utf8" });
  } catch {
    // 绝不让日志记录导致主工作流程失败。
  }
}

/**
 * 创建（或获取）写入共享日志文件的 Logger。
 */
export function setupLogger(
  name = "reqdesign",
  level?: string,
): Logger {
  const existing = _loggers.get(name);
  if (existing) {
    return existing;
  }

  const resolvedLevel = (level?.toUpperCase() as LogLevel) ?? _globalLevel;
  const logger = new Logger(name, resolvedLevel);
  _loggers.set(name, logger);
  return logger;
}
