/**
 * 配置管理模块。
 *
 * 来自 reqdesign/config.py（第二阶段）。
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// YAML snake_case → camelCase 转换
// ---------------------------------------------------------------------------

/** 递归将对象中的 snake_case 键转换为 camelCase。 */
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

// =========================================================================
// Zod schema — 配置结构与验证的唯一数据源
// =========================================================================

const LlmConfigSchema = z.object({
  provider: z.enum(["openai", "anthropic", "deepseek", "qwen", "minimax"]).default("openai"),
  model: z.string().min(1).default("gpt-4o"),
  apiKey: z.string().optional().default(""),
  baseUrl: z.string().optional().default(""),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().int().positive().default(8192),
  timeout: z.number().positive().default(120),
});

const RetryConfigSchema = z.object({
  maxRetries: z.number().int().nonnegative().default(3),
  retryDelayMs: z.number().int().positive().default(1000),
  maxDelayMs: z.number().int().positive().default(30_000),
  retryOnTimeout: z.boolean().default(true),
});

const OutputConfigSchema = z.object({
  defaultDir: z.string().default("outputs/"),
});

const LoggingConfigSchema = z.object({
  level: z.enum(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]).default("INFO"),
  logDir: z.string().default("logs/"),
});

const BenchmarkConfigSchema = z.object({
  entityNameMap: z.record(z.string(), z.array(z.string())).default({}),
  functionSynonyms: z.record(z.string(), z.array(z.string())).default({}),
});

const AgentConfigSchema = z.object({
  llm: LlmConfigSchema.default({}),
  retry: RetryConfigSchema.default({}),
  output: OutputConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  benchmark: BenchmarkConfigSchema.default({}),
});

/** 根据 schema 验证原始 YAML 数据。验证失败时抛出 ZodError。 */
export function parseAndValidate(raw: unknown) {
  return AgentConfigSchema.parse(raw ?? {});
}

// =========================================================================
// 从 zod schema 派生的 TypeScript 类型（无重复定义）
// =========================================================================

/** LLM 提供商设置。 */
export type LLMConfig = z.infer<typeof LlmConfigSchema>;

/** 重试行为设置。 */
export type RetryConfig = z.infer<typeof RetryConfigSchema>;

/** 输出目录设置。 */
export type OutputConfig = z.infer<typeof OutputConfigSchema>;

/** 日志设置。 */
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

/** Benchmark 配置（实体名映射、同义词等）。 */
export type BenchmarkConfig = z.infer<typeof BenchmarkConfigSchema>;

// ---------------------------------------------------------------------------
// 常量
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
type LogLevel = (typeof VALID_LOG_LEVELS)[number];

// ---------------------------------------------------------------------------
// .env 加载器
// ---------------------------------------------------------------------------

const _dotenvLoadedPaths = new Set<string>();

/**
 * 从 `.env` 文件加载 key=value 对，且不会覆盖已存在的
 * 环境变量。
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
        // 去除首尾引号
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
// 默认值辅助函数
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

function defaultBenchmarkConfig(): BenchmarkConfig {
  return { entityNameMap: {}, functionSynonyms: {} };
}

// ---------------------------------------------------------------------------
// AgentConfig 类
// ---------------------------------------------------------------------------

/**
 * Agent 系统的顶层配置。
 *
 * 通过 {@link AgentConfig.loadFromYaml} 从 YAML 加载，或手动构造。
 */
export class AgentConfig {
  llm: LLMConfig;
  retry: RetryConfig;
  output: OutputConfig;
  logging: LoggingConfig;
  benchmark: BenchmarkConfig;
  /** 原始 YAML 数据（API 密钥已脱敏）。 */
  raw: Record<string, unknown>;

  constructor(opts?: {
    llm?: LLMConfig;
    retry?: RetryConfig;
    output?: OutputConfig;
    logging?: LoggingConfig;
    benchmark?: BenchmarkConfig;
    raw?: Record<string, unknown>;
  }) {
    this.llm = opts?.llm ?? defaultLLMConfig();
    this.retry = opts?.retry ?? defaultRetryConfig();
    this.output = opts?.output ?? defaultOutputConfig();
    this.logging = opts?.logging ?? defaultLoggingConfig();
    this.benchmark = opts?.benchmark ?? defaultBenchmarkConfig();
    this.raw = opts?.raw ?? {};
  }

  // -----------------------------------------------------------------------
  // YAML 加载
  // -----------------------------------------------------------------------

  /**
   * 从 YAML 文件加载配置。
   *
   * @param path - YAML 配置文件的绝对或相对路径。
   * @throws {Error} 如果文件不存在或无法解析。
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

    // 保存原始配置，但脱敏 API 密钥
    const safeRaw: Record<string, unknown> = structuredClone(data);
    if (
      typeof safeRaw.llm === "object" &&
      safeRaw.llm !== null &&
      "api_key" in (safeRaw.llm as Record<string, unknown>)
    ) {
      (safeRaw.llm as Record<string, unknown>).api_key = "***";
    }

    // Zod 严格验证 — 失败时 throw
    const camelData = snakeToCamel(data);
    const parsed = AgentConfigSchema.parse(camelData ?? {});

    const config = new AgentConfig({
      llm: { ...parsed.llm, apiKey: parsed.llm.apiKey ?? "", baseUrl: parsed.llm.baseUrl ?? "" },
      retry: parsed.retry,
      output: parsed.output,
      logging: parsed.logging,
      benchmark: parsed.benchmark,
      raw: safeRaw,
    });
    console.info(
      `[reqdesign] Config loaded: provider=${config.llm.provider}, model=${config.llm.model}`,
    );

    return config;
  }

  // -----------------------------------------------------------------------
  // 验证
  // -----------------------------------------------------------------------

  /**
   * 验证当前配置。
   * @returns 错误字符串数组（为空时表示配置有效）。
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
      if (!isLogLevel(upper)) {
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
  // API 密钥 / base URL 解析
  // -----------------------------------------------------------------------

  /**
   * 从配置或环境变量解析 API 密钥。
   *
   * 当配置值为空时，检查提供商特定的环境变量名。
   */
  getApiKey(): string {
    if (this.llm.apiKey) return this.llm.apiKey;

    loadDotenv();

    // 提供商特定的环境变量回退
    const envMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_AUTH_TOKEN",
      deepseek: "DEEPSEEK_API_KEY",
      qwen: "QWEN_API_KEY",
      minimax: "MINIMAX_API_KEY",
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
   * 从配置或环境变量解析 base URL。
   *
   * 当配置值为空时，检查提供商特定的环境变量名。
   */
  getBaseUrl(): string {
    if (this.llm.baseUrl) return this.llm.baseUrl;

    const envMap: Record<string, string> = {
      openai: "OPENAI_BASE_URL",
      anthropic: "ANTHROPIC_BASE_URL",
      deepseek: "DEEPSEEK_BASE_URL",
      qwen: "QWEN_BASE_URL",
      minimax: "MINIMAX_BASE_URL",
    };

    const envName = envMap[this.llm.provider];
    return envName ? (process.env[envName] ?? "") : "";
  }
}

function isLogLevel(value: string): value is LogLevel {
  return (VALID_LOG_LEVELS as readonly string[]).includes(value);
}


