/**
 * Tests for memory policy: extractors, store dedup, and relevance retrieval.
 *
 * Ported from tests/test_memory_policy.py
 */

import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createVerdict,
  createIssue,
  createRuntimeAction,
  createArtifact,
} from "../src/shared/types.js";
import {
  extractEvaluatorInsight,
  extractCoordinatorDecision,
  extractGeneratorLesson,
  persistMemoryWrites,
} from "../src/memory/extractors.js";
import { getMemory, MemoryStore, setMemory } from "../src/memory/store.js";
import { truncateTopicFile } from "../src/memory/helpers.js";
import { MAX_MEMORY_FILES } from "../src/memory/constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "reqdesign-mem-test-"));
}

// ---------------------------------------------------------------------------
// Evaluator extractor
// ---------------------------------------------------------------------------

describe("extractEvaluatorInsight", () => {
  it("records final passed reviews that still have major issues as conservative feedback", () => {
    const verdict = createVerdict({
      passed: true,
      summary: "usable but has improvements",
      issues: [
        createIssue({
          severity: "major",
          targetTaskId: "design-1",
          targetTaskType: "design",
          description: "add detail",
        }),
      ],
      isFinalReview: true,
    });

    const result = extractEvaluatorInsight(verdict, "design");
    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe("final_major_open_issues");
    expect(result[0].content).toContain("only repair one local downstream artifact once");
  });

  it("skips non-final passed reviews that have major issues", () => {
    const verdict = createVerdict({
      passed: true,
      summary: "usable but has improvements",
      issues: [
        createIssue({
          severity: "major",
          targetTaskId: "design-1",
          targetTaskType: "design",
          description: "add detail",
        }),
      ],
      isFinalReview: false,
    });

    expect(extractEvaluatorInsight(verdict, "design")).toEqual([]);
  });

  it("keeps only actionable rejections (blocker/upstream/systemic)", () => {
    // local-scoped major issue → not actionable
    const localMajor = createVerdict({
      passed: false,
      issues: [
        createIssue({
          severity: "major",
          scope: "local",
          targetTaskId: "design-1",
          targetTaskType: "design",
          description: "minor completeness issue",
        }),
      ],
    });

    expect(extractEvaluatorInsight(localMajor, "design")).toEqual([]);

    // blocker → actionable
    const blocker = createVerdict({
      passed: false,
      issues: [
        createIssue({
          severity: "blocker",
          scope: "local",
          targetTaskId: "diagrams-class",
          targetTaskType: "diagrams",
          description: "invalid Mermaid",
        }),
      ],
    });

    const writes = extractEvaluatorInsight(blocker, "design");
    expect(writes).toHaveLength(1);
    expect(writes[0].topic).toBe("fail_pattern_local");
  });
});

// ---------------------------------------------------------------------------
// Coordinator extractor
// ---------------------------------------------------------------------------

describe("extractCoordinatorDecision", () => {
  it("skips routine spawn rules", () => {
    const spawnAction = createRuntimeAction({
      action: "spawn",
      taskId: "design-1",
    });
    expect(extractCoordinatorDecision(spawnAction)).toEqual([]);
  });

  it("keeps strategic decisions like replan", () => {
    const replanAction = createRuntimeAction({
      action: "replan",
      reason: "stalled",
    });
    const writes = extractCoordinatorDecision(replanAction);
    expect(writes).toHaveLength(1);
    expect(writes[0].topic).toBe("routing_replan");
  });
});

// ---------------------------------------------------------------------------
// Generator extractor
// ---------------------------------------------------------------------------

