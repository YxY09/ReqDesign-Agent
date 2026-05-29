/**
 * 输入加载模块：读取、清理和切分需求文档。
 *
 * 源自 reqdesign/input_loader.py。
 */

import { readFileSync, existsSync, lstatSync } from "node:fs";
import { extname } from "node:path";
import { parseXmlRequirement, extractSectionIndex, type SectionIndex } from "./xmlParser.js";
import { normalizeDocument, type SpanEvidence } from "./shared/documentNormalizer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Section {
  title: string;
  content: string;
}

// ---------------------------------------------------------------------------
// InputLoader
// ---------------------------------------------------------------------------

export class InputLoader {
  static readonly SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
    ".md",
    ".txt",
    ".json",
    ".xml",
  ]);
  static readonly MAX_FILE_SIZE = 512 * 1024; // 512KB
  static readonly MAX_CHARS = 100_000;

  /**
   * 读取需求文档，返回文本和可选的章节索引。
   *
   * @param filePath - 输入文件的路径。
   * @returns 包含 text 和可选 sectionIndex 的对象。
   */
  static loadWithSections(filePath: string): { text: string; sectionIndex?: SectionIndex[]; spanMap?: Record<string, SpanEvidence> } {
    const text = InputLoader.load(filePath);
    const ext = extname(filePath).toLowerCase();
    if (ext === ".xml") {
      try {
        const raw = readFileSync(filePath, "utf8");
        const sectionIndex = extractSectionIndex(raw);
        // Normalize document to build sentence-level spanMap
        let spanMap: Record<string, SpanEvidence> | undefined;
        try {
          const normalized = normalizeDocument(raw);
          spanMap = Object.fromEntries(normalized.spanMap);
        } catch {
          // Non-fatal: spanMap not available if normalization fails
        }
        return { text, sectionIndex, spanMap };
      } catch {
        // Non-fatal: return text without index or spanMap
        return { text };
      }
    }
    return { text };
  }

  /**
   * 读取需求文档，返回清理后的文本。
   *
   * @param filePath - 输入文件的路径。
   * @returns 清理后的文本内容。
   * @throws 如果文件不存在、不支持、过大或为空。
   */
  static load(filePath: string): string {
    if (!existsSync(filePath)) {
      throw new Error(`输入文件不存在: ${filePath}`);
    }

    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`输入路径是符号链接，不安全: ${filePath}`);
    }
    if (stat.isDirectory()) {
      throw new Error(`输入路径是目录而非文件: ${filePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`输入路径不是普通文件（可能是FIFO或设备文件）: ${filePath}`);
    }

    const fileSize = stat.size;
    if (fileSize > InputLoader.MAX_FILE_SIZE) {
      throw new Error(
        `文件过大: ${fileSize} bytes，上限 ${InputLoader.MAX_FILE_SIZE} bytes`,
      );
    }

    const ext = extname(filePath).toLowerCase();
    if (!InputLoader.SUPPORTED_EXTENSIONS.has(ext)) {
      throw new Error(
        `不支持的文件格式: ${ext}，支持: ${[...InputLoader.SUPPORTED_EXTENSIONS].join(", ")}`,
      );
    }

    const rawContent = InputLoader._readFile(filePath);

    if (!rawContent.trim()) {
      throw new Error("输入文件为空");
    }

    if (rawContent.length > InputLoader.MAX_CHARS) {
      throw new Error(
        `文件内容过长: ${rawContent.length} 字符，上限 ${InputLoader.MAX_CHARS} 字符`,
      );
    }

    if (ext === ".json") {
      return InputLoader._loadJson(rawContent);
    }
    if (ext === ".xml") {
      return parseXmlRequirement(filePath);
    }
    return InputLoader._loadText(rawContent);
  }

  /**
   * 读取文件，支持多编码回退。
   */
  private static _readFile(filePath: string): string {
    const encodings = ["utf8", "gbk", "latin1"] as const;

    for (const encoding of encodings) {
      try {
        let content: string;
        if (encoding === "gbk") {
          // Node.js doesn't natively support GBK — use iconv-lite approach,
          // or fall through to utf8 with replacement
          const buf = readFileSync(filePath);
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const iconv = require("iconv-lite");
            content = iconv.decode(buf, "gbk");
          } catch {
            // No iconv-lite — fall through
            continue;
          }
        } else {
          content = readFileSync(filePath, { encoding: encoding as BufferEncoding });
        }

        if (content) {
          const nonPrintable = [...content].filter(
            (c) => {
              const cp = c.codePointAt(0) ?? 0;
              if (cp <= 31 && cp !== 10 && cp !== 13 && cp !== 9) return true;
              if (cp >= 127 && cp <= 159) return true;
              return cp === 0x7f;
            },
          ).length;
          if (nonPrintable / content.length > 0.3) {
            throw new Error(
              `文件 ${filePath} 可能是二进制文件，非打印字符占比 ${((nonPrintable / content.length) * 100).toFixed(0)}%`,
            );
          }
        }
        return content;
      } catch (e) {
        if (
          e instanceof Error &&
          (e.message.includes("二进制") || e.message.includes("binary"))
        ) {
          throw e;
        }
        // Try next encoding
        continue;
      }
    }

    // Final fallback: utf8 with replacement
    return readFileSync(filePath, { encoding: "utf8" });
  }

  /**
   * 从 JSON 内容中提取文本。
   */
  private static _loadJson(content: string): string {
    try {
      const data = JSON.parse(content);
      if (typeof data === "string") {
        return InputLoader._cleanText(data);
      }
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        const dict = data as Record<string, unknown>;
        for (const key of ["requirements", "content", "description", "text"]) {
          if (key in dict) {
            return InputLoader._cleanText(String(dict[key]));
          }
        }
        return InputLoader._cleanText(
          JSON.stringify(data, null, 2),
        );
      }
      return InputLoader._cleanText(String(data));
    } catch {
      return InputLoader._cleanText(content);
    }
  }

  /**
   * 清理纯文本 / markdown。
   */
  private static _loadText(content: string): string {
    return InputLoader._cleanText(content);
  }

  /**
   * 清理文本：规范化空白，合并空行。
   */
  static _cleanText(text: string): string {
    text = text.trim();
    const lines = text.split("\n");
    const cleanedLines: string[] = [];
    let prevEmpty = false;

    for (const line of lines) {
      const stripped = line.trimEnd();
      if (!stripped) {
        if (!prevEmpty) {
          cleanedLines.push("");
        }
        prevEmpty = true;
      } else {
        cleanedLines.push(stripped);
        prevEmpty = false;
      }
    }

    return cleanedLines.join("\n").trim();
  }

  /**
   * 尝试从文本中提取 JSON（markdown 代码块、原始括号）。
   *
   * @returns 解析后的对象；如果未找到有效 JSON 则返回 `null`。
   */
  static _extractJson(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();

    // 尝试 markdown 代码块
    const codeBlockMatch = trimmed.match(
      /```(?:json)?\s*\n?(.*?)```/s,
    );
    if (codeBlockMatch) {
      try {
        const result = JSON.parse(codeBlockMatch[1].trim());
        if (typeof result === "object" && result !== null && !Array.isArray(result)) {
          return result as Record<string, unknown>;
        }
      } catch {
        // Fall through
      }
    }

    // 尝试带括号匹配的原始花括号
    const start = trimmed.indexOf("{");
    if (start >= 0) {
      let depth = 0;
      let inString = false;
      let escapeNext = false;

      for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === "\\" && inString && !escapeNext) {
          escapeNext = true;
          continue;
        }
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (ch === '"' && !escapeNext) {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            const jsonStr = trimmed.slice(start, i + 1);
            try {
              const result = JSON.parse(jsonStr);
              if (
                typeof result === "object" &&
                result !== null &&
                !Array.isArray(result)
              ) {
                return result as Record<string, unknown>;
              }
            } catch {
              // Fall through
            }
            break;
          }
        }
      }
    }

    return null;
  }

  /**
   * 按标题级别将需求文本切分为章节。
   */
  static splitSections(text: string): Section[] {
    const sections: Section[] = [];
    let currentTitle = "";
    const currentContent: string[] = [];
    let inCodeFence = false;

    for (const line of text.split("\n")) {
      const stripped = line.trim();
      if (stripped.startsWith("```")) {
        inCodeFence = !inCodeFence;
        currentContent.push(line);
        continue;
      }

      if (!inCodeFence && line.startsWith("#")) {
        if (currentContent.length > 0 || currentTitle) {
          const content = currentContent.join("\n").trim();
          if (content) {
            sections.push({ title: currentTitle, content });
          }
        }
        currentTitle = line.replace(/^#+\s*/, "").trim();
        currentContent.length = 0;
      } else {
        currentContent.push(line);
      }
    }

    if (currentContent.length > 0 || currentTitle) {
      const content = currentContent.join("\n").trim();
      if (content) {
        sections.push({ title: currentTitle, content });
      }
    }

    return sections;
  }
}
