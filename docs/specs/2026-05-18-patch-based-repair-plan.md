# Patch-Based Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform RepairTool from full-rewrite to targeted patching; make Replan only adjust task topology; add convergence tracking to prevent infinite repair loops.

**Architecture:** Three-layer change — (1) new `ArtifactPatcher` utility that splits artifacts into sections and applies patch operations, (2) RepairTool reworked to output patches instead of full content, (3) convergence detection in orchestration policy to stop spinning on unfixable issues.

**Tech Stack:** TypeScript, Vitest, existing LLMClient + orchestration framework.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/tools/artifactPatcher.ts` | **Create** | Section parser + patch applicator |
| `src/agent/types.ts` | Modify | Add `targeted`, `targetIssues`, `patchContext` to Task |
| `src/tools/repair.ts` | Modify | Patch-mode prompt + apply via ArtifactPatcher |
| `prompts/repair.md` | Modify | Patch-mode LLM instructions |
| `src/tools/generation.ts` | Modify | Remove self-check retry loop |
| `src/orchestration/convergence.ts` | **Create** | Issue fingerprinting + convergence tracker |
| `src/orchestration/policy.ts` | Modify | Integrate convergence check into strategy decisions |
| `src/orchestration/snapshot.ts` | Modify | Add convergence history to snapshot |
| `src/state.ts` | Modify | Store evaluation history |
| `tests/test_artifact_patcher.test.ts` | **Create** | Tests for ArtifactPatcher |
| `tests/test_convergence.test.ts` | **Create** | Tests for convergence tracker |

---

### Task 1: ArtifactPatcher — Section Parser + Patch Applicator

**Files:**
- Create: `src/tools/artifactPatcher.ts`
- Create: `tests/test_artifact_patcher.test.ts`

- [ ] **Step 1: Write tests for section parsing**

```typescript
// tests/test_artifact_patcher.test.ts
import { describe, it, expect } from "vitest";
import { ArtifactPatcher } from "../src/tools/artifactPatcher.js";

describe("ArtifactPatcher.parseSections", () => {
  it("splits markdown by ## headings", () => {
    const md = `# Title\n\nIntro text\n\n## Section A\n\nContent A\n\n## Section B\n\nContent B`;
    const sections = ArtifactPatcher.parseSections(md, "design");
    expect(sections).toHaveLength(3);
    expect(sections[0].key).toBe("Title");
    expect(sections[1].key).toBe("Section A");
    expect(sections[2].key).toBe("Section B");
    expect(sections[1].content).toContain("Content A");
  });

  it("splits markdown by ### when no ## present", () => {
    const md = `### Module 1\n\nMod1 content\n\n### Module 2\n\nMod2 content`;
    const sections = ArtifactPatcher.parseSections(md, "design");
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections[0].key).toBe("Module 1");
  });

  it("splits diagrams dict by diagram type keys", () => {
    const diagrams = {
      class_diagram: "classDiagram\nclass Order",
      activity_diagram: "flowchart TD\n  A-->B",
      state_diagram: "stateDiagram-v2\n  [*] --> Created",
    };
    const sections = ArtifactPatcher.parseSections(diagrams, "diagrams");
    expect(sections).toHaveLength(3);
    expect(sections[0].key).toBe("class_diagram");
    expect(sections[1].key).toBe("activity_diagram");
    expect(sections[2].key).toBe("state_diagram");
  });

  it("handles string diagram as single section", () => {
    const sections = ArtifactPatcher.parseSections("flowchart TD\n  A-->B", "diagrams");
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe("diagram");
  });

  it("handles tests markdown string", () => {
    const md = "## TC-001 Login\n\nTest login\n\n## TC-002 Logout\n\nTest logout";
    const sections = ArtifactPatcher.parseSections(md, "tests");
    expect(sections.length).toBeGreaterThanOrEqual(2);
  });

  it("returns single section for empty/unknown content", () => {
    const sections = ArtifactPatcher.parseSections("plain text", "design");
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe("full");
  });
});

