# 记忆系统优化 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复记忆系统的 5 个设计缺陷：GC、同类合并、magic number、检索路径统一、Agent 前缀可发现性

**Architecture:** 4 个文件（constants / helpers / extractors / store）范围内修改，每个任务独立可测

**Tech Stack:** TypeScript, Vitest, Node.js fs

---

### Task 1: 提取 magic number 常量 + Agent 前缀可发现化

**Files:**
- Modify: `src/memory/constants.ts`

- [ ] **Step 1: 新增 `MTIME_TIEBREAKER_SCALE` 和 `AGENT_TYPE_PREFIXES` 常量**

```typescript
/** 时效性平局决胜器的分母：mtime / SCALE 确保时效性仅作 tiebreaker。 */
export const MTIME_TIEBREAKER_SCALE = 1e12;

/** Agent 类型到记忆文件名前缀的映射（控制 load() 的可见范围）。 */
export const AGENT_TYPE_PREFIXES: Record<string, readonly string[]> = {
  planner: ["planner_", "coordinator_"],
  generator: ["generator_"],
  repair: ["generator_", "evaluator_"],
  evaluator: ["evaluator_"],
  coordinator: ["coordinator_", "planner_"],
};
```

- [ ] **Step 2: 运行测试确认兼容**

Run: `npx vitest run tests/test_memory_policy.test.ts`

- [ ] **Step 3: Commit**

```bash
git add src/memory/constants.ts
git commit -m "refactor(memory): extract MTIME_TIEBREAKER_SCALE + AGENT_TYPE_PREFIXES constants"
```

---

### Task 2: helpers.ts 和 store.ts 引用新常量

**Files:**
- Modify: `src/memory/helpers.ts:headersForAgent()`
- Modify: `src/memory/store.ts:findRelevant()`

- [ ] **Step 1: helpers.ts — 把 `headersForAgent` 的硬编码 map 替换为引用 `AGENT_TYPE_PREFIXES`**

```typescript
// 前
const prefixMap: Record<string, readonly string[]> = {
  planner: ["planner_", "coordinator_"],
  ...
};

// 后
import { AGENT_TYPE_PREFIXES } from "./constants.js";

export function headersForAgent(agentType, headers): MemoryHeader[] {
  const prefixes = AGENT_TYPE_PREFIXES[agentType] ?? [`${agentType}_`];
  ...
}
```

- [ ] **Step 2: store.ts — 把 `mtime / 1e12` 替换为 `mtime / MTIME_TIEBREAKER_SCALE`**

```typescript
import { MTIME_TIEBREAKER_SCALE } from "./constants.js";
// ...
const score = relevanceScore + header.mtime / MTIME_TIEBREAKER_SCALE;
```

- [ ] **Step 3: 运行测试确认兼容**

Run: `npx vitest run tests/test_memory_policy.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/memory/helpers.ts src/memory/store.ts
git commit -m "refactor(memory): use extracted constants in helpers and store"
```

---

### Task 3: 统一 `load()` 和 `findRelevant()` 检索路径

**Files:**
- Modify: `src/memory/store.ts:load()`

- [ ] **Step 1: 重写 `load()` 内部调用 `findRelevant()`**

