/**
 * 记忆系统常量与数据结构。
 *
 * 源自 reqdesign/memory/constants.py。
 */

// ---------------------------------------------------------------------------
// 常量
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

/** 时效性平局决胜器的分母：mtime / SCALE 确保时效性仅作 tiebreaker。 */
export const MTIME_TIEBREAKER_SCALE = 1e12;

/**
 * Agent 类型到记忆文件名前缀的映射。
 *
 * 控制各 Agent 在 load() / findRelevant() 中的可见范围：
 * - planner 可看 planner + coordinator 的记忆（含路由规则）
 * - repair 可看 generator + evaluator 的记忆（含失败模式 + 修正经验）
 * - coordinator 可看 coordinator + planner 的记忆（路由 + 规划）
 */
export const AGENT_TYPE_PREFIXES: Record<string, readonly string[]> = {
  planner: ["planner_", "coordinator_"],
  generator: ["generator_"],
  repair: ["generator_", "evaluator_"],
  evaluator: ["evaluator_"],
  coordinator: ["coordinator_", "planner_"],
};

/** 将 Agent 类型映射到其查询的记忆文件。 */
export const AGENT_TYPE_MAP: Record<string, string> = {
  planner: "planner.md",
  generator: "generator.md",
  evaluator: "evaluator.md",
  coordinator: "coordinator.md",
  repair: "generator.md",
};

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/** 从 frontmatter 提取的记忆文件头。 */
export interface MemoryHeader {
  filename: string;
  filepath: string;
  mtime: number;
  description: string;
  memType: string;
  status: string;
  mtimeIso: string;
}

/** 一条完整的记忆记录。 */
export interface MemoryEntry {
  filename: string;
  content: string;
  memType: string;
  description: string;
  status: string;
  lastModified: string;
}

/** 带有默认值的 MemoryHeader 工厂函数。 */
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

/** 带有默认值的 MemoryEntry 工厂函数。 */
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
