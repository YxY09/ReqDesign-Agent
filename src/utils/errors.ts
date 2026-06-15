/**
 * 中断错误检测工具。
 *
 * 集中判断“用户主动中止”这一类错误，覆盖以下来源：
 *  - OpenAI SDK：`APIUserAbortError`（继承自 `APIError → OpenAIError → Error`，
 *    其 `.name === "Error"`，`instanceof DOMException === false`）。
 *  - Anthropic SDK：同名的 `APIUserAbortError`（不同类，无法用 `instanceof`
 *    跨包匹配，通过 `constructor.name` 兜底）。
 *  - 浏览器/Node 原生：`DOMException` + `name === "AbortError"`，或
 *    `err.name === "AbortError"`（fetch abort）。
 *  - 兜底：消息匹配 `"Request was aborted."`（OpenAI/Anthropic SDK 默认消息）。
 *
 * 注意：**不匹配** `APIConnectionTimeoutError`（SDK 的连接超时，走
 * `retryOnTimeout` 的独立语义），也不匹配普通网络错误。
 *
 * @module utils/errors
 */

import { APIUserAbortError } from "openai";

/**
 * 判断给定错误是否为“用户主动中止”错误。
 *
 * 必须保持向后兼容：同时识别 OpenAI SDK 的 `APIUserAbortError` 与
 * 浏览器/Node 原生 `AbortError`/`DOMException` 路径。
 *
 * @param e - 任意错误对象。
 * @returns 是否为中止错误。
 */
export function isAbortError(e: unknown): boolean {
  if (e == null || typeof e !== "object") return false;

  // 1. OpenAI SDK 的 APIUserAbortError（instanceof，精确）
  if (e instanceof APIUserAbortError) return true;

  const err = e as { constructor?: { name?: string }; name?: unknown; message?: unknown };

  // 2. constructor.name 兜底：覆盖 Anthropic SDK 的同名类
  //    （跨包 instanceof 不可靠，但类名一致）
  //
  //    ⚠ minify/mangle 风险：生产构建若启用类名压缩（mangle），类名可能被改写
  //    （如变成 "a"），导致此字符串兜底失效。影响范围仅限 Anthropic 跨包兜底；
  //    OpenAI 主路径（上方 instanceof APIUserAbortError，第 1 条）不受影响，因为
  //    instanceof 不依赖类名字符串。生产构建若启用 mangle，需在 CI 校验此兜底，
  //    或确保 Anthropic 错误走 instanceof 主路径（如统一引用同一 SDK 类型）。
  if (err?.constructor?.name === "APIUserAbortError") return true;

  // 3. 浏览器原生 DOMException + AbortError
  if (typeof DOMException !== "undefined" && e instanceof DOMException) {
    return err.name === "AbortError";
  }

  // 4. 通用 name === "AbortError"（Node fetch abort 等场景）
  if (err.name === "AbortError") return true;

  // 5. 消息兜底：SDK 默认中止消息
  if (typeof err.message === "string" && err.message === "Request was aborted.") {
    return true;
  }

  return false;
}