describe("ArtifactPatcher.applyPatches", () => {
  it("replaces a section by key", () => {
    const sections = [
      { key: "A", content: "old A" },
      { key: "B", content: "old B" },
    ];
    const patched = ArtifactPatcher.applyPatches(sections, [
      { op: "replace_section", section: "A", content: "new A" },
    ]);
    expect(patched).toContain("new A");
    expect(patched).toContain("old B");
    expect(patched).not.toContain("old A");
  });

  it("inserts after a section", () => {
    const sections = [
      { key: "A", content: "content A" },
      { key: "B", content: "content B" },
    ];
    const patched = ArtifactPatcher.applyPatches(sections, [
      { op: "insert_after", section: "A", content: "## A-Plus\n\ninserted content" },
    ]);
    expect(patched).toContain("content A");
    expect(patched).toContain("inserted content");
    expect(patched).toContain("content B");
  });

  it("ignores patch for non-existent section", () => {
    const sections = [
      { key: "A", content: "content A" },
    ];
    const patched = ArtifactPatcher.applyPatches(sections, [
      { op: "replace_section", section: "Z", content: "new Z" },
    ]);
    expect(patched).toContain("content A");
  });
});

describe("ArtifactPatcher.reconstruct", () => {
  it("reconstructs markdown with ## headings", () => {
    const sections = [
      { key: "Title", content: "# Title\n\nIntro" },
      { key: "Section A", content: "## Section A\n\nContent A" },
      { key: "Section B", content: "## Section B\n\nContent B" },
    ];
    const result = ArtifactPatcher.reconstruct(sections, "design");
    expect(result).toContain("## Section A");
    expect(result).toContain("## Section B");
    expect(result).toContain("Content A");
  });

  it("reconstructs diagrams as dict", () => {
    const sections = [
      { key: "class_diagram", content: "classDiagram\nclass Order" },
      { key: "state_diagram", content: "stateDiagram-v2\n  [*] --> S1" },
    ];
    const result = ArtifactPatcher.reconstruct(sections, "diagrams");
    expect(result).toEqual({
      class_diagram: "classDiagram\nclass Order",
      state_diagram: "stateDiagram-v2\n  [*] --> S1",
    });
  });

  it("reconstructs tests as string", () => {
    const sections = [
      { key: "TC-001", content: "## TC-001\n\ntest body" },
    ];
    const result = ArtifactPatcher.reconstruct(sections, "tests");
    expect(typeof result).toBe("string");
    expect(result).toContain("TC-001");
  });
});

