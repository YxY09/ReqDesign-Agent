/**
 * Configuration management module.
 *
 * Ported from reqdesign/config.py (Phase 2).
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseAndValidate } from "./configSchema.js";

// ---------------------------------------------------------------------------
// YAML snake_case → camelCase conversion
// ---------------------------------------------------------------------------

/** Recursively convert snake_case keys to camelCase in an object. */
function snakeToCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(snakeToCamel);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = key.includes("_")
        ? key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
        : key;
      result[camelKey] = snakeToCamel(value);
    }
    return result;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Interfaces for sub-configs
// ---------------------------------------------------------------------------

/** LLM provider settings. */
export interface LLMConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  timeout: number;
}

/** Retry behaviour settings. */
export interface RetryConfig {
  maxRetries: number;
  retryDelayMs: number;
  maxDelayMs: number;
  retryOnTimeout: boolean;
}

/** Output directory settings. */
export interface OutputConfig {
  defaultDir: string;
}

/** Logging settings. */
export interface LoggingConfig {
  level: string;
  logDir: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VALID_PROVIDERS = [
  "openai",
  "anthropic",
  "deepseek",
  "qwen",
  "minimax",
] as const;

export const VALID_LOG_LEVELS = [
  "DEBUG",
  "INFO",
  "WARNING",
  "ERROR",
  "CRITICAL",
] as const;

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

const _dotenvLoadedPaths = new Set<string>();

/**
 * Load key=value pairs from a `.env` file without overriding existing
 * environment variables.
 */
function loadDotenv(dotenvDir?: string): void {
  const candidates: string[] = [];
  if (dotenvDir) {
    candidates.push(resolve(dotenvDir, ".env"));
  }
  candidates.push(resolve(process.cwd(), ".env"));

  // Deduplicate while preserving order
  const seen = new Set<string>();
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);

    if (_dotenvLoadedPaths.has(p) || !existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf-8");
      for (const rawLine of raw.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) continue;
        const eqIdx = line.indexOf("=");
        const key = line.slice(0, eqIdx).trim();
        let value = line.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (key && !(key in process.env)) {
          process.env[key] = value;
        }
      }
      _dotenvLoadedPaths.add(p);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[reqdesign] .env load failed: ${p}: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Defaults helpers
// ---------------------------------------------------------------------------

function defaultLLMConfig(): LLMConfig {
  return {
    provider: "openai",
    model: "gpt-4o",
    apiKey: "",
    baseUrl: "",
    temperature: 0.3,
    maxTokens: 8192,
    timeout: 120,
  };
}

function defaultRetryConfig(): RetryConfig {
  return {
    maxRetries: 3,
    retryDelayMs: 1000,
    maxDelayMs: 30_000,
    retryOnTimeout: true,
  };
}

function defaultOutputConfig(): OutputConfig {
  return { defaultDir: "outputs/" };
}

function defaultLoggingConfig(): LoggingConfig {
  return { level: "INFO", logDir: "logs/" };
}

// ---------------------------------------------------------------------------
// AgentConfig class
// ---------------------------------------------------------------------------

/**
 * Top-level configuration for the agent system.
 *
 * Load from YAML via {@link AgentConfig.loadFromYaml} or construct manually.
 */
export class AgentConfig {
  llm: LLMConfig;
  retry: RetryConfig;
  output: OutputConfig;
  logging: LoggingConfig;
  /** Raw YAML data (API keys are redacted). */
  raw: Record<string, unknown>;

  constructor(opts?: {
    llm?: LLMConfig;
    retry?: RetryConfig;
    output?: OutputConfig;
    logging?: LoggingConfig;
    raw?: Record<string, unknown>;
  }) {
    this.llm = opts?.llm ?? defaultLLMConfig();
    this.retry = opts?.retry ?? defaultRetryConfig();
    this.output = opts?.output ?? defaultOutputConfig();
    this.logging = opts?.logging ?? defaultLoggingConfig();
    this.raw = opts?.raw ?? {};
  }

  // -----------------------------------------------------------------------
  // YAML loading
  // -----------------------------------------------------------------------

