# Phase B: Entity Identity Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two gaps that prevent the EntityRegistry from being the single source of truth for entity identity in analyze shards: (1) the `{registry_summary}` prompt placeholder is never filled with actual data, and (2) `proposeNewEntities` collected from shards are never merged into the final entity list.

**Architecture:** Two independent fixes. First, `RequirementAnalyzer.analyze()` gains an optional `registry?` parameter and replaces `{registry_summary}` directly in the prompt template — `generation.ts` stops prepending the summary to `requirementText` and instead passes the registry object through. Second, `AnalyzeMerger.merge()` calls a new `_absorbProposedEntities()` helper right after pre-merge and in the single-artifact path, before canonicalization, so genuinely new entities proposed by shards receive canonical IDs and appear in the final output.

**Tech Stack:** TypeScript 5.5, Node.js 18+, Vitest 2, ESM (NodeNext)

---

## File Structure

| File | Change |
|------|--------|
| `src/generators/analyze.ts` | Add 2 imports, add `registry?` param, add template replacement |
| `src/tools/generation.ts` | Remove unused import, remove 9-line prepend block, pass registry as 6th arg |
| `src/generators/merge.ts` | Add `_absorbProposedEntities()` method, call it at 2 call sites |
| `tests/test_phase_b_entity_identity.test.ts` | New file — TDD tests for all 3 source changes |

---

## Background

### Current bug 1 — `{registry_summary}` never replaced

`requirement_analysis.md` has a `{registry_summary}` placeholder in the header that says "use `entityRef` for known entities". But `RequirementAnalyzer.analyze()` only replaces `{requirement_text}` and `{available_constraints}` in the template. The `{registry_summary}` slot stays as the literal text `{registry_summary}` in the final prompt, so the LLM never sees the actual entity list.

`generation.ts` attempts to work around this by prepending the summary to `requirementText`, which ends up buried inside the `<需求文档内容>` block — in the wrong location.

### Current bug 2 — `proposeNewEntities` orphaned

When analyze shards find entities not in the registry, they correctly put them in `proposeNewEntities`. `AnalyzeMerger.preMerge()` collects and dedupes these proposals, but they are never moved into `entities`. After `merge()` returns, the proposed entities are lost.

---

## Task 1: Fix `{registry_summary}` injection in `analyze.ts`

**Files:**
- Modify: `src/generators/analyze.ts:1-9` (imports)
- Modify: `src/generators/analyze.ts:35-57` (`analyze()` signature and prompt-build block)
- Test: `tests/test_phase_b_entity_identity.test.ts` (new file)

- [ ] **Step 1: Write the failing tests**

Create `tests/test_phase_b_entity_identity.test.ts`:

