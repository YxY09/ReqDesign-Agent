/**
 * Persistent Agent memory system.
 *
 * MemoryStore handles:
 * - Saving memories (write topic file + update index)
 * - Loading memories (index scan + frontmatter parsing)
 * - Relevance retrieval (deterministic weighted matching, no LLM)
 * - Prompt injection (appending memories to system prompt)
 *
 * Ported from reqdesign/memory/store.py.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { Logger, setupLogger } from "../logger.js";
import {
  MEMORY_DIR_NAME,
  MEMORY_INDEX_NAME,
  AGENT_TYPE_MAP,
  MAX_INDEX_LINES,
  MAX_INDEX_BYTES,
  MAX_MEMORY_FILES,
  MAX_RELEVANT_MEMORIES,
  MAX_MEMORY_AGE_DAYS,
  MEMORY_TYPE_LABELS,
  type MemoryType,
  type MemoryEntry,
  type MemoryHeader,
  createMemoryHeader,
  createMemoryEntry,
} from "./constants.js";
import {
  parseFrontmatter,
  topicFilename,
  topicFilenameFromTopic,
  extractDescription,
  formatRelevantMemories,
  headersForAgent,
  memoryAgeDays,
  truncateIndex,
  truncateTopicFile,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  readonly projectRoot: string;
  readonly memoryDir: string;
  private _indexCache: string | null = null;
  private readonly _logger: Logger;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = resolve(projectRoot);
    this.memoryDir = join(this.projectRoot, MEMORY_DIR_NAME);
    this._logger = setupLogger("reqdesign.memory");
    this._ensureDir();
  }

  // ================================================================
  // Save
  // ================================================================

  /**
   * Save a memory entry.
   *
   * @param agentType - Agent type (planner, generator, evaluator, etc.).
   * @param entry - Memory content text.
   * @param memType - Memory type: user, feedback, project, reference.
   * @param topic - Optional explicit topic name.
   * @param dedupKey - Optional dedup key (skip write if existing file contains it).
   */
  save(
    agentType: string,
    entry: string,
    memType = "project",
    topic = "",
    dedupKey = "",
  ): void {
    const validTypes = new Set<string>(["user", "feedback", "project", "reference"]);
    if (!validTypes.has(memType)) {
      this._logger.warn(`未知记忆类型 '${memType}'，使用默认 'project'`);
      memType = "project";
    }

    if (MemoryStore._shouldRejectMemoryContent(entry)) {
      this._logger.warn("跳过低质量记忆：内容包含临时运行状态或 issue count 规则");
      return;
    }

    this._ensureDir();

    const fname = topic
      ? topicFilenameFromTopic(agentType, memType, topic)
      : topicFilename(agentType, memType, entry);

    const topicPath = join(this.memoryDir, fname);
    const created = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const description = extractDescription(entry);

    const content = [
      "---",
      `type: ${memType}`,
      `description: ${description}`,
      "status: active",
      `created: ${created}`,
      `updated: ${created}`,
      "---",
      "",
      `# ${description}`,
      "",
      entry,
    ].join("\n");

    if (!this._writeTopicFile(topicPath, content, created, entry, dedupKey)) {
      return;
    }

    this._updateIndex(fname, description, memType);
    this._indexCache = null;
    this._logger.debug(
      `记忆索引已更新: ${agentType} → ${description.slice(0, 80)}`,
    );
  }

  // ================================================================
  // Load
  // ================================================================

  /**
   * Load all remembered context for a given agent type.
   */
  load(agentType: string): string {
    if (!(agentType in AGENT_TYPE_MAP)) {
      this._logger.warn(`未知的 Agent 类型: ${agentType}`);
      return "";
    }

    const indexContent = this._loadIndex();
    if (!indexContent) return "";

    const memHeaders = this._scanMemoryFiles();
    if (memHeaders.length === 0) return "";

    const parts: string[] = [`## 记忆索引\n${indexContent}\n`];
    parts.push("## 记忆主题文件");

    const filtered = headersForAgent(agentType, memHeaders);
    for (const h of filtered.slice(0, MAX_RELEVANT_MEMORIES)) {
      const typeLabel = MEMORY_TYPE_LABELS[h.memType as MemoryType] ?? "未知";
      parts.push(`- [${typeLabel}] ${h.filename}: ${h.description}`);
    }

    return parts.join("\n");
  }

  /**
   * Load memory context for all agent types.
   */
  loadAll(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const agentType of Object.keys(AGENT_TYPE_MAP)) {
      result[agentType] = this.load(agentType);
    }
    return result;
  }

  // ================================================================
  // Relevance retrieval
  // ================================================================

  /**
   * Find memories relevant to a query.
   *
   * Uses deterministic weighted matching instead of LLM-based selection
   * to keep the TypeScript port self-contained.
   */
  findRelevant(
    query: string,
    agentType = "",
    maxCount: number = MAX_RELEVANT_MEMORIES,
  ): MemoryEntry[] {
    let memHeaders = this._scanMemoryFiles();
    if (memHeaders.length === 0) return [];

    if (agentType) {
      memHeaders = headersForAgent(agentType, memHeaders);
      if (memHeaders.length === 0) return [];
    }

    const queryLower = query.trim().toLowerCase();
    const terms = MemoryStore._queryTerms(queryLower);
    const scored = memHeaders.map((header) => {
      const entry = this._readMemoryFile(header);
      const filename = header.filename.toLowerCase();
      const description = header.description.toLowerCase();
      const content = entry.content.slice(0, 4000).toLowerCase();
      let relevanceScore = 0;

      if (queryLower.length > 3) {
        if (description.includes(queryLower)) relevanceScore += 8;
        if (filename.includes(queryLower)) relevanceScore += 6;
        if (content.includes(queryLower)) relevanceScore += 4;
      }

      for (const term of terms) {
        if (filename.includes(term)) relevanceScore += 4;
        if (description.includes(term)) relevanceScore += 3;
        if (content.includes(term)) relevanceScore += 1;
      }

      // Recency is a tie-breaker only; relevance should dominate prompt context.
      const score = relevanceScore + header.mtime / 1e12;
      return { entry, score, relevanceScore };
    });

    const positive = scored.filter((item) => item.relevanceScore > 0);
    const candidates = positive.length > 0 ? positive : scored;
    candidates.sort((a, b) => b.score - a.score);

    return candidates.slice(0, maxCount).map((s) => s.entry);
  }

  // ================================================================
  // Prompt injection
  // ================================================================

  /**
   * Append relevant memories to a base prompt.
   */
  appendToPrompt(
    agentType: string,
    basePrompt: string,
    queryContext = "",
  ): string {
    const typeLabels: Record<string, string> = {
      planner: "规划经验",
      generator: "生成模式",
      evaluator: "审查经验",
      coordinator: "决策经验",
    };
    const label = typeLabels[agentType] ?? "Agent 记忆";

    if (queryContext) {
      const relevant = this.findRelevant(queryContext, agentType);
      if (relevant.length > 0) {
        const memoryText = formatRelevantMemories(relevant, label);
        return `${basePrompt}\n\n---\n\n## Agent 记忆（${label}）\n\n${memoryText}`;
      }
    }

    const memory = this.load(agentType);
    if (!memory) return basePrompt;

    return [
      basePrompt,
      "",
      "---",
      "",
      `## Agent 记忆（${label}）`,
      "",
      "以下是与本次任务相关的历史经验，请参考：",
      "",
      memory,
    ].join("\n");
  }

  // ================================================================
  // Internal methods
  // ================================================================

  private static _queryTerms(query: string): string[] {
    const terms = query
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length > 1);
    return [...new Set(terms)];
  }

  private static _shouldRejectMemoryContent(entry: string): boolean {
    const text = entry.toLowerCase();
    const blockedPatterns = [
      /issues?\s+(?:increased|decreased|oscillat(?:ed|ing)?|count)/,
      /issue\s+count/,
      /issues\s*=\s*\d+/,
      /pause_for_user/,
      /killed\s+by\s+timeout/,
      /\btimeout\b/,
    ];
    return blockedPatterns.some((pattern) => pattern.test(text));
  }

  private _ensureDir(): void {
    mkdirSync(this.memoryDir, { recursive: true });
    const readme = join(this.memoryDir, "README.md");
    if (!existsSync(readme)) {
      try {
        writeFileSync(
          readme,
          [
            "# ReqDesign-Agent 记忆系统",
            "",
            "Agent 在多轮任务中积累的经验。",
            "",
            "## 架构",
            "- `MEMORY.md` — 记忆索引（每个文件一行指针）",
            "- 其他 `.md` 文件 — 主题记忆文件（带 YAML frontmatter）",
            "",
            "## 记忆类型",
            "- `user` — 用户偏好与角色信息",
            "- `feedback` — 用户提供的指导（做/不做什么）",
            "- `project` — 项目上下文与决策",
            "- `reference` — 外部系统/资源指针",
            "",
            "## 索引规则",
            "- 每条记录一行，格式: `- [类型] filename.md — 一句话描述`",
            `- 最多保留 ${MAX_INDEX_LINES} 行，超出自动截断`,
            "",
            "借鉴自 Claude Code 的 MEMORY.md 架构。",
          ].join("\n"),
          { encoding: "utf8" },
        );
      } catch {
        // best-effort
      }
    }
  }

  private _loadIndex(): string {
    if (this._indexCache !== null) {
      return this._indexCache;
    }

    const indexPath = join(this.memoryDir, MEMORY_INDEX_NAME);
    if (!existsSync(indexPath)) {
      this._indexCache = "";
      return "";
    }

    try {
      const raw = readFileSync(indexPath, "utf8").trim();
      const content = truncateIndex(raw);
      this._indexCache = content;
      return content;
    } catch (e) {
      this._logger.warn(`加载索引文件失败: ${e}`);
      this._indexCache = "";
      return "";
    }
  }

  private _scanMemoryFiles(): MemoryHeader[] {
    const headers: MemoryHeader[] = [];

    try {
      const entries = readdirSync(this.memoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const f = entry.name;
        if (!f.endsWith(".md") || f === MEMORY_INDEX_NAME || f === "README.md") continue;

        const filepath = join(this.memoryDir, f);
        const relpath = relative(this.memoryDir, filepath).replace(/\\/g, "/");

        let mtime = 0;
        try {
          mtime = statSync(filepath).mtimeMs / 1000;
        } catch {
          // ignore
        }

        let description = "";
        let memType = "";
        let status = "active";

        try {
          const raw = readFileSync(filepath, "utf8");
          const lines = raw.split("\n").slice(0, 30);
          const fm = parseFrontmatter(lines.join("\n"));
          description = fm["description"] ?? "";
          memType = fm["type"] ?? "";
          status = (fm["status"] ?? "active").trim().toLowerCase();
        } catch {
          // ignore
        }

        if (status === "deprecated") {
          continue;
        }

        if (mtime > 0 && memoryAgeDays(mtime * 1000) > MAX_MEMORY_AGE_DAYS) {
          continue;
        }

        if (!description) {
          description = f.replace(/\.md$/, "").replace(/_/g, " ");
        }

        if (!["user", "feedback", "project", "reference"].includes(memType)) {
          memType = "";
        }

        const mtimeIso = mtime > 0
          ? new Date(mtime * 1000).toISOString()
          : "";

        headers.push(
          createMemoryHeader({
            filename: relpath,
            filepath,
            mtime,
            description,
            memType,
            status,
            mtimeIso,
          }),
        );
      }
    } catch (e) {
      this._logger.warn(`扫描记忆文件失败: ${e}`);
    }

    headers.sort((a, b) => b.mtime - a.mtime);
    return headers.slice(0, MAX_MEMORY_FILES);
  }

  private _readMemoryFile(header: MemoryHeader): MemoryEntry {
    let content = "";
    try {
      content = readFileSync(header.filepath, "utf8").trim();
    } catch {
      // ignore
    }

    return createMemoryEntry({
      filename: header.filename,
      content,
      memType: header.memType,
      description: header.description,
      status: header.status,
      lastModified: header.mtimeIso,
    });
  }

  private _updateIndex(
    fname: string,
    description: string,
    memType: string,
  ): void {
    const indexPath = join(this.memoryDir, MEMORY_INDEX_NAME);
    const tag = memType ? `[${memType}] ` : "";

    let existingLines: string[] = [];
    if (existsSync(indexPath)) {
      try {
        existingLines = readFileSync(indexPath, "utf8").trim().split("\n");
      } catch {
        // ignore
      }
    }

    const newLine = `- ${tag}${fname} — ${description}`;
    const cleaned: string[] = [];
    let seenFilename = false;

    for (const line of existingLines) {
      if (line.includes(fname)) {
        seenFilename = true;
        cleaned.push(newLine);
      } else {
        cleaned.push(line);
      }
    }

    if (!seenFilename) {
      cleaned.push(newLine);
    }

    if (cleaned.length > MAX_INDEX_LINES) {
      cleaned.splice(0, cleaned.length - MAX_INDEX_LINES);
    }

    let content = cleaned.join("\n").trim();
    const encoded = Buffer.from(content, "utf8");

    if (encoded.length > MAX_INDEX_BYTES) {
      const lines = content.split("\n");
      let truncated = "";
      for (const line of lines) {
        const candidate = truncated ? truncated + "\n" + line : line;
        if (Buffer.byteLength(candidate, "utf8") > MAX_INDEX_BYTES) break;
        truncated = candidate;
      }
      content =
        truncated +
        `\n> ⚠️ 索引已达到 ${(MAX_INDEX_BYTES / 1024).toFixed(0)}KB 上限，旧条目被截断。请清理过时的记忆。`;
    }

    try {
      writeFileSync(indexPath, content + "\n", { encoding: "utf8" });
      this._indexCache = content;
    } catch (e) {
      this._logger.error(`写入索引文件失败: ${e}`);
    }
  }

  private _writeTopicFile(
    topicPath: string,
    content: string,
    created: string,
    body: string,
    dedupKey = "",
  ): boolean {
    try {
      const marker = dedupKey ? `<!-- dedup:${dedupKey} -->` : "";

      if (existsSync(topicPath)) {
        let existing = readFileSync(topicPath, "utf8");
        if (marker && existing.includes(marker)) {
          return true; // Already exists, skip
        }

        let update = `\n\n---\n\n## 更新 ${created}\n\n`;
        if (marker) {
          update += `${marker}\n\n`;
        }
        update += `${body}\n`;
        const newContent = truncateTopicFile(existing + update);
        writeFileSync(topicPath, newContent.trim() + "\n", { encoding: "utf8" });
      } else {
        let finalContent = content.trim();
        if (marker) {
          finalContent += `\n\n${marker}\n`;
        }
        writeFileSync(topicPath, finalContent + "\n", { encoding: "utf8" });
      }
      return true;
    } catch (e) {
      this._logger.error(`写入记忆文件失败 ${topicPath}: ${e}`);
      return false;
    }
  }
}

// ================================================================
// Global singleton
// ================================================================

let _memoryStore: MemoryStore | null = null;

/** Get the global MemoryStore singleton. */
export function getMemory(): MemoryStore {
  if (_memoryStore === null) {
    _memoryStore = new MemoryStore();
  }
  return _memoryStore;
}

/** Set a custom MemoryStore instance. */
export function setMemory(store: MemoryStore): void {
  _memoryStore = store;
}
