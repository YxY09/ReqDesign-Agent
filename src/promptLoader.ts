/**
 * 共享的提示词模板加载器，带文件级缓存。
 *
 * 相对于本源文件两个层级之上的 `prompts/` 目录解析提示词文件
 *（即 `<project-root>/prompts/`）。
 *
 * @module promptLoader
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 解析 PROMPT_DIR: <project-root>/prompts
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPT_DIR = path.resolve(__dirname, "..", "prompts");

// ---------------------------------------------------------------------------
// 模块级缓存
// ---------------------------------------------------------------------------

/** 文件名 → 已加载内容的缓存映射（避免重复磁盘读取）。 */
const _cache = new Map<string, string>();

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 从 `prompts/` 目录加载提示词模板文件，带缓存。
 *
 * 通过 `path.basename` 对 `filename` 进行清理以防止路径遍历攻击。
 * 如果文件不存在，返回 `fallback`。
 *
 * @param filename - `prompts/` 目录内的文件名
 *                   （如 `"requirement_analysis.md"`）。
 * @param fallback - 文件缺失时返回的默认内容
 *                   （默认为 `""`）。
 * @returns 提示词模板文本。
 */
export function loadPrompt(filename: string, fallback = ""): string {
  // 清理：防止路径遍历
  const safeName = path.basename(filename);
  if (!safeName || safeName === "." || safeName === "..") {
    return fallback;
  }

  const cached = _cache.get(safeName);
  if (cached !== undefined) {
    return cached;
  }

  const filePath = path.join(PROMPT_DIR, safeName);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    _cache.set(safeName, content);
    return content;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      // 文件未找到 — 静默返回 fallback
      return fallback;
    }
    // 重新抛出意外错误
    throw err;
  }
}

/**
 * 清空提示词缓存（在测试中很有用）。
 */
export function clearCache(): void {
  _cache.clear();
}