```typescript
/**
 * Phase B: Entity identity enforcement tests.
 *
 * Covers: {registry_summary} prompt injection (analyze.ts),
 * proposeNewEntities absorption (merge.ts).
 */
import { describe, it, expect, vi } from "vitest";

// ═══════════════════════════════════════════════════════
//  analyze.ts — {registry_summary} injection
// ═══════════════════════════════════════════════════════

describe("RequirementAnalyzer — registry_summary injection", () => {
  it("analyze() replaces {registry_summary} placeholder with actual entity IDs", async () => {
    const { RequirementAnalyzer } = await import("../src/generators/analyze.js");
    let capturedPrompt = "";
    const mockLlm = {
      generateJson: vi.fn().mockImplementation((prompt: string) => {
        capturedPrompt = prompt;
        return Promise.resolve({
          actors: [], functions: [], entities: [], constraints: [], exceptions: [],
          non_functional_requirements: [], business_processes: [],
          proposeNewEntities: [], proposeNewFunctions: [],
        });
      }),
    };
    const analyzer = new RequirementAnalyzer(mockLlm as any);
    // Template with both placeholders
    (analyzer as any).promptTemplate =
      "header: {registry_summary}\nbody: {requirement_text}\n{available_constraints}";

    const registry = {
      entities: [{ id: "E_CASE", canonicalName: "Case", displayName: "案件", aliases: ["Case"] }],
      actors: [],
    };

    await analyzer.analyze("some requirement text", 1, undefined, undefined, undefined, registry);

    // {registry_summary} slot must be filled with actual entity data
    expect(capturedPrompt).toContain("E_CASE");
    // Literal placeholder must NOT appear
    expect(capturedPrompt).not.toContain("{registry_summary}");
  });

  it("analyze() replaces {registry_summary} with empty string when no registry provided", async () => {
    const { RequirementAnalyzer } = await import("../src/generators/analyze.js");
    let capturedPrompt = "";
    const mockLlm = {
      generateJson: vi.fn().mockImplementation((prompt: string) => {
        capturedPrompt = prompt;
        return Promise.resolve({
          actors: [], functions: [], entities: [], constraints: [], exceptions: [],
          non_functional_requirements: [], business_processes: [],
          proposeNewEntities: [], proposeNewFunctions: [],
        });
      }),
    };
    const analyzer = new RequirementAnalyzer(mockLlm as any);
    (analyzer as any).promptTemplate =
      "header: {registry_summary}\nbody: {requirement_text}\n{available_constraints}";

    await analyzer.analyze("some requirement text", 1);

    // Literal placeholder must be gone
    expect(capturedPrompt).not.toContain("{registry_summary}");
    // Actual requirement text must still be present
    expect(capturedPrompt).toContain("some requirement text");
  });

  it("analyze() without {registry_summary} in template is unaffected", async () => {
    const { RequirementAnalyzer } = await import("../src/generators/analyze.js");
    let capturedPrompt = "";
    const mockLlm = {
      generateJson: vi.fn().mockImplementation((prompt: string) => {
        capturedPrompt = prompt;
        return Promise.resolve({
          actors: [], functions: [], entities: [], constraints: [], exceptions: [],
          non_functional_requirements: [], business_processes: [],
          proposeNewEntities: [], proposeNewFunctions: [],
        });
      }),
    };
    const analyzer = new RequirementAnalyzer(mockLlm as any);
    (analyzer as any).promptTemplate = "simple template: {requirement_text}\n{available_constraints}";

    const registry = {
      entities: [{ id: "E_CASE", canonicalName: "Case", displayName: "案件", aliases: ["Case"] }],
      actors: [],
    };

    await analyzer.analyze("some requirement text", 1, undefined, undefined, undefined, registry);

    // No errors, requirement text still present
    expect(capturedPrompt).toContain("some requirement text");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run tests/test_phase_b_entity_identity.test.ts --reporter=verbose
```

Expected: FAIL — `expect(capturedPrompt).toContain("E_CASE")` fails because `{registry_summary}` is never replaced.

- [ ] **Step 3: Add imports to `src/generators/analyze.ts`**

After the existing import block (line 9, after `import { BaseGenerator } from "./base.js";`), add two imports:

```typescript
import type { EntityRegistry } from "../shared/types.js";
import { buildRegistrySummary } from "../shared/registrySummary.js";
```

The file header should look like:

```typescript
import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";
import { RequirementNormalizer } from "../shared/normalizer.js";
import { createToolError } from "../tools/types.js";
import { BaseGenerator } from "./base.js";
import type { EntityRegistry } from "../shared/types.js";
import { buildRegistrySummary } from "../shared/registrySummary.js";
```

- [ ] **Step 4: Add `registry?` parameter to `analyze()` signature**

Change lines 35-41 in `src/generators/analyze.ts` from:

```typescript
  async analyze(
    requirementText: string,
    maxRetries = 3,
    systemPrompt?: string,
    existingJson?: Record<string, unknown>,
    availableConstraintsText?: string,
  ): Promise<Record<string, unknown>> {
```

To:

```typescript
  async analyze(
    requirementText: string,
    maxRetries = 3,
    systemPrompt?: string,
    existingJson?: Record<string, unknown>,
    availableConstraintsText?: string,
    registry?: EntityRegistry,
  ): Promise<Record<string, unknown>> {
```

- [ ] **Step 5: Add `{registry_summary}` replacement in prompt-build block**

After the `{available_constraints}` replacement (lines 54-56) and before `const prompt = prefix + tpl` (line 57), insert one statement:

```typescript
    const safeText = this.sanitizePlaceholder(requirementText || "", "requirement_text");
    let tpl = this.promptTemplate.replace(/\{requirement_text\}/g, safeText);
    if (availableConstraintsText !== undefined) {
      tpl = tpl.replace(/\{available_constraints\}/g, availableConstraintsText);
    }
    // NEW: Replace {registry_summary} in prompt template with actual registry data.
    // Falls back to empty string when no registry, clearing the placeholder.
    tpl = tpl.replace(
      /\{registry_summary\}/g,
      (registry && registry.entities.length > 0) ? buildRegistrySummary(registry) : "",
    );
    const prompt = prefix + tpl;
```

- [ ] **Step 6: Run test to verify it passes**

```
npx vitest run tests/test_phase_b_entity_identity.test.ts --reporter=verbose
```

