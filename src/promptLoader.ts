/**
 * Shared prompt-template loader with file-level caching.
 *
 * Resolves prompt files relative to a `prompts/` directory located two levels
 * above this source file (i.e. `<project-root>/prompts/`).
 *
 * @module promptLoader
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Resolve PROMPT_DIR: <project-root>/prompts
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPT_DIR = path.resolve(__dirname, "..", "prompts");

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

/** Cache mapping filename → loaded content (avoids repeated disk reads). */
const _cache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a prompt template file from the `prompts/` directory with caching.
 *
 * The `filename` is sanitised via `path.basename` to prevent path-traversal
 * attacks.  If the file does not exist, `fallback` is returned.
 *
 * @param filename - Name of the file inside the `prompts/` directory
 *                   (e.g. `"requirement_analysis.md"`).
 * @param fallback - Default content returned when the file is missing
 *                   (default `""`).
 * @returns The prompt template text.
 */
export function loadPrompt(filename: string, fallback = ""): string {
  // Sanitise: prevent path traversal
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
      // File not found — return fallback silently
      return fallback;
    }
    // Re-throw unexpected errors
    throw err;
  }
}

/**
 * Clear the prompt cache (useful in tests).
 */
export function clearCache(): void {
  _cache.clear();
}