  /**
   * Load configuration from a YAML file.
   *
   * @param path - Absolute or relative path to the YAML config file.
   * @throws {Error} If the file does not exist or cannot be parsed.
   */
  static loadFromYaml(path: string): AgentConfig {
    const absPath = resolve(path);
    if (!existsSync(absPath)) {
      throw new Error(`Config file not found: ${absPath}`);
    }

    loadDotenv(dirname(absPath));

    const fileContents = readFileSync(absPath, "utf-8");
    const data = parseYaml(fileContents) as Record<string, unknown> | null;

    if (!data || typeof data !== "object") {
      console.warn(`[reqdesign] Config file is empty: ${absPath}, using defaults`);
      return new AgentConfig();
    }

    // Store raw config but redact API keys
    const safeRaw: Record<string, unknown> = structuredClone(data);
    if (
      typeof safeRaw.llm === "object" &&
      safeRaw.llm !== null &&
      "api_key" in (safeRaw.llm as Record<string, unknown>)
    ) {
      (safeRaw.llm as Record<string, unknown>).api_key = "***";
    }

    // Zod 严格验证 — 失败时 throw，不再 warn
    // Convert YAML snake_case keys → camelCase before schema validation
    const camelData = snakeToCamel(data);
    const parsed = parseAndValidate(camelData);

    const config = new AgentConfig({
      llm: {
        provider: parsed.llm.provider,
        model: parsed.llm.model,
        apiKey: parsed.llm.apiKey ?? "",
        baseUrl: parsed.llm.baseUrl ?? "",
        temperature: parsed.llm.temperature,
        maxTokens: parsed.llm.maxTokens,
        timeout: parsed.llm.timeout,
      },
      retry: {
        maxRetries: parsed.retry.maxRetries,
        retryDelayMs: parsed.retry.retryDelayMs,
        maxDelayMs: parsed.retry.maxDelayMs,
        retryOnTimeout: parsed.retry.retryOnTimeout,
      },
      output: {
        defaultDir: parsed.output.defaultDir,
      },
      logging: {
        level: parsed.logging.level,
        logDir: parsed.logging.logDir,
      },
      raw: safeRaw,
    });
    console.info(
      `[reqdesign] Config loaded: provider=${config.llm.provider}, model=${config.llm.model}`,
    );

    return config;
  }

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  /**
   * Validate the current configuration.
   * @returns An array of error strings (empty when valid).
   */
  validate(): string[] {
    const errors: string[] = [];

    if (!this.llm.provider) {
      errors.push("llm.provider must not be empty");
    } else if (!(VALID_PROVIDERS as readonly string[]).includes(this.llm.provider)) {
      errors.push(
        `llm.provider '${this.llm.provider}' is not supported. Valid: ${VALID_PROVIDERS.join(", ")}`,
      );
    }

    if (!this.llm.model) {
      errors.push("llm.model must not be empty");
    }

    if (typeof this.llm.temperature !== "number" || isNaN(this.llm.temperature)) {
      errors.push("llm.temperature must be a number");
    } else if (this.llm.temperature < 0 || this.llm.temperature > 2) {
      errors.push("llm.temperature must be between 0 and 2");
    }

    if (typeof this.llm.maxTokens !== "number" || isNaN(this.llm.maxTokens)) {
      errors.push("llm.maxTokens must be a number");
    } else if (this.llm.maxTokens < 1) {
      errors.push("llm.maxTokens must be >= 1");
    }

    if (typeof this.retry.maxRetries !== "number" || isNaN(this.retry.maxRetries)) {
      errors.push("retry.maxRetries must be a number");
    } else if (this.retry.maxRetries < 0) {
      errors.push("retry.maxRetries must not be negative");
    }

    if (typeof this.retry.retryDelayMs !== "number" || isNaN(this.retry.retryDelayMs)) {
      errors.push("retry.retryDelayMs must be a number");
    } else if (this.retry.retryDelayMs <= 0) {
      errors.push("retry.retryDelayMs must be positive");
    }

    if (typeof this.retry.maxDelayMs !== "number" || isNaN(this.retry.maxDelayMs)) {
      errors.push("retry.maxDelayMs must be a number");
    } else if (this.retry.maxDelayMs <= 0) {
      errors.push("retry.maxDelayMs must be positive");
    }

    if (typeof this.retry.retryOnTimeout !== "boolean") {
      errors.push("retry.retryOnTimeout must be a boolean");
    }

    if (typeof this.llm.timeout !== "number" || isNaN(this.llm.timeout)) {
      errors.push("llm.timeout must be a number");
    } else if (this.llm.timeout <= 0) {
      errors.push("llm.timeout must be positive");
    }

    if (typeof this.logging.level !== "string") {
      errors.push("logging.level must be a string");
    } else {
      const upper = this.logging.level.toUpperCase();
      if (!(VALID_LOG_LEVELS as readonly string[]).includes(upper)) {
        errors.push(
          `logging.level '${this.logging.level}' is not supported. Valid: ${VALID_LOG_LEVELS.join(", ")}`,
        );
      } else {
        this.logging.level = upper;
      }
    }

    return errors;
  }

  // -----------------------------------------------------------------------
  // API key / base URL resolution
  // -----------------------------------------------------------------------

  /**
   * Resolve the API key from config or environment variables.
   *
   * Checks provider-specific env names when the config value is empty.
   */
  getApiKey(): string {
    if (this.llm.apiKey) return this.llm.apiKey;

    loadDotenv();

    // Provider-specific environment variable fallback
    const envMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_AUTH_TOKEN",
      deepseek: "DEEPSEEK_API_KEY",
      qwen: "QWEN_API_KEY",
    };

    const providerKey = envMap[this.llm.provider];
    if (providerKey && process.env[providerKey]) {
      return process.env[providerKey]!;
    }

    // Generic fallback
    if (process.env.REQDESIGN_API_KEY) return process.env.REQDESIGN_API_KEY;

    return "";
  }

  /**
   * Resolve the base URL from config or environment variables.
   *
   * Checks provider-specific env names when the config value is empty.
   */
  getBaseUrl(): string {
    if (this.llm.baseUrl) return this.llm.baseUrl;

    const envMap: Record<string, string> = {
      openai: "OPENAI_BASE_URL",
      anthropic: "ANTHROPIC_BASE_URL",
      deepseek: "DEEPSEEK_BASE_URL",
      qwen: "QWEN_BASE_URL",
    };

    const envName = envMap[this.llm.provider];
    return envName ? (process.env[envName] ?? "") : "";
  }
}