Expected: PASS — all 3 registry_summary tests green.

- [ ] **Step 7: Run full suite to catch regressions**

```
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/generators/analyze.ts tests/test_phase_b_entity_identity.test.ts
git commit -m "fix(analyze): replace {registry_summary} placeholder with actual registry data"
```

---

## Task 2: Update `generation.ts` to pass registry directly to `analyze()`

**Files:**
- Modify: `src/tools/generation.ts:12` (remove import)
- Modify: `src/tools/generation.ts:128-172` (`_generateAnalyze` body)

- [ ] **Step 1: Remove the unused `buildRegistrySummary` import**

Line 12 of `src/tools/generation.ts` currently reads:

```typescript
import { buildRegistrySummary } from "../shared/registrySummary.js";
```

Remove this line entirely. After removal, the import block should go from line 11 (`import { BaseTool } from "./base.js";`) to the next import.

- [ ] **Step 2: Replace the registry-prepend block with a single variable declaration**

In `_generateAnalyze()`, lines 128–139 currently read:

```typescript
    // Inject registry summary if available in context hints
    const registry = ctx.registry as EntityRegistry | undefined;
    if (registry && registry.entities.length > 0) {
      const summary = buildRegistrySummary(registry);
      if (summary) {
        text = text.replace(/\{registry_summary\}/g, summary);
        // If placeholder wasn't in text, prepend it
        if (!text.includes(summary)) {
          text = `## 全局实体注册表\n${summary}\n\n${text}`;
        }
      }
    }
```

Replace with just:

```typescript
    const registry = ctx.registry as EntityRegistry | undefined;
```

- [ ] **Step 3: Pass `registry` as 6th argument to `analyzer.analyze()`**

The `analyzer.analyze()` call at the bottom of `_generateAnalyze()` (the `runWithStreamTagContext` callback) currently reads:

```typescript
      analyzer.analyze(text, 3, systemPrompt, existingJson, availableConstraintsText)
```

Change to:

```typescript
      analyzer.analyze(text, 3, systemPrompt, existingJson, availableConstraintsText, registry)
```

- [ ] **Step 4: Verify TypeScript compiles without errors**

```
npx tsc --noEmit
```

Expected: 0 errors. The `registry?: EntityRegistry` parameter is optional so no existing callers of `analyze()` break.

- [ ] **Step 5: Run full suite**

```
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools/generation.ts
git commit -m "fix(generation): pass registry to analyze() instead of prepending to requirementText"
```

---

## Task 3: Absorb `proposeNewEntities` into `entities` in `merge.ts`

**Files:**
- Modify: `src/generators/merge.ts` (add `_absorbProposedEntities`, call at 2 sites)
- Test: `tests/test_phase_b_entity_identity.test.ts` (add new describe block)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_phase_b_entity_identity.test.ts`:

