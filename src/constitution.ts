/**
 * 项目宪法加载器
 *
 * 读取 ReqDesign.md，提供给所有 Agent 作为顶层约束。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Logger 垫片 — 有真实 logger 时替换。 */
function log(level: "info" | "warn", message: string): void {
  // eslint-disable-next-line no-console
  if (level === "warn") console.warn(`[constitution] ${message}`);
}

/** 查找宪法文件时默认搜索的文件名。 */
const DEFAULT_FILENAMES: readonly string[] = ["ReqDesign.md"];

/**
 * 加载项目宪法文件（如 `ReqDesign.md`），并将其作为顶层约束部分
 * 注入到 agent 系统提示词中。
 */
export class ConstitutionLoader {
  /** 搜索文件名，按优先级排序。 */
  readonly defaultFilenames: readonly string[] = DEFAULT_FILENAMES;

  /** Directories that will be searched for the constitution file. */
  searchDirs: string[];

  private _content: string | null = null;
  private _sourcePath: string | null = null;

  constructor(searchDirs?: string[]) {
    this.searchDirs = searchDirs ?? [process.cwd()];
  }

  /** 宪法内容（首次访问时惰性加载）。 */
  get content(): string {
    if (this._content === null) {
      const result = this._load();
      this._content = result.content;
      this._sourcePath = result.sourcePath;
    }
    return this._content;
  }

  /** 已加载的宪法文件的绝对路径，未找到时为 `null`。 */
  get sourcePath(): string | null {
    if (this._content === null) {
      const result = this._load();
      this._content = result.content;
      this._sourcePath = result.sourcePath;
    }
    return this._sourcePath;
  }

  /** 宪法文件是否成功加载。 */
  get isLoaded(): boolean {
    if (this._content === null) {
      const result = this._load();
      this._content = result.content;
      this._sourcePath = result.sourcePath;
    }
    return this._content.length > 0;
  }

  /** 强制重新从磁盘读取宪法文件。 */
  reload(): string {
    this._content = null;
    this._sourcePath = null;
    return this.content;
  }

  /**
   * 在配置的目录中搜索宪法文件并加载。
   * 未找到文件时返回空字符串。
   */
  private _load(): { content: string; sourcePath: string | null } {
    for (const searchDir of this.searchDirs) {
      for (const filename of this.defaultFilenames) {
        const filePath = path.join(searchDir, filename);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          try {
            const raw = fs.readFileSync(filePath, "utf-8");
            const trimmed = raw.trim();
            if (trimmed.length > 0) {
              log("info", `已加载项目宪法: ${filePath} (${trimmed.length} 字符)`);
              return { content: trimmed, sourcePath: filePath };
            }
          } catch (err: unknown) {
            log("warn", `加载宪法文件失败 ${filePath}: ${err}`);
          }
        }
      }
    }

    log("info", "未找到项目宪法文件 ReqDesign.md，使用默认约束");
    return { content: "", sourcePath: null };
  }

  /**
   * 将宪法作为 "## 项目宪法（必须遵守）" 部分前置到
   * agent 提示词前面。
   *
   * 如果没有宪法内容，则原样返回提示词。
   */
  injectSection(agentPrompt: string): string {
    if (!this.content) {
      return agentPrompt;
    }

    return `## 项目宪法（必须遵守）\n\n${this.content}\n\n---\n\n${agentPrompt}`;
  }
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

let _constitutionLoader: ConstitutionLoader | null = null;

/** 获取全局宪法加载器（惰性初始化）。 */
export function getConstitution(): ConstitutionLoader {
  if (_constitutionLoader === null) {
    _constitutionLoader = new ConstitutionLoader();
  }
  return _constitutionLoader;
}

/** 替换全局宪法加载器（供 Runtime 使用）。 */
export function setConstitution(loader: ConstitutionLoader): void {
  _constitutionLoader = loader;
}
