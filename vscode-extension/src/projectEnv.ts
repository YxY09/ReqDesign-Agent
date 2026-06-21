/**
 * Project-root resolution and runtime environment decoupling.
 *
 * The ReqDesign-Agent runtime was written for a CLI whose working directory is
 * the project root. Inside the VSCode extension host the cwd is arbitrary, so
 * this module makes the runtime cwd-independent:
 *
 *   - prompts:   set REQDESIGN_PROMPT_DIR to <root>/prompts (promptLoader reads it first)
 *   - .env:      pre-load <root>/.env into process.env so getApiKey() finds keys
 *   - config:    load <root>/config.yaml by absolute path
 *   - logs:      force config.logging.logDir to an absolute <root>/logs
 *   - output:    callers pass absolute output dirs
 *
 * No process.chdir() is used (it would leak into the whole extension host).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentConfig } from "../../src/config.js";

/** Files that mark a directory as a ReqDesign-Agent project root. */
const ROOT_MARKERS = ["config.yaml", "prompts"];

export interface ResolvedProject {
  root: string;
  configPath: string | null;
}

/**
 * Resolve the ReqDesign-Agent project root. Priority:
 *   1. the `reqdesign.projectRoot` setting, if set and existing
 *   2. a workspace folder containing config.yaml + prompts/
 *   3. the first workspace folder
 * Returns null when nothing usable is found.
 */
export function resolveProjectRoot(): ResolvedProject | null {
  const configured = vscode.workspace.getConfiguration("reqdesign").get<string>("projectRoot");
  if (configured && configured.trim()) {
    const root = path.resolve(configured.trim());
    if (fs.existsSync(root)) {
      return { root, configPath: existingConfigPath(root) };
    }
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    if (looksLikeProjectRoot(root)) {
      return { root, configPath: existingConfigPath(root) };
    }
  }

  if (folders.length > 0) {
    const root = folders[0].uri.fsPath;
    return { root, configPath: existingConfigPath(root) };
  }

  return null;
}

function looksLikeProjectRoot(dir: string): boolean {
  return ROOT_MARKERS.every((marker) => fs.existsSync(path.join(dir, marker)));
}

function existingConfigPath(root: string): string | null {
  const candidate = path.join(root, "config.yaml");
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Make the runtime independent of process.cwd():
 *   - point promptLoader at <root>/prompts via REQDESIGN_PROMPT_DIR
 *   - load <root>/.env into process.env without overriding existing keys
 */
export function prepareEnvironment(root: string): void {
  const promptDir = path.join(root, "prompts");
  if (fs.existsSync(promptDir)) {
    process.env.REQDESIGN_PROMPT_DIR = promptDir;
  }
  loadDotEnv(path.join(root, ".env"));
}

/** Minimal .env parser; mirrors the runtime's own loader (no override). */
function loadDotEnv(envPath: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return; // no .env — rely on the ambient environment / config.yaml
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
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
}

export interface ConfigOverrides {
  provider?: string;
  model?: string;
}

/**
 * Build an AgentConfig anchored at `root`. Loads config.yaml when present,
 * applies setting overrides, and forces logging to an absolute path so the
 * runtime never writes logs into the wrong directory.
 */
export function buildConfig(root: string, configPath: string | null, overrides: ConfigOverrides): AgentConfig {
  const config = configPath ? AgentConfig.loadFromYaml(configPath) : new AgentConfig();

  if (overrides.provider && overrides.provider.trim()) {
    // The provider enum is validated by config.validate() below.
    (config.llm as { provider: string }).provider = overrides.provider.trim();
  }
  if (overrides.model && overrides.model.trim()) {
    config.llm.model = overrides.model.trim();
  }

  // Anchor the log directory to the project root (absolute) so initSharedLog
  // does not create a logs/ folder relative to the extension host cwd.
  const logDir = config.logging.logDir;
  if (!logDir || !path.isAbsolute(logDir)) {
    config.logging.logDir = path.join(root, logDir && logDir.trim() ? logDir : "logs");
  }

  return config;
}

/**
 * Resolve the absolute output directory for a design run.
 * Setting `reqdesign.outputDir` may be absolute or relative to the root.
 */
export function resolveOutputDir(root: string, config: AgentConfig, goal: string): string {
  const setting = vscode.workspace.getConfiguration("reqdesign").get<string>("outputDir");
  if (setting && setting.trim()) {
    const value = setting.trim();
    return path.isAbsolute(value) ? value : path.join(root, value);
  }
  const base = config.output.defaultDir || "outputs/";
  const baseAbs = path.isAbsolute(base) ? base : path.join(root, base);
  return path.join(baseAbs, goal);
}