```typescript
// ═══════════════════════════════════════════════════════
//  merge.ts — proposeNewEntities absorption
// ═══════════════════════════════════════════════════════

describe("AnalyzeMerger — proposeNewEntities absorbed into final entities", () => {
  it("merge() single-artifact: proposeNewEntities items are added to entities", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const merger = new (AnalyzeMerger as any)(null);

    const result = await merger.merge(
      [
        {
          taskId: "a1",
          content: {
            entities: [
              {
                entityRef: "E_CASE",
                name: "Case",
                description: "案件",
                attributes: [{ name: "id", type: "Long", description: "ID" }],
                relationships: [],
              },
            ],
            functions: [], actors: [], constraints: [], exceptions: [],
            non_functional_requirements: [], business_processes: [],
            proposeNewEntities: [
              {
                name: "Evidence",
                description: "证据",
                attributes: [{ name: "evidenceId", type: "Long", description: "证据ID" }],
                relationships: [],
              },
            ],
            proposeNewFunctions: [],
          },
        },
      ],
      "Case has an Evidence attachment."
    );

    const entities = result.entities as Array<Record<string, unknown>>;
    const evidenceEntity = entities.find(
      (e) => String(e.name ?? e.canonicalName ?? "").includes("Evidence"),
    );
    expect(evidenceEntity).toBeDefined();
  });

  it("merge() multi-artifact: proposeNewEntities from shards are absorbed", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const merger = new (AnalyzeMerger as any)(null);

    const result = await merger.merge(
      [
        {
          taskId: "a1",
          content: {
            entities: [
              { entityRef: "E_CASE", name: "Case", description: "案件", attributes: [], relationships: [] },
            ],
            functions: [], actors: [], constraints: [], exceptions: [],
            non_functional_requirements: [], business_processes: [],
            proposeNewEntities: [
              {
                name: "Evidence",
                description: "证据",
                attributes: [{ name: "evidenceId", type: "Long", description: "" }],
                relationships: [],
              },
            ],
            proposeNewFunctions: [],
          },
        },
        {
          taskId: "a2",
          content: {
            entities: [
              { entityRef: "E_USER", name: "User", description: "用户", attributes: [], relationships: [] },
            ],
            functions: [], actors: [], constraints: [], exceptions: [],
            non_functional_requirements: [], business_processes: [],
            proposeNewEntities: [],
            proposeNewFunctions: [],
          },
        },
      ],
      "Case has User and Evidence."
    );

    const entities = result.entities as Array<Record<string, unknown>>;
    const evidenceEntity = entities.find(
      (e) => String(e.name ?? e.canonicalName ?? "").includes("Evidence"),
    );
    expect(evidenceEntity).toBeDefined();
    // Original entities still present
    expect(entities.some((e) => String(e.name ?? "").includes("Case"))).toBe(true);
    expect(entities.some((e) => String(e.name ?? "").includes("User"))).toBe(true);
  });

  it("_absorbProposedEntities skips entities whose name already exists in entities", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const merger = new (AnalyzeMerger as any)(null);

    const result = await merger.merge(
      [
        {
          taskId: "a1",
          content: {
            entities: [
              { name: "Case", description: "案件（已有）", attributes: [], relationships: [] },
            ],
            functions: [], actors: [], constraints: [], exceptions: [],
            non_functional_requirements: [], business_processes: [],
            proposeNewEntities: [
              { name: "Case", description: "案件（重复）", attributes: [], relationships: [] },
            ],
            proposeNewFunctions: [],
          },
        },
      ],
      "Case entity dedup test."
    );

    const entities = result.entities as Array<Record<string, unknown>>;
    const caseEntities = entities.filter(
      (e) => String(e.name ?? e.canonicalName ?? "").toLowerCase().includes("case"),
    );
    // Must not have been duplicated
    expect(caseEntities.length).toBe(1);
  });

  it("absorbed entities receive canonical IDs via normalizeEntityIdentities", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const merger = new (AnalyzeMerger as any)(null);

    const result = await merger.merge(
      [
        {
          taskId: "a1",
          content: {
            entities: [],
            functions: [], actors: [], constraints: [], exceptions: [],
            non_functional_requirements: [], business_processes: [],
            proposeNewEntities: [
              {
                name: "EvidenceDocument",
                description: "证据文件",
                attributes: [{ name: "docId", type: "Long", description: "文件ID" }],
                relationships: [],
              },
            ],
            proposeNewFunctions: [],
          },
        },
      ],
      "EvidenceDocument is a core entity."
    );

    const entities = result.entities as Array<Record<string, unknown>>;
    const doc = entities.find(
      (e) => String(e.name ?? e.canonicalName ?? "").toLowerCase().includes("evidence"),
    );
    expect(doc).toBeDefined();
    // Should have a canonical ID (starts with E_)
    expect(String(doc!.id ?? "")).toMatch(/^E_/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx vitest run tests/test_phase_b_entity_identity.test.ts --reporter=verbose
```

Expected: FAIL — `expect(evidenceEntity).toBeDefined()` fails because `proposeNewEntities` is never absorbed.

- [ ] **Step 3: Add `_absorbProposedEntities` to `AnalyzeMerger` in `src/generators/merge.ts`**

Place this method inside the `AnalyzeMerger` class, just before the `_mergeEntities` method (around line 720). The `asArray` helper function used here is already defined at line 357.

```typescript
  /**
   * Absorb proposeNewEntities items from analyze shards into the main entities array.
   *
   * Items whose lowercased `name` already exists in entities are skipped to prevent
   * duplication. After absorption the `proposeNewEntities` key is deleted so downstream
   * steps (canonicalizeAndLink, normalizeEntityIdentities) only see `entities`.
   */
  private static _absorbProposedEntities(merged: Record<string, unknown>): void {
    const proposed = asArray(merged["proposeNewEntities"]);
    if (proposed.length === 0) return;

    const entities = asArray(merged["entities"]);
    const existingNames = new Set(
      entities.map((e) => String(e.name ?? e.canonicalName ?? "").trim().toLowerCase()),
    );

    for (const item of proposed) {
      const name = String(item.name ?? "").trim();
      if (!name || existingNames.has(name.toLowerCase())) continue;
      entities.push(item);
      existingNames.add(name.toLowerCase());
    }

    merged["entities"] = entities;
    delete merged["proposeNewEntities"];
  }
```

