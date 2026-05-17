/**
 * 日志配置模块 — provides a custom Logger with dual output (console + file).
 *
 * @module logger
 */

import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Log severity levels, ordered from most to least verbose. */
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

/** Maximum number of retained log files before oldest are pruned. */
const MAX_LOG_FILES = 20;
let consoleLoggingEnabled = true;

export function setConsoleLoggingEnabled(enabled: boolean): void {
  consoleLoggingEnabled = enabled;
}

/**
 * Remove the oldest `reqdesign_*.log` files in `logDir` so that at most
 * `maxFiles` remain.
 */
function cleanupOldLogs(logDir: string, maxFiles: number): void {
  let files: string[];
  try {
    files = fs
      .readdirSync(logDir)
      .filter(
        (f) => f.startsWith("reqdesign_") && f.endsWith(".log"),
      )
      .sort();
  } catch {
    return;
  }

  while (files.length > maxFiles) {
    const oldest = files.shift()!;
    try {
      fs.unlinkSync(path.join(logDir, oldest));
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

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

/**
 * Simple logger that writes to both the console and a log file.
 *
 * Construct via the {@link setupLogger} factory function.
 */
export class Logger {
  /** Active handlers created by `setupLogger` (used for teardown). */
  private readonly _fileStream: fs.WriteStream | null;

  constructor(
    /** Logger name (included in every line). */
    public readonly name: string,
    /** Minimum level that will actually be emitted. */
    public level: LogLevel,
    fileStream: fs.WriteStream | null,
  ) {
    this._fileStream = fileStream;
  }

  // -- public API -----------------------------------------------------------

  /** Log a DEBUG-level message. */
  debug(message: string): void {
    this._emit("DEBUG", message);
  }

  /** Log an INFO-level message. */
  info(message: string): void {
    this._emit("INFO", message);
  }

  /** Log a WARN-level message. */
  warn(message: string): void {
    this._emit("WARN", message);
  }

  /** Log an ERROR-level message. */
  error(message: string): void {
    this._emit("ERROR", message);
  }

  /** Close the underlying file stream (if any). */
  close(): void {
    this._fileStream?.end();
  }

  // -- internals ------------------------------------------------------------

  private _emit(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
      return;
    }

    const line = formatMessage(level, this.name, message);

    // Console
    if (consoleLoggingEnabled) {
      if (level === "ERROR") {
        process.stderr.write(line + "\n");
      } else {
        process.stdout.write(line + "\n");
      }
    }

    // File
    this._fileStream?.write(line + "\n");
  }
}

// ---------------------------------------------------------------------------
// Module cache (idempotent setup)
// ---------------------------------------------------------------------------

/** Map of logger name → Logger instance (only one per name). */
const _loggers = new Map<string, Logger>();

/**
 * Create (or retrieve) a unified {@link Logger} that writes to both the
 * console and a timestamped log file under `logDir`.
 *
 * Calling this function again with the same `name` will close the previous
 * file stream and create a fresh one (matching the Python sentinel-based
 * handler replacement behaviour).
 *
 * @param name   - Logger name (default `"reqdesign"`).
 * @param level  - Minimum severity level as a string (default `"INFO"`).
 * @param logDir - Directory for log files (default `"logs/"`).
 * @returns A configured {@link Logger} instance.
 */
export function setupLogger(
  name = "reqdesign",
  level: string = "INFO",
  logDir = "logs/",
): Logger {
  // Close & discard any previous logger with this name
  const existing = _loggers.get(name);
  if (existing) {
    existing.close();
  }

  const normalisedLevel = level.toUpperCase() as LogLevel;

  // Ensure the log directory exists
  fs.mkdirSync(logDir, { recursive: true });

  // Prune old log files
  cleanupOldLogs(logDir, MAX_LOG_FILES);

  // Build timestamp & pid string for the filename
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${pad(now.getMilliseconds(), 3)}`;
  const logFile = path.join(
    logDir,
    `reqdesign_${dateStr}_${process.pid}.log`,
  );

  const fileStream = fs.createWriteStream(logFile, {
    encoding: "utf-8",
    flags: "w", // overwrite — safe even if filename collides
  });

  // Best-effort permission restriction (Unix only)
  try {
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Windows / unsupported — ignore
  }

  const logger = new Logger(name, normalisedLevel, fileStream);
  _loggers.set(name, logger);
  return logger;
}