describe("extractGeneratorLesson", () => {
  it("requires nontrivial correction (more than 1 round)", () => {
    const oneRound = createArtifact({
      taskId: "diagrams-1",
      type: "diagrams",
      content: {},
      selfCheckPassed: true,
      selfCorrectRounds: 1,
    });
    const twoRounds = createArtifact({
      taskId: "diagrams-1",
      type: "diagrams",
      content: {},
      selfCheckPassed: true,
      selfCorrectRounds: 2,
    });

    expect(extractGeneratorLesson(oneRound)).toEqual([]);
    expect(extractGeneratorLesson(twoRounds)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MemoryStore: topic + dedup
// ---------------------------------------------------------------------------

describe("MemoryStore", () => {
  it("uses topic and dedup key to avoid duplicates", () => {
    const tmp = makeTmpDir();
    try {
      const store = new MemoryStore(tmp);

      store.save(
        "evaluator",
        "first blocker pattern",
        "feedback",
        "fail_pattern_local",
        "same-key",
      );
      store.save(
        "evaluator",
        "first blocker pattern",
        "feedback",
        "fail_pattern_local",
        "same-key",
      );

      const path = join(
        tmp,
        ".reqdesign-memory",
        "evaluator_feedback_fail_pattern_local.md",
      );
      expect(existsSync(path)).toBe(true);

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("status: active");
      // dedup key marker should appear exactly once
      expect(content.match(/same-key/g)).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("finds relevant memories with deterministic fallback (no LLM)", () => {
    const tmp = makeTmpDir();
    try {
      const store = new MemoryStore(tmp);
      for (let i = 0; i < 7; i++) {
        store.save(
          "evaluator",
          `pattern ${i}`,
          "feedback",
          `topic_${i}`,
          `key-${i}`,
        );
      }

      const relevant = store.findRelevant("pattern", "", 3);
      expect(relevant).toHaveLength(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("finds relevant memories by body content, not only filename or description", () => {
    const tmp = makeTmpDir();
    try {
      const store = new MemoryStore(tmp);

      store.save(
        "coordinator",
        [
          "## generic routing note",
          "**经验**: final major repair budget exhausted should replan instead of repairing again.",
        ].join("\n"),
        "project",
        "generic_route_note",
        "route-body-keyword",
      );

      const relevant = store.findRelevant(
        "final major repair budget",
        "coordinator",
        1,
      );
      expect(relevant).toHaveLength(1);
      expect(relevant[0]?.content).toContain("repair budget exhausted");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not let recency alone make unrelated memories relevant", () => {
    const tmp = makeTmpDir();
    try {
      const store = new MemoryStore(tmp);
      store.save(
        "coordinator",
        "## unrelated routing note\n**经验**: save outputs after quality gate.",
        "project",
        "unrelated_route_note",
        "unrelated-route",
      );
      store.save(
        "coordinator",
        "## older but relevant note\n**经验**: final major local repair should be limited.",
        "project",
        "older_relevant_note",
        "older-relevant",
      );
      const oldRelevantPath = join(
        tmp,
        ".reqdesign-memory",
        "coordinator_project_older_relevant_note.md",
      );
      const old = new Date(Date.now() - 10 * 86_400_000);
      utimesSync(oldRelevantPath, old, old);

      const relevant = store.findRelevant(
        "final major local repair",
        "coordinator",
        1,
      );
      expect(relevant).toHaveLength(1);
      expect(relevant[0]?.content).toContain("older but relevant note");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips deprecated memories during recall", () => {
    const tmp = makeTmpDir();
    try {
      const store = new MemoryStore(tmp);
      const memoryDir = join(tmp, ".reqdesign-memory");
      writeFileSync(
        join(memoryDir, "coordinator_project_old_rule.md"),
        [
          "---",
          "type: project",
          "description: old replan rule",
          "status: deprecated",
          "created: 2026-05-14T00:00:00Z",
          "---",
          "",
          "## old replan rule",
          "**经验**: deprecated replan memory",
        ].join("\n"),
        "utf-8",
      );

      const relevant = store.findRelevant("deprecated replan", "coordinator", 3);
      expect(relevant).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects low-quality count and timeout memories", () => {
    const tmp = makeTmpDir();
    try {
      const store = new MemoryStore(tmp);
      store.save(
        "coordinator",
        "## bad rule\n**原因**: issues increased 25 -> 33, killed by timeout",
        "project",
        "bad_count_rule",
        "bad-count",
      );

      const path = join(
        tmp,
        ".reqdesign-memory",
        "coordinator_project_bad_count_rule.md",
      );
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("adds freshness caveats when injecting stale memories", () => {
    const tmp = makeTmpDir();
    try {
      const store = new MemoryStore(tmp);
      store.save(
        "coordinator",
        "## stale routing note\n**经验**: final major local repair should be limited.",
        "project",
        "stale_route_note",
        "stale-route",
      );
      const path = join(
        tmp,
        ".reqdesign-memory",
        "coordinator_project_stale_route_note.md",
      );
      const old = new Date(Date.now() - 3 * 86_400_000);
      utimesSync(path, old, old);

      const prompt = store.appendToPrompt(
        "coordinator",
        "base prompt",
        "final major local repair",
      );
      expect(prompt).toContain("记忆时效提醒");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("truncateTopicFile keeps only one truncation warning", () => {
    const warning = "\n\n> memory file truncated to recent updates.\n";
    const oversized = [
      "---",
      "type: project",
      "description: example",
      "created: 2026-05-14T00:00:00Z",
      "---",
      "",
      "# example",
      "",
      "body",
      warning,
      "",
      "---",
      "",
      "## 更新 1",
      "",
      "content 1",
      warning,
      "",
      "---",
      "",
      "## 更新 2",
      "",
      "content 2".repeat(4000),
    ].join("\n");

    const truncated = truncateTopicFile(oversized, 1200);
    expect((truncated.match(/memory file truncated to recent updates\./g) ?? []).length).toBe(1);
  });

  it("persistMemoryWrites writes extracted entries through the global store", () => {
    const tmp = makeTmpDir();
    const previousMemory = getMemory();
    try {
      const store = new MemoryStore(tmp);
      setMemory(store);

      persistMemoryWrites([
        {
          agentType: "generator",
          content: "## 修正策略有效: diagrams\n**任务类型**: diagrams",
          memType: "project",
          topic: "gen_correction_diagrams",
          dedupKey: "gen-fix:diagrams:2",
        },
      ]);

      const path = join(
        tmp,
        ".reqdesign-memory",
        "generator_project_gen_correction_diagrams.md",
      );
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("修正策略有效");
    } finally {
      setMemory(previousMemory);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// MemoryStore GC
// ---------------------------------------------------------------------------

describe("MemoryStore GC", () => {
  it("prunes deprecated files on disk, not just skips them during scan", () => {
    const tmp = makeTmpDir();
    try {
      const store = new MemoryStore(tmp);
      const memoryDir = join(tmp, ".reqdesign-memory");

      writeFileSync(
        join(memoryDir, "old_deprecated.md"),
        [
          "---",
          "type: project",
          "description: deprecated rule",
          "status: deprecated",
          "created: 2025-01-01T00:00:00Z",
          "---",
          "",
          "## deprecated rule",
        ].join("\n"),
        "utf-8",
      );

      const expiredPath = join(memoryDir, "old_expired.md");
      writeFileSync(
        expiredPath,
        [
          "---",
          "type: project",
          "description: expired rule",
          "status: active",
          "created: 2025-01-01T00:00:00Z",
          "---",
          "",
          "## expired rule",
        ].join("\n"),
        "utf-8",
      );
      const veryOld = new Date("2025-01-01");
      utimesSync(expiredPath, veryOld, veryOld);

      expect(existsSync(join(memoryDir, "old_deprecated.md"))).toBe(true);
      expect(existsSync(expiredPath)).toBe(true);

      store.pruneOldFiles();

      expect(existsSync(join(memoryDir, "old_deprecated.md"))).toBe(false);
      expect(existsSync(expiredPath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps active recent memories", () => {
    const tmp = makeTmpDir();
    try {
      const store = new MemoryStore(tmp);
      store.save("coordinator", "recent rule", "project", "recent_topic", "recent-key");

      store.pruneOldFiles();

      const path = join(tmp, ".reqdesign-memory", "coordinator_project_recent_topic.md");
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prunes oldest files when count exceeds MAX_MEMORY_FILES", () => {
    const tmp = makeTmpDir();
    try {
      const store = new MemoryStore(tmp);
      for (let i = 0; i < MAX_MEMORY_FILES + 5; i++) {
        store.save("coordinator", `rule ${i}`, "project", `topic_${i}`, `key-${i}`);
      }

      const before = readdirSync(join(tmp, ".reqdesign-memory"))
        .filter((f) => f.endsWith(".md") && f !== "MEMORY.md" && f !== "README.md");
      expect(before.length).toBeGreaterThan(MAX_MEMORY_FILES);

      store.pruneOldFiles();

      const after = readdirSync(join(tmp, ".reqdesign-memory"))
        .filter((f) => f.endsWith(".md") && f !== "MEMORY.md" && f !== "README.md");
      expect(after.length).toBeLessThanOrEqual(MAX_MEMORY_FILES);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