- [ ] **Step 4: Call `_absorbProposedEntities` in the single-artifact path of `merge()`**

Inside `merge()`, the single-artifact path (lines 402-413) currently reads:

```typescript
    if (artifacts.length === 1) {
      const single = artifacts[0].content as Record<string, unknown>;
      // 清理实体 ID：用 entityRef 覆盖旧 id
      for (const e of (single.entities as Array<Record<string, unknown>> | undefined) ?? []) {
        if (e.entityRef) e.id = e.entityRef;
      }
      // Canonicalize IDs & resolve cross-references first, then constraints
      canonicalizeAndLink(single);
      canonicalizeConstraintsPipeline(single);
      normalizeEntityIdentities(single, registry);
      return single;
    }
```

Add the absorption call after the entityRef cleanup and before `canonicalizeAndLink`:

```typescript
    if (artifacts.length === 1) {
      const single = artifacts[0].content as Record<string, unknown>;
      // 清理实体 ID：用 entityRef 覆盖旧 id
      for (const e of (single.entities as Array<Record<string, unknown>> | undefined) ?? []) {
        if (e.entityRef) e.id = e.entityRef;
      }
      AnalyzeMerger._absorbProposedEntities(single);
      // Canonicalize IDs & resolve cross-references first, then constraints
      canonicalizeAndLink(single);
      canonicalizeConstraintsPipeline(single);
      normalizeEntityIdentities(single, registry);
      return single;
    }
```

- [ ] **Step 5: Call `_absorbProposedEntities` in the multi-artifact path of `merge()`**

Right after `const preMerged = this.preMerge(artifacts, registry);` (line 417), add the absorption call:

```typescript
    // 程序化预合并：将所有分析结果按名称去重取并集
    const preMerged = this.preMerge(artifacts, registry);
    AnalyzeMerger._absorbProposedEntities(preMerged);
    const safeText = this.sanitizePlaceholder(requirementText || "", "requirement_text");
```

- [ ] **Step 6: Run tests to verify they pass**

```
npx vitest run tests/test_phase_b_entity_identity.test.ts --reporter=verbose
```

Expected: All 7 tests green.

- [ ] **Step 7: Run full suite**

```
npx vitest run
```

Expected: All existing tests pass plus the 7 new ones.

- [ ] **Step 8: Commit**

```bash
git add src/generators/merge.ts tests/test_phase_b_entity_identity.test.ts
git commit -m "fix(merge): absorb proposeNewEntities into entities before canonicalization"
```

---

## Task 4: Final verification

**Files:** No new changes — verification only.

- [ ] **Step 1: TypeScript type-check**

```
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 2: Full test suite**

```
npx vitest run
```

Expected: All tests pass (previous suite count + 7 new tests).

- [ ] **Step 3: Verify test count in new file**

```
npx vitest run tests/test_phase_b_entity_identity.test.ts --reporter=verbose
```

Expected output shows 7 tests: 3 for registry_summary injection, 4 for proposeNewEntities absorption.

- [ ] **Step 4: Commit if any final cleanup**

```bash
git add -A
git commit -m "chore: final cleanup for Phase B entity identity enforcement"
```

---

## Self-Review

**Spec coverage:**
- ✅ `{registry_summary}` placeholder replaced in `analyze()` → Task 1
- ✅ Registry passed as parameter, not prepended to text → Task 2  
- ✅ `proposeNewEntities` absorbed in single-artifact merge path → Task 3, Step 4
- ✅ `proposeNewEntities` absorbed in multi-artifact merge path → Task 3, Step 5
- ✅ Absorbed entities get canonical IDs → Verified by `normalizeEntityIdentities` called after absorption

**No placeholders:** All steps include exact code.

**Type consistency:** `registry?: EntityRegistry` used consistently across `analyze.ts` signature and `generation.ts` call site. `_absorbProposedEntities` uses the module-local `asArray()` helper already in `merge.ts`.

**Backward compatibility:**
- `analyze()` new `registry?` param is optional — existing callers unaffected
- `_absorbProposedEntities` deletes `proposeNewEntities` from merged output — downstream consumers never used this field anyway (confirmed by `grep proposeNew src/`)
- Single-artifact merge path now absorbs proposed entities — no tests relied on `proposeNewEntities` surviving after `merge()`
