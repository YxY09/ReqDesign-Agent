/**
 * Memory system helpers — pure functions for formatting, parsing, truncation.
 *
 * Ported from reqdesign/memory/helpers.py.
 */

import {
  FRONTMATTER_SCAN_LINES,
  MAX_INDEX_LINES,
  MAX_INDEX_BYTES,
  MEMORY_INDEX_NAME,
  MEMORY_TYPE_LABELS,
  type MemoryType,
  type MemoryEntry,
  type MemoryHeader,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Parse YAML-like frontmatter from text.
 * Delimited by `---` lines.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split("\n");

  if (lines.length === 0 || lines[0].trim() !== "---") {
    return result;
  }

  for (let i = 1; i < Math.min(lines.length, FRONTMATTER_SCAN_LINES); i++) {
    const line = lines[i].trim();
    if (line === "---") break;
    if (line.includes(":") && !line.startsWith("#")) {
      const colonIdx = line.indexOf(":");
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();
      value = value.replace(/^["']|["']$/g, "");
      if (key) {
        result[key] = value;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Filename generation
// ---------------------------------------------------------------------------

/**
 * Generate a topic filename from agent type, memory type, and content.
 */
export function topicFilename(
  agentType: string,
  memType: string,
  entry: string,
): string {
  let keywords = entry.slice(0, 40).trim();
  let safe = keywords.replace(/[<>:"/\\|?*=]/g, "");
  safe = safe.replace(/ /g, "_").replace(/\n/g, "").replace(/^_+|_+$/g, "");
  if (safe.length > 50) {
    safe = safe.slice(0, 50);
  }
  if (!safe) {
    safe = "memory";
  }
  return `${agentType}_${memType}_${safe}.md`;
}

/**
 * Generate a stable topic filename from an explicit topic name.
 */
export function topicFilenameFromTopic(
  agentType: string,
  memType: string,
  topic: string,
): string {
  let safe = topic.replace(/[<>:"/\\|?*=]/g, "");
  safe = safe.replace(/ /g, "_").replace(/\n/g, "").replace(/^_+|_+$/g, "");
  if (safe.length > 50) {
    safe = safe.slice(0, 50);
  }
  if (!safe) {
    safe = "memory";
  }
  return `${agentType}_${memType}_${safe}.md`;
}

// ---------------------------------------------------------------------------
// Description extraction
// ---------------------------------------------------------------------------

/** Extract a brief description from the first line of an entry. */
export function extractDescription(entry: string): string {
  let firstLine = entry.split("\n")[0].trim();
  if (firstLine.length > 120) {
    firstLine = firstLine.slice(0, 117) + "...";
  }
  return firstLine;
}

// ---------------------------------------------------------------------------
// Formatting for prompts
// ---------------------------------------------------------------------------

/**
 * Format a list of relevant memories as prompt text, grouped by memType.
 */
export function formatRelevantMemories(
  memories: MemoryEntry[],
  label: string,
): string {
  const groups = new Map<string, MemoryEntry[]>();

  for (const m of memories) {
    const key = m.memType || "other";
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(m);
  }

  const parts: string[] = [];
  for (const [memType, group] of groups) {
    const typeLabel =
      MEMORY_TYPE_LABELS[memType as MemoryType] ?? "其他记忆";
    parts.push(`**${typeLabel}**`);
    for (const m of group) {
      const content = m.content.slice(0, 1500);
      const bullet = formatSingleMemory(m.description, content);
      parts.push(bullet);
      const freshness = memoryFreshnessText(m.lastModified);
      if (freshness) {
        parts.push(`    ${freshness}`);
      }
    }
    parts.push("");
  }

  const header = `以下是与当前任务相关的 ${label}：\n`;
  return header + parts.join("\n");
}

/**
 * Format a single memory as a natural-language bullet point.
 */
export function formatSingleMemory(
  description: string,
  content: string,
): string {
  const fields: string[] = [];
  const fieldPatterns: [RegExp][] = [
    [/(?:failure_type|失败类型)\s*[:：]\s*(.+)/i],
    [/(?:condition|条件|触发条件)\s*[:：]\s*(.+)/i],
    [/(?:solution|解决方案|修复)\s*[:：]\s*(.+)/i],
    [/(?:lesson|教训|经验)\s*[:：]\s*(.+)/i],
    [/(?:rule|规则|原则)\s*[:：]\s*(.+)/i],
  ];

  for (const [pattern] of fieldPatterns) {
    const match = content.match(pattern);
    if (match) {
      fields.push(match[1].trim());
    }
  }

  if (fields.length > 0) {
    const fieldText = fields.join(" | ");
    return `  - ${description} — ${fieldText}`;
  }

  // Fallback: use the first meaningful line
  for (const line of content.split("\n")) {
    const stripped = line.trim().replace(/^[#\- ]+/, "");
    if (
      stripped &&
      !stripped.startsWith("---") &&
      !stripped.startsWith("type:") &&
      !stripped.startsWith("description:") &&
      !stripped.startsWith("created:")
    ) {
      return `  - ${description} — ${stripped}`;
    }
  }

  return `  - ${description}`;
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/** Return the age of a memory in whole days. */
export function memoryAgeDays(lastModified: number | string): number {
  let ms: number;
  if (typeof lastModified === "number") {
    ms = lastModified;
  } else {
    ms = Date.parse(lastModified);
  }
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

/**
 * Return a short caveat for stale memories.
 *
 * Memories are historical observations. The model should verify stale claims
 * before using them as current workflow facts.
 */
export function memoryFreshnessText(lastModified: string): string {
  const days = memoryAgeDays(lastModified);
  if (days <= 1) return "";
  return `- 记忆时效提醒: 这条记忆是 ${days} 天前生成的，只能作为历史经验；涉及当前代码、策略或运行状态时必须重新验证。`;
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/**
 * Truncate the memory index to fit within max lines and max bytes.
 */
export function truncateIndex(
  raw: string,
  maxLines: number = MAX_INDEX_LINES,
  maxBytes: number = MAX_INDEX_BYTES,
  indexName: string = MEMORY_INDEX_NAME,
): string {
  const lines = raw.split("\n");
  const lineCount = lines.length;
  const byteCount = Buffer.byteLength(raw, "utf8");

  const wasLineTruncated = lineCount > maxLines;
  const wasByteTruncated = byteCount > maxBytes;

  if (!wasLineTruncated && !wasByteTruncated) {
    return raw;
  }

  let truncated: string;
  if (wasLineTruncated) {
    truncated = lines.slice(0, maxLines).join("\n");
  } else {
    truncated = raw;
  }

  if (Buffer.byteLength(truncated, "utf8") > maxBytes) {
    let cutAt = truncated.lastIndexOf("\n", maxBytes);
    if (cutAt <= 0) {
      cutAt = maxBytes;
    }
    truncated = truncated.slice(0, cutAt);
  }

  const reasonParts: string[] = [];
  if (wasByteTruncated) reasonParts.push(`${byteCount} 字节`);
  if (wasLineTruncated) reasonParts.push(`${lineCount} 行`);

  const warning =
    `\n\n> ⚠️ 警告: ${indexName} 过大 (${reasonParts.join(", ")})，` +
    `已截断。请保持索引条目简洁（每行 ≤ ~150 字符），` +
    `超出行或字节上限的部分未被加载。`;

  return truncated + warning;
}

/**
 * Truncate a topic file, keeping the frontmatter and most recent updates.
 */
export function truncateTopicFile(
  content: string,
  maxBytes: number = 12_000,
): string {
  const warningText = "> memory file truncated to recent updates.";
  const warningPattern = /\n{0,2}> memory file truncated to recent updates\.\n?/g;
  let normalizedContent = content.replace(warningPattern, "\n");
  normalizedContent = normalizedContent.replace(/\n{3,}/g, "\n\n").trimEnd();

  if (Buffer.byteLength(normalizedContent, "utf8") <= maxBytes) {
    return normalizedContent;
  }

  const separator = "\n---\n";
  const firstSep = normalizedContent.indexOf(separator);
  if (firstSep === -1) {
    // No separator — keep the tail
    const buf = Buffer.from(normalizedContent, "utf8");
    if (buf.length <= maxBytes) return normalizedContent;
    return buf.subarray(buf.length - maxBytes).toString("utf8");
  }

  const head = normalizedContent.slice(0, firstSep);
  const rest = normalizedContent.slice(firstSep + separator.length);

  const updateSeparator = "\n\n---\n\n";
  const updates = rest.split(updateSeparator);

  const kept: string[] = [];
  let total = Buffer.byteLength(head, "utf8");

  for (let i = updates.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(updates[i], "utf8") + 8;
    if (total + size > maxBytes) break;
    kept.unshift(updates[i]);
    total += size;
  }

  const warning = `\n\n${warningText}\n`;
  return head.trimEnd() + warning + "\n\n---\n\n" + kept.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Header filtering
// ---------------------------------------------------------------------------

/**
 * Filter memory headers for a given agent type based on filename prefixes.
 */
export function headersForAgent(
  agentType: string,
  headers: MemoryHeader[],
): MemoryHeader[] {
  const prefixMap: Record<string, readonly string[]> = {
    planner: ["planner_", "coordinator_"],
    generator: ["generator_"],
    repair: ["generator_", "evaluator_"],
    evaluator: ["evaluator_"],
    coordinator: ["coordinator_", "planner_"],
  };

  const prefixes = prefixMap[agentType] ?? [`${agentType}_`];
  const selected = headers.filter((h) =>
    prefixes.some((p) => h.filename.startsWith(p)),
  );
  return selected.length > 0 ? selected : headers;
}