```typescript
load(agentType: string): string {
  if (!(agentType in AGENT_TYPE_MAP)) {
    this._logger.warn(`未知的 Agent 类型: ${agentType}`);
    return "";
  }

  // 统一走 findRelevant 的确定性检索路径，无查询时用空字符串
  const memHeaders = this._scanMemoryFiles();
  if (memHeaders.length === 0) return "";

  const filtered = headersForAgent(agentType, memHeaders);
  // 按 findRelevant 的评分逻辑排序（空 query 时仅按 mtime）
  const sorted = filtered
    .map((h) => ({ header: h, score: h.mtime }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELEVANT_MEMORIES);

  const parts: string[] = [`## 记忆索引\n${this._loadIndex()}\n`];
  parts.push("## 记忆主题文件");
  for (const { header } of sorted) {
    const typeLabel = MEMORY_TYPE_LABELS[header.memType as MemoryType] ?? "未知";
    parts.push(`- [${typeLabel}] ${header.filename}: ${header.description}`);
  }
  return parts.join("\n");
}
```

- [ ] **Step 2: 运行测试确认兼容**

Run: `npx vitest run tests/test_memory_policy.test.ts`

- [ ] **Step 3: Commit**

```bash
git add src/memory/store.ts
git commit -m "refactor(memory): unify load() to use same sorting as findRelevant()"
```

---

### Task 4: 增加物理 GC — `pruneOldFiles()`

**Files:**
- Modify: `src/memory/store.ts`
- Modify: `tests/test_memory_policy.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
describe("MemoryStore GC", () => {
  it("prunes deprecated files on disk, not just skips them during scan", () => {
    const tmp = makeTmpDir();
    try {
      const store = new MemoryStore(tmp);
      const memoryDir = join(tmp, ".reqdesign-memory");

      // 写入一个废弃的记忆文件
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

      // 写入一个过期的记忆文件
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

      // GC 前确认文件存在
      expect(existsSync(join(memoryDir, "old_deprecated.md"))).toBe(true);
      expect(existsSync(expiredPath)).toBe(true);

      // 触发 GC
      store.pruneOldFiles();

      // GC 后文件被删除
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
      // 写入超过上限的文件
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/test_memory_policy.test.ts --reporter=verbose`
Expected: 3 new tests FAIL (method not defined)

- [ ] **Step 3: 实现 `pruneOldFiles()`**

```typescript
import { unlinkSync } from "node:fs";

// In MemoryStore class:
pruneOldFiles(): number {
  let removed = 0;
  try {
    const entries = readdirSync(this.memoryDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== MEMORY_INDEX_NAME && e.name !== "README.md")
      .map((e) => ({
        name: e.name,
        path: join(this.memoryDir, e.name),
        mtime: statSync(join(this.memoryDir, e.name)).mtimeMs / 1000,
        status: "",
      }));

    // 读取 frontmatter 获取 status
    for (const f of files) {
      try {
        const raw = readFileSync(f.path, "utf8");
        const fm = parseFrontmatter(raw);
        f.status = (fm["status"] ?? "active").trim().toLowerCase();
      } catch { /* ignore */ }
    }

    // 删除 deprecated
    for (const f of files) {
      if (f.status === "deprecated") {
        try { unlinkSync(f.path); removed++; } catch { /* ignore */ }
      }
    }

    // 删除过期
    const remaining = files.filter((f) => !(f.status === "deprecated"));
    for (const f of remaining) {
      if (memoryAgeDays(f.mtime * 1000) > MAX_MEMORY_AGE_DAYS) {
        try { unlinkSync(f.path); removed++; } catch { /* ignore */ }
      }
    }

    // 截断到 MAX_MEMORY_FILES
    const stillRemaining = remaining.filter((f) => {
      try { return existsSync(f.path); } catch { return false; }
    });
    stillRemaining.sort((a, b) => a.mtime - b.mtime);
    const toRemove = stillRemaining.slice(0, stillRemaining.length - MAX_MEMORY_FILES);
    for (const f of toRemove) {
      try { unlinkSync(f.path); removed++; } catch { /* ignore */ }
    }

    if (removed > 0) {
      this._logger.info(`GC: 清理了 ${removed} 个旧记忆文件`);
      this._indexCache = null; // 重建索引后将不再引用这些文件
    }
  } catch (e) {
    this._logger.warn(`GC 失败: ${e}`);
  }
  return removed;
}
```

在构造函数末尾调用一次：
```typescript
constructor(projectRoot = process.cwd()) {
  // ... existing code ...
  this.pruneOldFiles(); // 构造时自动清理
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/test_memory_policy.test.ts --reporter=verbose`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/store.ts tests/test_memory_policy.test.ts
git commit -m "feat(memory): add pruneOldFiles() GC to clean deprecated/expired/overflow memory files"
```

---

### Task 5: 同类记忆合并（重要度计数器）

**Files:**
- Modify: `src/memory/store.ts:_writeTopicFile()`

- [ ] **Step 1: 写失败测试**

```typescript
describe("MemoryStore consolidation", () => {
  it("increments count when same topic dedup key exists", () => {
    const tmp = makeTmpDir();
    try {
      const store = new MemoryStore(tmp);
      const topic = "fail_pattern_local";

      for (let i = 0; i < 5; i++) {
        store.save(
          "evaluator",
          `blocker pattern attempt ${i}`,
          "feedback",
          topic,
          `key-${i}`,
        );
      }

      const path = join(tmp, ".reqdesign-memory", `evaluator_feedback_${topic}.md`);
      const content = readFileSync(path, "utf-8");
      // 第一条是完整内容，后续的应该合并为计数
      expect(content).toContain("<!-- count: 5 -->");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/test_memory_policy.test.ts --reporter=verbose`
Expected: 1 new test FAIL

- [ ] **Step 3: 实现合并逻辑**

在 `_writeTopicFile` 中新增计数器分支：
```typescript
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
        return true;
      }

      // 检查同上 topic 现有条目数，超过阈值则合并
      const updateBlocks = (existing.match(/^## 更新 /gm) || []).length;
      const countMatch = existing.match(/<!-- count: (\d+) -->/);
      if (updateBlocks >= 3) {
        // 已有 3+ 条更新 → 只更新计数器
        const currentCount = countMatch ? parseInt(countMatch[1], 10) : updateBlocks + 1;
        const newCount = currentCount + 1;
        let updated = existing.replace(/<!-- count: \d+ -->/, `<!-- count: ${newCount} -->`);
        if (!updated.includes("<!-- count:")) {
          updated = updated.replace(
            /^(---\n[\s\S]*?\n---)/,
            `$1\n\n<!-- count: ${newCount} -->\n\n此模式已出现 ${newCount} 次，最新：${created}`,
          );
        } else {
          updated = updated.replace(
            /^(<!-- count: \d+ -->[\s\S]*?此模式已出现 \d+ 次，最新：).*$/m,
            `$1${created}`,
          );
        }
        writeFileSync(topicPath, updated.trim() + "\n", { encoding: "utf8" });
        return true;
      }

      let update = `\n\n---\n\n## 更新 ${created}\n\n`;
      if (marker) update += `${marker}\n\n`;
      update += `${body}\n`;
      const newContent = truncateTopicFile(existing + update);
      writeFileSync(topicPath, newContent.trim() + "\n", { encoding: "utf8" });
    } else {
      let finalContent = content.trim();
      if (marker) finalContent += `\n\n${marker}\n`;
      writeFileSync(topicPath, finalContent + "\n", { encoding: "utf8" });
    }
    return true;
  } catch (e) {
    this._logger.error(`写入记忆文件失败 ${topicPath}: ${e}`);
    return false;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/test_memory_policy.test.ts --reporter=verbose`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/store.ts tests/test_memory_policy.test.ts
git commit -m "feat(memory): consolidate repeat memories with count marker instead of appending"
```

---

### Verification (All Tasks Complete)

- [ ] Run full test suite: `npx vitest run tests/test_memory_policy.test.ts`
- [ ] Run existing non-memory tests to check no regression: `npx vitest run --exclude tests/test_memory_policy.test.ts`
