/**
 * Memory system constants and data structures.
 *
 * Ported from reqdesign/memory/constants.py.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MEMORY_DIR_NAME = ".reqdesign-memory";
export const MEMORY_INDEX_NAME = "MEMORY.md";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  user: "用户偏好",
  feedback: "用户反馈",
  project: "项目上下文",
  reference: "外部参考",
};

export const MAX_INDEX_LINES = 200;
export const MAX_INDEX_BYTES = 25_000;
export const MAX_RELEVANT_MEMORIES = 5;
export const FRONTMATTER_SCAN_LINES = 30;
export const MAX_MEMORY_FILES = 200;
export const MAX_TOPIC_BYTES = 12_000;
export const MAX_MEMORY_AGE_DAYS = 90;

/** Maps agent type to the memory file they consult. */
export const AGENT_TYPE_MAP: Record<string, string> = {
  planner: "planner.md",
  generator: "generator.md",
  evaluator: "evaluator.md",
  coordinator: "coordinator.md",
  repair: "generator.md",
};

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/** Memory file header extracted from frontmatter. */
export interface MemoryHeader {
  filename: string;
  filepath: string;
  mtime: number;
  description: string;
  memType: string;
  status: string;
  mtimeIso: string;
}

/** A complete memory record. */
export interface MemoryEntry {
  filename: string;
  content: string;
  memType: string;
  description: string;
  status: string;
  lastModified: string;
}

/** Factory for MemoryHeader with defaults. */
export function createMemoryHeader(
  overrides: Partial<MemoryHeader> & Pick<MemoryHeader, "filename" | "filepath">,
): MemoryHeader {
  return {
    mtime: 0,
    description: "",
    memType: "",
    status: "active",
    mtimeIso: "",
    ...overrides,
  };
}

/** Factory for MemoryEntry with defaults. */
export function createMemoryEntry(
  overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "filename" | "content">,
): MemoryEntry {
  return {
    memType: "",
    description: "",
    status: "active",
    lastModified: "",
    ...overrides,
  };
}
