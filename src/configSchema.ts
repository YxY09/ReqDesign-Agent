import { z } from "zod";

export const LlmConfigSchema = z.object({
  provider: z.enum(["openai", "anthropic", "deepseek", "qwen", "minimax"]).default("openai"),
  model: z.string().min(1, "model must not be empty").default("gpt-4o"),
  apiKey: z.string().optional().default(""),
  baseUrl: z.string().optional().default(""),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().int().positive().default(8192),
  timeout: z.number().positive().default(120),
});

export type LlmConfigParsed = z.infer<typeof LlmConfigSchema>;

export const RetryConfigSchema = z.object({
  maxRetries: z.number().int().nonnegative().default(3),
  retryDelayMs: z.number().int().positive().default(1000),
  maxDelayMs: z.number().int().positive().default(30_000),
  retryOnTimeout: z.boolean().default(true),
});

export type RetryConfigParsed = z.infer<typeof RetryConfigSchema>;

export const OutputConfigSchema = z.object({
  defaultDir: z.string().default("outputs/"),
});

export type OutputConfigParsed = z.infer<typeof OutputConfigSchema>;

export const LoggingConfigSchema = z.object({
  level: z.enum(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]).default("INFO"),
  logDir: z.string().default("logs/"),
});

export type LoggingConfigParsed = z.infer<typeof LoggingConfigSchema>;

export const AgentConfigSchema = z.object({
  llm: LlmConfigSchema.default({}),
  retry: RetryConfigSchema.default({}),
  output: OutputConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
});

export type AgentConfigParsed = z.infer<typeof AgentConfigSchema>;

/**
 * 从 YAML 解析的原始对象创建已验证的配置。
 * 失败时 throw ZodError。
 */
export function parseAndValidate(raw: unknown): AgentConfigParsed {
  return AgentConfigSchema.parse(raw ?? {});
}
