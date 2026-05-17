/**
 * 日志配置模块 — provides a custom Logger with dual output (console + file).
 *
 * All loggers within a run share a single log file via a shared WriteStream.
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
  private readonly _fileStream: fs.WriteStream | null;

  constructor(
    public readonly name: string,
    public level: LogLevel,
    fileStream: fs.WriteStream | null,
  ) {
    this._fileStream = fileStream;
  }

  debug(message: string): void { this._emit("DEBUG", message); }
  info(message: string): void { this._emit("INFO", message); }
  warn(message: string): void { this._emit("WARN", message); }
  error(message: string): void { this._emit("ERROR", message); }

  close(): void { this._fileStream?.end(); }

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

    // Guard against closed stream
    if (this._fileStream && !this._fileStream.destroyed && !this._fileStream.writableEnded) {
      this._fileStream.write(line + "\n");
    }
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const _loggers = new Map<string, Logger>();
let _sharedStream: fs.WriteStream | null = null;
let _globalLevel: LogLevel = "INFO";

/**
 * Initialize the shared log file stream.
 * Call once at program start. All setupLogger() calls share this stream.
 */
export function initSharedLog(
  filePath: string,
  level: string = "INFO",
): void {
  if (_sharedStream && !_sharedStream.destroyed) {
    _sharedStream.end();
  }

  _globalLevel = level.toUpperCase() as LogLevel;

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  _sharedStream = fs.createWriteStream(filePath, {
    encoding: "utf-8",
    flags: "w",
  });

  // Re-bind all existing loggers to the new stream
  for (const [name, old] of _loggers) {
    _loggers.set(name, new Logger(old.name, old.level, _sharedStream));
  }
}

/** Close the shared log stream. Safe to call multiple times. */
export function closeSharedLog(): void {
  if (_sharedStream && !_sharedStream.destroyed) {
    _sharedStream.end();
    _sharedStream = null;
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
  const logger = new Logger(name, resolvedLevel, _sharedStream);
  _loggers.set(name, logger);
  return logger;
}
