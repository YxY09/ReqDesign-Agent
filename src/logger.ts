/**
 * 日志配置模块 — provides a custom Logger with dual output (console + file).
 *
 * All loggers within a run share a single log file path.
 * The log file is created in the logs/ directory via initSharedLog().
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
    // Logger instances are lightweight handles over the shared log file.
    // Closing one logger must not close logging for the whole process.
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
        // Logging must never fail the main workflow.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const _loggers = new Map<string, Logger>();
let _sharedLogFilePath: string | null = null;
let _globalLevel: LogLevel = "INFO";

/**
 * Initialize the shared log file stream.
 * Call once at program start. All setupLogger() calls share this stream.
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

/** Close the shared log stream. Safe to call multiple times. */
export function closeSharedLog(): void {
  _sharedLogFilePath = null;
}

/**
 * Write a raw line directly to the shared log file (no timestamp/level prefix).
 * Used by workflow events, streaming chunks, and final summaries that bypass
 * the Logger class but should still appear in the log file.
 */
export function writeToSharedLog(line: string): void {
  if (!_sharedLogFilePath) return;
  try {
    fs.appendFileSync(_sharedLogFilePath, line + "\n", { encoding: "utf8" });
  } catch {
    // Never let logging fail the main workflow.
  }
}

/**
 * Create (or retrieve) a Logger that writes to the shared log file.
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
