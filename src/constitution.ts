/**
 * 项目宪法加载器
 *
 * 读取 ReqDesign.md，提供给所有 Agent 作为顶层约束。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Logger shim — replace with a real logger when available. */
function log(level: "info" | "warn", message: string): void {
  // eslint-disable-next-line no-console
  if (level === "warn") console.warn(`[constitution] ${message}`);
}

/** Default filenames searched for when locating the constitution file. */
const DEFAULT_FILENAMES: readonly string[] = ["ReqDesign.md"];

/**
 * Loads a project constitution file (e.g. `ReqDesign.md`) and injects it
 * into agent system prompts as a top-level constraint section.
 */
export class ConstitutionLoader {
  /** File names to search for, in order of priority. */
  readonly defaultFilenames: readonly string[] = DEFAULT_FILENAMES;

  /** Directories that will be searched for the constitution file. */
  searchDirs: string[];

  private _content: string | null = null;
  private _sourcePath: string | null = null;

  constructor(searchDirs?: string[]) {
    this.searchDirs = searchDirs ?? [process.cwd()];
  }

  /** Constitution content (lazy-loaded on first access). */
  get content(): string {
    if (this._content === null) {
      const result = this._load();
      this._content = result.content;
      this._sourcePath = result.sourcePath;
    }
    return this._content;
  }

  /** Absolute path of the loaded constitution file, or `null`. */
  get sourcePath(): string | null {
    if (this._content === null) {
      const result = this._load();
      this._content = result.content;
      this._sourcePath = result.sourcePath;
    }
    return this._sourcePath;
  }

  /** Whether a constitution file was successfully loaded. */
  get isLoaded(): boolean {
    if (this._content === null) {
      const result = this._load();
      this._content = result.content;
      this._sourcePath = result.sourcePath;
    }
    return this._content.length > 0;
  }

  /** Force a re-read of the constitution file from disk. */
  reload(): string {
    this._content = null;
    this._sourcePath = null;
    return this.content;
  }

  /**
   * Search configured directories for a constitution file and load it.
   * Returns an empty string when no file is found.
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
   * Prepend the constitution as a "## 项目宪法（必须遵守）" section
   * in front of the agent prompt.
   *
   * If no constitution content is available, returns the prompt unchanged.
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

/** Get the global constitution loader (lazy-initialised). */
export function getConstitution(): ConstitutionLoader {
  if (_constitutionLoader === null) {
    _constitutionLoader = new ConstitutionLoader();
  }
  return _constitutionLoader;
}

/** Replace the global constitution loader (used by Runtime). */
export function setConstitution(loader: ConstitutionLoader): void {
  _constitutionLoader = loader;
}