describe("ArtifactPatcher.validateResult", () => {
  it("rejects result shorter than 50% of original", () => {
    expect(ArtifactPatcher.validateResult("1234567890", "12")).toBe(false);
  });

  it("accepts result of reasonable length", () => {
    expect(ArtifactPatcher.validateResult("1234567890", "12345")).toBe(true);
  });

  it("accepts result longer than original", () => {
    expect(ArtifactPatcher.validateResult("12345", "123456789012345")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/test_artifact_patcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ArtifactPatcher**

```typescript
// src/tools/artifactPatcher.ts
/**
 * ArtifactPatcher — splits artifacts into sections and applies patch operations.
 *
 * Used by RepairTool for targeted patching instead of full artifact rewrites.
 */

export interface Section {
  key: string;
  content: string;
}

export interface PatchOp {
  op: "replace_section" | "insert_after" | "remove_section";
  section: string;
  content?: string;
}

export class ArtifactPatcher {
  // ------------------------------------------------------------------
  // Section parsing
  // ------------------------------------------------------------------

  /** Split an artifact into named sections based on its type. */
  static parseSections(content: unknown, taskType: string): Section[] {
    if (taskType === "diagrams") {
      return ArtifactPatcher._parseDiagramSections(content);
    }

    const text = typeof content === "string"
      ? content
      : content === null || content === undefined
        ? ""
        : JSON.stringify(content, null, 2);

    if (!text.trim()) {
      return [{ key: "full", content: "" }];
    }

    // Try ## heading split first
    const h2Sections = ArtifactPatcher._splitByHeading(text, /^## /);
    if (h2Sections.length > 1) return h2Sections;

    // Try ### heading split
    const h3Sections = ArtifactPatcher._splitByHeading(text, /^### /);
    if (h3Sections.length > 1) return h3Sections;

    // Single section
    return [{ key: "full", content: text }];
  }

  private static _parseDiagramSections(content: unknown): Section[] {
    if (typeof content === "object" && content !== null && !Array.isArray(content)) {
      const dict = content as Record<string, unknown>;
      const diagramKeys = ["class_diagram", "activity_diagram", "state_diagram"];
      const sections: Section[] = [];
      for (const key of diagramKeys) {
        if (key in dict && typeof dict[key] === "string") {
          sections.push({ key, content: dict[key] as string });
        }
      }
      // Include any non-standard keys
      for (const [key, val] of Object.entries(dict)) {
        if (!diagramKeys.includes(key) && typeof val === "string") {
          sections.push({ key, content: val });
        }
      }
      if (sections.length > 0) return sections;
    }

    // Single string diagram
    const text = typeof content === "string" ? content : String(content ?? "");
    return [{ key: "diagram", content: text }];
  }

  private static _splitByHeading(text: string, headingRegex: RegExp): Section[] {
    const lines = text.split("\n");
    const sections: Section[] = [];
    let currentKey = "";
    let currentLines: string[] = [];

    for (const line of lines) {
      if (headingRegex.test(line.trim())) {
        if (currentKey || currentLines.length > 0) {
          sections.push({ key: currentKey, content: currentLines.join("\n") });
        }
        currentKey = line.trim().replace(/^#+\s*/, "").trim();
        currentLines = [line];
      } else {
        currentLines.push(line);
      }
    }

    if (currentKey || currentLines.length > 0) {
      sections.push({ key: currentKey, content: currentLines.join("\n") });
    }

    return sections;
  }

  // ------------------------------------------------------------------
  // Patch application
  // ------------------------------------------------------------------

  /** Apply patch operations to parsed sections, return reconstructed content. */
  static applyPatches(sections: Section[], patches: PatchOp[]): string {
    const result = [...sections];

    for (const patch of patches) {
      const idx = result.findIndex(
        (s) => s.key === patch.section || s.key.toLowerCase().includes(patch.section.toLowerCase()),
      );

      switch (patch.op) {
        case "replace_section":
          if (idx >= 0 && patch.content !== undefined) {
            // Preserve the heading line from original, replace body
            result[idx] = { key: result[idx].key, content: patch.content };
          }
          break;

        case "insert_after":
          if (idx >= 0 && patch.content !== undefined) {
            const newKey = ArtifactPatcher._extractHeading(patch.content);
            result.splice(idx + 1, 0, { key: newKey, content: patch.content });
          }
          break;

        case "remove_section":
          if (idx >= 0) {
            result.splice(idx, 1);
          }
          break;
      }
    }

    return result.map((s) => s.content).join("\n\n");
  }

  private static _extractHeading(content: string): string {
    const match = content.match(/^#{1,3}\s+(.+)/);
    return match ? match[1].trim() : "section";
  }

  // ------------------------------------------------------------------
  // Reconstruction
  // ------------------------------------------------------------------

  /** Reconstruct sections back into the original artifact format. */
  static reconstruct(sections: Section[], taskType: string): unknown {
    if (taskType === "diagrams") {
      const dict: Record<string, string> = {};
      for (const s of sections) {
        dict[s.key] = s.content;
      }
      return dict;
    }

    return sections.map((s) => s.content).join("\n\n");
  }

  // ------------------------------------------------------------------
  // Validation
  // ------------------------------------------------------------------

  /** Check that patched result is not significantly shorter than original. */
  static validateResult(original: string, patched: string): boolean {
    if (!original.trim()) return true;
    return patched.length >= original.length * 0.5;
  }

  /** Get a listing of section keys for prompt inclusion. */
  static sectionListing(sections: Section[]): string {
    return sections
      .map((s, i) => `${i + 1}. "${s.key}" (${s.content.length} chars)`)
      .join("\n");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/test_artifact_patcher.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/artifactPatcher.ts tests/test_artifact_patcher.test.ts
git commit -m "feat: add ArtifactPatcher — section parser + patch applicator for targeted repair"
```

---

### Task 2: Extend Task Type with Targeted Fields

**Files:**
- Modify: `src/agent/types.ts`

- [ ] **Step 1: Add targeted fields to Task interface and createTask**

In `src/agent/types.ts`, extend the Task interface and createTask helper:

```typescript
// In Task interface, add after contextHints:
  targeted?: boolean;
  targetIssues?: Issue[];
  patchContext?: {
    targetArtifactId: string;
    targetSections?: string[];
  };
```

Update `createTask` to include defaults:

```typescript
export function createTask(overrides: Partial<Task> & Pick<Task, "id" | "type">): Task {
  return {
    description: "",
    dependsOn: [],
    contextHints: {},
    targeted: false,
    ...overrides,
  };
}
```

- [ ] **Step 2: Compile and run all tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all 435 tests pass (additive change, backward compatible)

- [ ] **Step 3: Commit**

```bash
git add src/agent/types.ts
git commit -m "feat: extend Task with targeted, targetIssues, patchContext fields"
```

---

### Task 3: Rework RepairTool to Patch Mode

**Files:**
- Modify: `src/tools/repair.ts`
- Modify: `prompts/repair.md`

- [ ] **Step 1: Rewrite repair.md for patch-mode instructions**

Replace `prompts/repair.md` content. Key change: LLM outputs patch JSON instead of full artifact.

```markdown
你是一个软件系统产物的**精准修复专家**。

你的职责：接收 Evaluator 发现的结构化问题和当前产物的章节列表，产出**精确的修改指令（patch）**，而非重写整个产物。

## 核心原则

1. **只输出需要修改的章节**：不要重写未出问题的章节
2. **patch 格式**：输出 JSON 数组，每个元素是一个修改操作
3. **保持结构**：修改内容必须与原始章节格式一致
4. **来源可靠**：修复内容必须来源于需求原文，不可凭空编造

## Patch 格式

输出一个 JSON 对象，包含 `patches` 数组：

```json
{
  "patches": [
    {
      "op": "replace_section",
      "section": "章节名称或图表类型",
      "content": "替换后的完整章节内容（含标题行）"
    }
  ]
}
```

操作类型：
- `replace_section`：替换整个章节。section 填章节标题或图表类型键名。
- `insert_after`：在指定章节后插入新内容。
- `remove_section`：删除指定章节。

## 修复策略

### analyze（需求分析）
对于 analyze 类型的修复，仍然输出完整 JSON（因为 analyze 是结构化数据，不适合 patch）：
```json
{ "content": <修复后的完整 analyze 产物> }
```

### diagrams（图表）
- section 值为图表类型键名：`class_diagram`、`activity_diagram`、`state_diagram`
- content 直接输出 Mermaid 代码（不要 markdown 代码块包裹）

### design（系统设计）
- section 值为 `## ` 标题文本
- content 包含 `## 标题` 行 + 正文

### tests（测试用例）
- section 值为 `## ` 标题文本
- content 包含 `## 标题` 行 + 正文

## 通用要求
- 每个 patch 的 content 必须是完整的、可直接替换的文本
- 不要省略内容，不要使用 "..." 或 "（其余不变）"
- 不要输出任何解释文字，只输出 JSON
```

- [ ] **Step 2: Rewrite RepairTool to use patch mode for design/diagrams/tests**

Key changes in `src/tools/repair.ts`:
1. `_buildRepairPrompt`: Include section listing, use patch-mode prompt
2. `repair`: Parse LLM response as patches, apply via ArtifactPatcher
3. Keep full-rewrite fallback for analyze tasks

```typescript
// Replace the repair() method body:
import { ArtifactPatcher, type PatchOp } from "./artifactPatcher.js";

// In repair() method, after getting LLM response:
if (task.type === "analyze") {
  // analyze still uses full rewrite
  content = this._parseResponse(response as Record<string, unknown>, task);
} else {
  // design/diagrams/tests use patch mode
  content = this._applyPatchResponse(task, currentContent, response as Record<string, unknown>);
}
```

New private method `_applyPatchResponse`:

```typescript
private _applyPatchResponse(
  task: Task,
  currentContent: unknown,
  response: Record<string, unknown>,
): unknown | null {
  const patchesRaw = response.patches;
  if (!Array.isArray(patchesRaw) || patchesRaw.length === 0) {
    this.logger.warn(`repair: task=${task.id} LLM未返回有效的patches，fallback到完整替换`);
    return this._parseResponse(response, task);
  }

  const patches: PatchOp[] = patchesRaw
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .map((p) => ({
      op: String(p.op ?? "replace_section") as PatchOp["op"],
      section: String(p.section ?? ""),
      content: typeof p.content === "string" ? p.content : String(p.content ?? ""),
    }))
    .filter((p) => p.section && p.content !== undefined);

  if (patches.length === 0) {
    this.logger.warn(`repair: task=${task.id} 解析后无有效patches`);
    return null;
  }

  const sections = ArtifactPatcher.parseSections(currentContent, task.type);
  const patchedText = ArtifactPatcher.applyPatches(sections, patches);

  if (task.type === "diagrams") {
    return ArtifactPatcher.reconstruct(
      ArtifactPatcher.parseSections(patchedText, task.type),
      task.type,
    );
  }
  return patchedText;
}
```

Update `_buildRepairPrompt` to include section listing:

```typescript
// Add after "## 当前产物" section:
const sections = ArtifactPatcher.parseSections(currentContent, task.type);
if (sections.length > 1) {
  sections.push(`## 产物章节列表\n以下是当前产物的章节，修复时用 section 字段引用这些名称：\n${ArtifactPatcher.sectionListing(sections)}`);
}
```

Remove the "输出修复后的**完整**产物" instruction for non-analyze tasks, replace with patch format instruction.

- [ ] **Step 3: Compile and run tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all tests pass (repair tool is used via GenerationTool self-check and orchestrator; test mocks bypass LLM)

- [ ] **Step 4: Commit**

```bash
git add src/tools/repair.ts prompts/repair.md
git commit -m "feat: repair tool uses patch-mode for design/diagrams/tests, full-rewrite for analyze"
```

---

### Task 4: Remove Self-Check Retry Loop

**Files:**
- Modify: `src/tools/generation.ts`

- [ ] **Step 1: Remove _selfCorrectIfImproved method and its call**

In `src/tools/generation.ts`:

1. Remove the `_selfCorrectIfImproved` method entirely.
2. In `execute()`, after `_ruleCheck`, skip the retry loop — just log and continue:

```typescript
// Replace the self-correct block in execute():
let issues = GenerationTool._ruleCheck(task, content, context);
let selfCorrectRounds = 0;
// Self-check issues are recorded but not auto-repaired.
// Downstream evaluator will handle them.
```

3. Remove `import { RepairTool } from "./repair.js";` since it's no longer used.

- [ ] **Step 2: Compile and run tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add src/tools/generation.ts
git commit -m "fix: remove self-check retry loop — 6/6 failure rate, wastes LLM calls"
```

---

### Task 5: Convergence Tracker

**Files:**
- Create: `src/orchestration/convergence.ts`
- Create: `tests/test_convergence.test.ts`

- [ ] **Step 1: Write convergence tests**

```typescript
// tests/test_convergence.test.ts
import { describe, it, expect } from "vitest";
import { ConvergenceTracker, type EvaluationRound } from "../src/orchestration/convergence.js";

describe("ConvergenceTracker", () => {
  it("detects identical issue across rounds", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({ issues: [
      { fingerprint: "state coupon C002", severity: "major" },
    ]});
    tracker.addRound({ issues: [
      { fingerprint: "state coupon C002", severity: "major" },
    ]});
    tracker.addRound({ issues: [
      { fingerprint: "state coupon C002", severity: "major" },
    ]});
    expect(tracker.isStalled()).toBe(true);
    expect(tracker.stalledFingerprints()).toContain("state coupon C002");
  });

  it("does not stall when issues change", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({ issues: [{ fingerprint: "A", severity: "major" }] });
    tracker.addRound({ issues: [{ fingerprint: "B", severity: "major" }] });
    tracker.addRound({ issues: [{ fingerprint: "C", severity: "major" }] });
    expect(tracker.isStalled()).toBe(false);
  });

  it("does not stall when issue count decreases", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({ issues: [
      { fingerprint: "A", severity: "major" },
      { fingerprint: "B", severity: "major" },
    ]});
    tracker.addRound({ issues: [
      { fingerprint: "A", severity: "major" },
    ]});
    expect(tracker.isStalled()).toBe(false);
  });

  it("computes fingerprint from description", () => {
    const fp1 = ConvergenceTracker.fingerprint("状态图中优惠券过期错误使用 C002/支付超时作为触发条件");
    const fp2 = ConvergenceTracker.fingerprint("状态图中优惠券过期错误使用 C002/支付超时作为触发条件 (extra detail)");
    // Same first 80 chars → same fingerprint
    expect(fp1).toBe(fp2);
  });

  it("reports trend correctly", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({ issues: [
      { fingerprint: "A", severity: "major" },
      { fingerprint: "B", severity: "major" },
    ]});
    tracker.addRound({ issues: [
      { fingerprint: "A", severity: "major" },
    ]});
    expect(tracker.trend()).toBe("improving");
  });

  it("handles empty rounds", () => {
    const tracker = new ConvergenceTracker(3);
    expect(tracker.isStalled()).toBe(false);
    expect(tracker.trend()).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/test_convergence.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ConvergenceTracker**

```typescript
// src/orchestration/convergence.ts
/**
 * ConvergenceTracker — detect when repair loops make no progress.
 *
 * Tracks issue fingerprints across evaluation rounds. If the same issue
 * persists across N consecutive rounds, the system should stop trying
 * to repair it and escalate.
 */

export interface IssueFingerprint {
  fingerprint: string;
  severity: string;
}

export interface EvaluationRound {
  issues: IssueFingerprint[];
}

export type Trend = "improving" | "stable" | "worsening" | "unknown";

export class ConvergenceTracker {
  private readonly rounds: EvaluationRound[] = [];
  private readonly stallThreshold: number;

  constructor(stallThreshold = 3) {
    this.stallThreshold = stallThreshold;
  }

  addRound(round: EvaluationRound): void {
    this.rounds.push(round);
  }

  get roundCount(): number {
    return this.rounds.length;
  }

  /** Generate a stable fingerprint from an issue description. */
  static fingerprint(description: string): string {
    return description.trim().slice(0, 80).toLowerCase();
  }

  /** Check if the system is stalled (same issues not improving). */
  isStalled(): boolean {
    if (this.rounds.length < this.stallThreshold) return false;
    const stalled = this.stalledFingerprints();
    return stalled.length > 0;
  }

  /** Get fingerprints that have persisted across all recent threshold rounds. */
  stalledFingerprints(): string[] {
    if (this.rounds.length < this.stallThreshold) return [];

    const recent = this.rounds.slice(-this.stallThreshold);
    const firstSet = new Set(recent[0].issues.map((i) => i.fingerprint));

    const persisted = [...firstSet].filter((fp) =>
      recent.every((round) =>
        round.issues.some((i) => i.fingerprint === fp),
      ),
    );

    return persisted;
  }

  /** Determine the trend of issue counts. */
  trend(): Trend {
    if (this.rounds.length < 2) return "unknown";

    const counts = this.rounds.map((r) => r.issues.length);
    const last = counts[counts.length - 1];
    const prev = counts[counts.length - 2];

    if (last < prev) return "improving";
    if (last > prev) return "worsening";
    return "stable";
  }

  /** Get the number of major issues in the latest round. */
  get latestMajorCount(): number {
    if (this.rounds.length === 0) return 0;
    return this.rounds[this.rounds.length - 1].issues.filter(
      (i) => i.severity === "major",
    ).length;
  }

  /** Reset tracker state. */
  reset(): void {
    this.rounds.length = 0;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/test_convergence.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/convergence.ts tests/test_convergence.test.ts
git commit -m "feat: add ConvergenceTracker — detect stalled repair loops"
```

---

### Task 6: Integrate Convergence into Orchestration

**Files:**
- Modify: `src/state.ts`
- Modify: `src/orchestration/snapshot.ts`
- Modify: `src/orchestration/policy.ts`

- [ ] **Step 1: Add convergence tracker to WorkflowState**

In `src/state.ts`, add a `convergenceTracker` field to `WorkflowState`:

```typescript
import { ConvergenceTracker } from "./orchestration/convergence.js";

// In WorkflowState class, add property:
readonly convergence: ConvergenceTracker = new ConvergenceTracker(3);
```

Find where verdicts are stored (where evaluation results come in). After storing a verdict, update the convergence tracker:

```typescript
// After pushing to reviewState.verdicts:
if (verdict.issues.length > 0) {
  this.convergence.addRound({
    issues: verdict.issues.map((issue) => ({
      fingerprint: ConvergenceTracker.fingerprint(issue.description),
      severity: issue.severity,
    })),
  });
}
```

- [ ] **Step 2: Expose convergence state in snapshot**

In `src/orchestration/snapshot.ts`, add to `OrchestratorSnapshot` interface:

```typescript
convergenceStalled: boolean;
convergenceStalledFingerprints: string[];
convergenceTrend: string;
convergenceRoundCount: number;
```

In `StateReader.fromState()`, populate these from `state.convergence`:

```typescript
convergenceStalled: state.convergence.isStalled(),
convergenceStalledFingerprints: state.convergence.stalledFingerprints(),
convergenceTrend: state.convergence.trend(),
convergenceRoundCount: state.convergence.roundCount,
```

- [ ] **Step 3: Use convergence in policy decisions**

In `src/orchestration/policy.ts`, add convergence checks in the `decide` method.

Before the final review repair section (step 5), add:

```typescript
// Convergence stall check — if same issues persist, stop repairing
if (snapshot.convergenceStalled && snapshot.convergenceRoundCount >= 3) {
  return createStrategyDecision({
    strategy: "pause_for_user",
    reason: `convergence stalled: ${snapshot.convergenceStalledFingerprints.length} issue(s) unchanged across ${snapshot.convergenceRoundCount} rounds`,
  });
}
```

- [ ] **Step 4: Compile and run all tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/state.ts src/orchestration/snapshot.ts src/orchestration/policy.ts
git commit -m "feat: integrate convergence tracking into orchestration policy"
```

---

### Task 7: Integration Test — Verify Against Ecommerce Example

**Files:**
- None (runtime verification)

- [ ] **Step 1: Run full integration test**

Run: `npx tsx src/main.ts -i examples/ecommerce_order_system.md -o outputs/ecommerce-patch --goal design`
Expected: completes without crash, outputs saved

- [ ] **Step 2: Verify llm_trace.json has LLM call data**

Run: `node -e "const d=require('./outputs/ecommerce-patch/traces/llm_trace.json'); console.log('total entries:', d.entries?.length ?? d.length ?? 0)"`
Expected: > 1 entry (should have many LLM call records from Task 1 + TracingLLMClient integration)

- [ ] **Step 3: Check log for patch-mode repair**

Run: `grep -c 'patches' logs/reqdesign_*.log` (latest log)
Expected: repair operations should show patch usage

- [ ] **Step 4: Verify convergence detection works**

Run: `grep -i 'convergence\|stalled' logs/reqdesign_*.log` (latest log)
Expected: convergence tracker messages appear

- [ ] **Step 5: Final commit**

```bash
git add docs/specs/2026-05-18-patch-based-repair-design.md docs/specs/2026-05-18-patch-based-repair-plan.md
git commit -m "docs: add patch-based repair design spec and implementation plan"
```
