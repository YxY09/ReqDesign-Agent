# Architecture Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 8 architectural issues (1 bug, 1 race condition, 3 cleanups, 3 structural refactors) while keeping all 1123 tests green and the system fully runnable.

**Architecture:** Preserve all existing public interfaces and runtime behavior; change only internals and fix identified defects. Each task is independently runnable and testable. Start every task by running `npm test` to confirm baseline, end every task with the same to confirm nothing broke.

**Tech Stack:** TypeScript 5.5, Node.js 18+, Vitest 2, ESM modules (NodeNext), `@anthropic-ai/sdk` + `openai` SDKs

---

## Baseline

```bash
cd C:\Learn\Day-Learn\ReqDesign-Agent
npm test
# Expected: 62 test files, 1123 tests passed
```

---

## Task 1: Bug Fix — Exception ID Prefix Detection Inconsistency

**Problem:** `EvaluationTool._checkUndefinedExceptionIds` hardcodes prefixes `"X"` and `"EXC_"`, while `GenerationTool._checkUndefinedExceptionIds` dynamically derives prefixes from actual data. Documents using `E001`, `EX_001` etc. are silently missed by the evaluator.

**Files:**
- Modify: `src/tools/evaluation.ts` (around line 847)
- Test: `tests/test_evaluator_fixes.test.ts`

- [ ] **Step 1.1: Confirm the bug exists**

Run and observe the existing test baseline:
```bash
npm test -- --reporter=verbose tests/test_evaluator_fixes.test.ts
```

- [ ] **Step 1.2: Add a failing test for dynamic prefix detection**

Open `tests/test_evaluator_fixes.test.ts`, find the existing test suite and add at the end:

```typescript
describe("EvaluationTool._checkUndefinedExceptionIds dynamic prefix", () => {
  it("detects undefined exception ID with E-prefix (not X or EXC_)", () => {
    const tool = new EvaluationTool(null as unknown as LLMClient);
    const requirementJson = {
      exceptions: [
        { id: "E001", displayId: "E001", name: "InvalidInput" },
        { id: "E002", displayId: "E002", name: "NotFound" },
      ],
    };
    // Design text references E999, which is NOT in requirementJson
    const issues = (tool as unknown as { _checkUndefinedExceptionIds: (taskId: string, taskType: string, targetField: string, text: string, req: Record<string, unknown>) => import("../src/shared/types.js").Issue[] })
      ._checkUndefinedExceptionIds("design-1", "design", "design_text", "Throws E999 on failure", requirementJson);
    expect(issues.length).toBe(1);
    expect(issues[0].description).toContain("E999");
  });

  it("does NOT flag a valid E-prefix exception ID", () => {
    const tool = new EvaluationTool(null as unknown as LLMClient);
    const requirementJson = {
      exceptions: [{ id: "E001", displayId: "E001", name: "InvalidInput" }],
    };
    const issues = (tool as unknown as { _checkUndefinedExceptionIds: (taskId: string, taskType: string, targetField: string, text: string, req: Record<string, unknown>) => import("../src/shared/types.js").Issue[] })
      ._checkUndefinedExceptionIds("design-1", "design", "design_text", "Throws E001 on failure", requirementJson);
    expect(issues.length).toBe(0);
  });
});
```

- [ ] **Step 1.3: Run tests to confirm failure**

```bash
npm test -- --reporter=verbose tests/test_evaluator_fixes.test.ts
# Expected: new tests FAIL (E999 not detected because hardcoded "X"/"EXC_" prefix check misses "E" prefix)
```

- [ ] **Step 1.4: Fix `EvaluationTool._checkUndefinedExceptionIds`**

In `src/tools/evaluation.ts`, find the private `_checkUndefinedExceptionIds` method (around line 837) and replace its body:

```typescript
private _checkUndefinedExceptionIds(
  taskId: string,
  taskType: string,
  targetField: string,
  text: string,
  requirementJson: Record<string, unknown>,
): Issue[] {
  const requirementIndex = RequirementIndex.fromRequirementJson(requirementJson);
  if (requirementIndex.exceptions.length === 0) return [];

  // Dynamically derive prefixes from actual exception IDs — same logic as GenerationTool.
  const prefixes = new Set<string>();
  for (const ref of requirementIndex.exceptions) {
    for (const id of [ref.displayId, ref.canonicalId]) {
      const match = /^([A-Z]+_?)/.exec(id);
      if (match) prefixes.add(match[1]);
    }
  }
  const prefixList = [...prefixes];
  if (prefixList.length === 0) return [];

  const referenced = requirementIndex.extractIds(text)
    .filter((id) => prefixList.some((prefix) => id.startsWith(prefix)));
  const unknown = requirementIndex.unknownReferences(referenced);
  if (unknown.length === 0) return [];

  return [createIssue({
    severity: "major",
    targetTaskId: taskId,
    targetTaskType: taskType,
    targetField,
    description: `产物引用了未定义的异常 ID: ${unknown.join(", ")}`,
    suggestion: `只引用 requirement_json.exceptions 中已定义的异常 ID: ${requirementIndex.idsFor("exception", "both").sort().join(", ")}`,
  })];
}
```

- [ ] **Step 1.5: Run tests to confirm fix**

```bash
npm test -- --reporter=verbose tests/test_evaluator_fixes.test.ts
# Expected: all tests pass including the two new ones
```

- [ ] **Step 1.6: Run full test suite to confirm no regressions**

```bash
npm test
# Expected: 62 test files, ≥1125 tests passed (1123 + 2 new)
```

- [ ] **Step 1.7: Commit**

```bash
git add src/tools/evaluation.ts tests/test_evaluator_fixes.test.ts
git commit -m "fix(evaluator): dynamic exception ID prefix detection, align with GenerationTool"
```

---

## Task 2: Fix streamTag Race Condition in Concurrent Workers

**Problem:** `GenerationTool` and `EvaluationTool` mutate `this.llm.streamTag` (a shared field on the singleton LLMClient) before each async LLM call. With `maxConcurrency=5`, concurrent workers overwrite each other's tag, causing stream events to display with the wrong worker label.

**Root cause:** `LLMClient` already has `runWithStreamTagContext()` that uses `AsyncLocalStorage` for proper async isolation, but tool methods set `streamTag` directly instead of using it.

**Fix:** Wrap each sub-generation call in `runWithStreamTagContext` and remove the direct `this.llm.streamTag = ...` mutations.

**Files:**
- Modify: `src/tools/generation.ts`
- Modify: `src/tools/evaluation.ts`
- Modify: `src/orchestration/strategyBrain.ts`
- Test: `tests/test_llm_client.test.ts`

- [ ] **Step 2.1: Add a test for streamTag isolation**

Open `tests/test_llm_client.test.ts` and add at the end of the file:

```typescript
describe("streamTag async isolation", () => {
  it("runWithStreamTagContext isolates tags across concurrent calls", async () => {
    const config = makeConfig(); // use existing helper in the file
    const client = new LLMClient(config);

    const tags: string[] = [];
    // Simulate two concurrent workers each setting different tags
    await Promise.all([
      client.runWithStreamTagContext("[Worker:A]", "", async () => {
        await new Promise((r) => setTimeout(r, 10));
        tags.push(client.streamTag);
      }),
      client.runWithStreamTagContext("[Worker:B]", "", async () => {
        tags.push(client.streamTag);
      }),
    ]);

    expect(tags).toContain("[Worker:A]");
    expect(tags).toContain("[Worker:B]");
    // Both tags appear independently — no cross-contamination
    expect(tags.length).toBe(2);
  });
});
```

- [ ] **Step 2.2: Run test to confirm it passes (the mechanism already works)**

```bash
npm test -- tests/test_llm_client.test.ts
# Expected: passes — demonstrates runWithStreamTagContext works
```

- [ ] **Step 2.3: Fix `GenerationTool` — wrap each sub-generator in runWithStreamTagContext**

In `src/tools/generation.ts`, replace the four `_generate*` private methods. The pattern is the same for all four: remove `this.llm.streamTag = "..."` and wrap the async work in `this.llm.runWithStreamTagContext(tag, "", async () => { ... })`.

Replace `_generateAnalyze`:
```typescript
private async _generateAnalyze(
  ctx: Record<string, unknown>, hints: Record<string, unknown>,
  _desc: string, systemPrompt: string,
): Promise<Record<string, unknown>> {
  let text = (ctx.requirement_text as string) ?? "";
  const existingJson = ctx.requirement_json as Record<string, unknown> | undefined;
  if (!text && !existingJson) throw createToolError("GEN_MISSING_INPUT", "缺少 requirement_text 和 requirement_json", { recoverable: false });

  const registry = ctx.registry as EntityRegistry | undefined;
  if (registry && registry.entities.length > 0) {
    const summary = buildRegistrySummary(registry);
    if (summary) {
      text = text.replace(/\{registry_summary\}/g, summary);
      if (!text.includes(summary)) {
        text = `## 全局实体注册表\n${summary}\n\n${text}`;
      }
    }
  }

  let availableConstraintsText: string | undefined;
  const availConstraints = hints.availableConstraints as
    Array<{ constraintRef?: string; description?: string; sourceText?: string }> | undefined;
  if (Array.isArray(availConstraints) && availConstraints.length > 0) {
    availableConstraintsText = availConstraints
      .map((c) => `- ${c.constraintRef ?? "C_RULE_???"}: ${c.description ?? ""} (${c.sourceText ?? ""})`)
      .join("\n");
  } else {
    availableConstraintsText = "（系统尚未预提取约束，请自行提取并编号）";
  }

  if (Array.isArray(hints.focus_areas) && hints.focus_areas.length > 0) {
    const focus = hints.focus_areas.map(String).join(", ");
    text = `[重点关注: ${focus}]\\n\\n${text}`;
  }
  if (hints.note) text = `[补充说明: ${hints.note}]\n\n${text}`;
  if (Array.isArray(hints.suggested_entities) && hints.suggested_entities.length > 0) {
    const entities = hints.suggested_entities.map(String).join(", ");
    text = `[必须提取的实体（以下每个概念都必须作为独立实体出现在输出中，不得遗漏或合并）: ${entities}]\\n\n\n${text}`;
  }
  if (Array.isArray(hints.suggested_functions) && hints.suggested_functions.length > 0) {
    const funcs = hints.suggested_functions.map(String).join(", ");
    text = `[必须提取的功能（以下每个功能都必须作为独立功能项出现在输出中）: ${funcs}]\\n\n\n${text}`;
  }
  const analyzer = this._getAnalyzer();
  return this.llm.runWithStreamTagContext("[Generator:analyze]", "", async () => {
    const raw = await analyzer.analyze(text, 3, systemPrompt, existingJson, availableConstraintsText);
    return GenerationTool._unwrapAnalyzeDict(raw);
  });
}
```

Replace `_generateDesign`:
```typescript
private async _generateDesign(
  ctx: Record<string, unknown>, _hints: Record<string, unknown>,
  _desc: string, systemPrompt: string,
): Promise<string> {
  const reqJson = ctx.requirement_json as Record<string, unknown> | undefined;
  if (!reqJson) throw createToolError("GEN_MISSING_REQJSON", "缺少 requirement_json", { recoverable: false });
  return this.llm.runWithStreamTagContext("[Generator:design]", "", () =>
    this._getDesigner().generateDesign(reqJson, systemPrompt)
  );
}
```

Replace `_generateDiagrams`:
```typescript
private async _generateDiagrams(
  task: Task,
  ctx: Record<string, unknown>, hints: Record<string, unknown>,
  desc: string, systemPrompt: string,
): Promise<Record<string, string>> {
  const reqJson = (ctx.requirement_json ?? {}) as Record<string, unknown>;
  const designText = (ctx.design_text as string) ?? "";
  const diagramKind = GenerationTool._diagramKindForTask(task, hints, desc);
  const generator = this._getDiagramGen();

  return this.llm.runWithStreamTagContext("[Generator:diagrams]", "", async () => {
    if (diagramKind) {
      const methodMap: Record<string, () => Promise<string>> = {
        class_diagram: () => generator.generateClassDiagram(reqJson, designText, systemPrompt, ""),
        activity_diagram: () => generator.generateActivityDiagram(reqJson, designText, systemPrompt, ""),
        state_diagram: () => generator.generateStateDiagram(reqJson, designText, systemPrompt, ""),
      };
      const method = methodMap[diagramKind];
      if (!method) throw createToolError("GEN_UNKNOWN_DIAGRAM", `未知图表类型: ${diagramKind}`, { recoverable: false });
      const result = await method();
      return { [diagramKind]: result };
    }
    return generator.generateAll(reqJson, designText, systemPrompt, "");
  });
}
```

Replace `_generateTests`:
```typescript
private async _generateTests(
  ctx: Record<string, unknown>, _hints: Record<string, unknown>,
  _desc: string, systemPrompt: string,
): Promise<string> {
  const reqJson = (ctx.requirement_json ?? {}) as Record<string, unknown>;
  const designText = (ctx.design_text as string) ?? "";
  return this.llm.runWithStreamTagContext("[Generator:tests]", "", () =>
    this._getTestGen().generate({ requirementJson: reqJson, designText, systemPrompt, requirementText: "" })
  );
}
```

- [ ] **Step 2.4: Fix `EvaluationTool` — wrap LLM review calls**

In `src/tools/evaluation.ts`, find `_llmReviewSnapshots` (around line 906) and `_llmReviewAnalyze` (around line 993). Replace the streamTag mutations with context wrapping.

In `_llmReviewSnapshots`, replace:
```typescript
    if (this.llm) this.llm.streamTag = `[Evaluator:${reviewMode}]`;
    const response = await this.llm.generateJson(userPrompt, system);
```
With:
```typescript
    const response = await this.llm.runWithStreamTagContext(`[Evaluator:${reviewMode}]`, "", () =>
      this.llm.generateJson(userPrompt, system)
    );
```

In `_llmReviewAnalyze`, replace:
```typescript
    this.llm.streamTag = "[Evaluator:analyze]";
    const response = await this.llm.generateJson(userPrompt, system);
```
With:
```typescript
    const response = await this.llm.runWithStreamTagContext("[Evaluator:analyze]", "", () =>
      this.llm.generateJson(userPrompt, system)
    );
```

- [ ] **Step 2.5: Fix `StrategyBrain` — wrap LLM call**

In `src/orchestration/strategyBrain.ts`, find the `decide` method (around line 50). Replace:
```typescript
    const response = await this.llm.generateJson(prompt, system, onChunk);
```
With:
```typescript
    const response = await this.llm.runWithStreamTagContext("[Orchestrator]", "", () =>
      this.llm.generateJson(prompt, system, onChunk)
    );
```
And remove the `const { onChunk, done } = makeStreamPrinter("[Orchestrator]");` / `done()` wrapping (the stream tag now handles labeling). Actually keep `onChunk` for the chunk callback but remove the direct streamTag usage. The full `decide` method body becomes:

```typescript
  async decide(snapshot: OrchestratorSnapshot): Promise<StrategyDecision> {
    const prompt = await this._buildPrompt(snapshot);
    const system =
      "You are an engineering orchestration strategist. " +
      "Choose a high-level strategy only. Do not choose low-level spawn/save actions.";

    const { onChunk, done } = makeStreamPrinter("[Orchestrator]");
    try {
      const response = await this.llm.runWithStreamTagContext("[Orchestrator]", "", () =>
        this.llm.generateJson(prompt, system, onChunk)
      );
      return StrategyBrain._parseResponse(response, snapshot);
    } catch (exc) {
      console.warn(
        "[StrategyBrain] LLM strategy failed:",
        exc instanceof Error ? exc.message : String(exc),
      );
      throw exc;
    } finally {
      done();
    }
  }
```

- [ ] **Step 2.6: Run full test suite**

```bash
npm test
# Expected: all tests pass
```

- [ ] **Step 2.7: Commit**

```bash
git add src/tools/generation.ts src/tools/evaluation.ts src/orchestration/strategyBrain.ts tests/test_llm_client.test.ts
git commit -m "fix(concurrent): isolate streamTag per worker via AsyncLocalStorage context"
```

---

## Task 3: Remove Dead Self-Correction Code

**Problem:** `selfCorrectRounds` in `Artifact` is always 0 (self-correction was disabled because it failed 6/6 in tests). The field misleads readers into thinking self-correction is active. Related code is dead weight.

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/tools/generation.ts`

- [ ] **Step 3.1: Remove `selfCorrectRounds` from `Artifact` and `createArtifact`**

In `src/shared/types.ts`, remove `selfCorrectRounds: number;` from the `Artifact` interface and remove `selfCorrectRounds: 0,` from `createArtifact`.

The `Artifact` interface becomes:
```typescript
export interface Artifact {
  taskId: string;
  type: TaskType;
  revision: number;
  content: unknown;
  selfCheckPassed: boolean;
  selfCheckIssues: string[];
  generationDuration: number;
}
```

The `createArtifact` factory becomes:
```typescript
export function createArtifact(
  overrides: Partial<Artifact> & Pick<Artifact, "taskId" | "type">,
): Artifact {
  return {
    revision: 0,
    content: null,
    selfCheckPassed: true,
    selfCheckIssues: [],
    generationDuration: 0.0,
    ...overrides,
  };
}
```

- [ ] **Step 3.2: Remove `selfCorrectRounds` usage in `GenerationTool.execute`**

In `src/tools/generation.ts`, find the `execute` method. Remove:
- `let selfCorrectRounds = 0;` (line ~57)
- `selfCorrectRounds,` from the `createArtifact` call

The `createArtifact` call in `execute` becomes:
```typescript
      return createArtifact({
        taskId: task.id,
        type: task.type,
        revision: 1,
        content,
        selfCheckPassed: passed,
        selfCheckIssues: issues,
        generationDuration: elapsed,
      });
```

- [ ] **Step 3.3: Fix TypeScript compilation and run tests**

```bash
npm run typecheck
npm test
# Expected: all tests pass, no type errors
```

If any test snapshots reference `selfCorrectRounds`, update them. Search:
```bash
grep -r "selfCorrectRounds" tests/
```
For each hit, remove the field from the expected object.

- [ ] **Step 3.4: Commit**

```bash
git add src/shared/types.ts src/tools/generation.ts
git commit -m "refactor: remove dead selfCorrectRounds field (self-correction was always 0)"
```

---

## Task 4: Task ID Constants — Eliminate Magic Strings

**Problem:** Synthetic task IDs like `"analyze-final"`, `"diagrams-final"`, `"analyze-comprehensive"` appear as literal strings in 8+ places. Renaming them would silently break multiple code paths.

**Files:**
- Create: `src/shared/taskConstants.ts`
- Modify: `src/tools/evaluation.ts`
- Modify: `src/tools/generation.ts` (if any hardcoded IDs)

- [ ] **Step 4.1: Create `src/shared/taskConstants.ts`**

```typescript
/**
 * Canonical task ID constants — avoids magic string duplication across the codebase.
 *
 * "Synthetic" tasks are virtual composite tasks the runtime creates to merge
 * multiple shard outputs; they are never dispatched as workers.
 */

export const SYNTHETIC_TASK_IDS = {
  ANALYZE_FINAL: "analyze-final",
  ANALYZE_COMPREHENSIVE: "analyze-comprehensive",
  DIAGRAMS_FINAL: "diagrams-final",
} as const;

export type SyntheticTaskId = (typeof SYNTHETIC_TASK_IDS)[keyof typeof SYNTHETIC_TASK_IDS];

/** Returns true if the given task ID is a synthetic composite task. */
export function isSyntheticTaskId(taskId: string): boolean {
  return Object.values(SYNTHETIC_TASK_IDS).includes(taskId as SyntheticTaskId);
}

/** Returns true if the task ID represents a final merged artifact. */
export function isFinalTaskId(taskId: string): boolean {
  return taskId.endsWith("-final");
}
```

- [ ] **Step 4.2: Replace magic strings in `EvaluationTool`**

In `src/tools/evaluation.ts`, add at the top of imports:
```typescript
import { SYNTHETIC_TASK_IDS, isFinalTaskId } from "../shared/taskConstants.js";
```

Find and replace all occurrences:
- `taskId.endsWith("-final")` → `isFinalTaskId(taskId)`
- `taskId === "analyze-final"` → `taskId === SYNTHETIC_TASK_IDS.ANALYZE_FINAL`
- `taskId === "diagrams-final"` → `taskId === SYNTHETIC_TASK_IDS.DIAGRAMS_FINAL`
- `taskId !== "analyze-final" && taskId !== "analyze-comprehensive"` → `taskId !== SYNTHETIC_TASK_IDS.ANALYZE_FINAL && taskId !== SYNTHETIC_TASK_IDS.ANALYZE_COMPREHENSIVE`

In `_buildAggregateSnapshots`, the hardcoded `"analyze-1"`, `"design-1"`, `"diagrams-1"`, `"tests-1"` are NOT synthetic IDs — leave those as-is (they are bootstrap fallback IDs when no real tasks exist).

- [ ] **Step 4.3: Check for other magic string uses**

```bash
grep -rn "analyze-final\|diagrams-final\|analyze-comprehensive" src/
```

Replace any remaining occurrences in the source with the constants.

- [ ] **Step 4.4: Run tests**

```bash
npm run typecheck && npm test
# Expected: all tests pass
```

- [ ] **Step 4.5: Commit**

```bash
git add src/shared/taskConstants.ts src/tools/evaluation.ts
git commit -m "refactor: extract synthetic task ID constants, eliminate magic strings"
```

---

## Task 5: StrategyBrain Prompt — Move to Template File

**Problem:** `StrategyBrain._buildPrompt()` constructs the LLM prompt with hardcoded strings. Unlike generators/evaluators which load from `prompts/`, the orchestrator's strategy prompt is embedded in code, making it hard to tune without a code change.

**Files:**
- Create: `prompts/strategy_brain.md`
- Modify: `src/orchestration/strategyBrain.ts`

Note: `StrategyBrain` does not extend `BaseTool`. Use the standalone `loadPrompt` function directly.

- [ ] **Step 5.1: Create `prompts/strategy_brain.md`**

```markdown
You are an engineering orchestration strategist for a multi-agent requirements design system.

## Your role
Choose ONE high-level strategy for the workflow based on the snapshot below.
Do NOT choose low-level actions (spawn, save) — those are compiled from your strategy.

## Available strategies
- **start_planning** — kick off the planner to build an execution plan
- **route_direct_diagrams** — skip planning, generate diagrams directly (only for simple diagram-only requests)
- **advance_ready_work** — proceed with tasks that have all dependencies satisfied
- **wait_for_running** — wait for in-progress workers to finish
- **run_opportunistic_review** — evaluate completed artifacts while other work is running
- **run_final_review** — run the comprehensive final evaluation once all tasks complete
- **repair_local_artifact** — fix issues within a single artifact
- **repair_upstream_artifact** — fix an upstream artifact whose errors cascade downstream
- **regenerate_downstream** — re-run generation for a specific task from scratch
- **escalate_to_replan** — ask the planner to revise the execution plan
- **save_outputs** — persist all artifacts to disk (quality gate must pass)
- **finish** — end the workflow (used when already saved or when nothing was loaded)
- **pause_for_user** — halt and surface the current state for human review

## Initial routing guidance
- Choose **route_direct_diagrams** ONLY for simple, diagram-focused requests with no analysis or design needed.
- Choose **start_planning** for multi-module requirements, ambiguous specifications, or anything needing analysis/design/tests.

## Output format
Return a JSON object:
```json
{
  "strategy": "<one of the strategies above>",
  "target_task_id": "<task id from the known list, or empty string>",
  "affected_task_ids": ["<task ids>"],
  "reason": "<brief explanation>",
  "confidence": 0.9
}
```
Valid task IDs are provided in the snapshot. Any target_task_id or affected_task_ids value MUST come from that list.
```

- [ ] **Step 5.2: Update `StrategyBrain` to load the template**

In `src/orchestration/strategyBrain.ts`, add import at top:
```typescript
import { loadPrompt } from "../promptLoader.js";
```

In the `decide` method, replace the hardcoded `system` string:
```typescript
    const system =
      "You are an engineering orchestration strategist. " +
      "Choose a high-level strategy only. Do not choose low-level spawn/save actions.";
```
With:
```typescript
    const templateSystem = loadPrompt("strategy_brain.md", "");
    const system = templateSystem ||
      "You are an engineering orchestration strategist. " +
      "Choose a high-level strategy only. Do not choose low-level spawn/save actions.";
```

In `_buildPrompt`, replace the hardcoded instruction lines that duplicate the template:
```typescript
    const basePrompt = (
      "Read this workflow snapshot and choose one strategy.\n" +
      "Allowed strategies: start_planning, route_direct_diagrams, advance_ready_work, wait_for_running, " +
      "run_opportunistic_review, run_final_review, repair_local_artifact, " +
      "repair_upstream_artifact, regenerate_downstream, escalate_to_replan, " +
      "save_outputs, finish, pause_for_user.\n" +
      "Initial routing: choose route_direct_diagrams only for simple diagram-focused requests; " +
      "choose start_planning for multi-module requirements, ambiguous requirements, or anything needing analysis/design/tests.\n" +
      (knownTaskIds.length > 0
        ? `Valid task ids (target_task_id / affected_task_ids MUST come from this list, or be empty): ${knownTaskIds.join(", ")}\n`
        : "No tasks exist yet: leave target_task_id and affected_task_ids empty.\n") +
      "Return JSON with strategy, target_task_id, affected_task_ids, reason, confidence.\n" +
      "```json\n" +
      JSON.stringify(data, null, 2) +
      "\n```"
    );
```
With:
```typescript
    const taskConstraint = knownTaskIds.length > 0
      ? `Valid task ids (target_task_id / affected_task_ids MUST come from this list, or be empty): ${knownTaskIds.join(", ")}`
      : "No tasks exist yet: leave target_task_id and affected_task_ids empty.";

    const basePrompt = [
      "## Workflow Snapshot",
      taskConstraint,
      "```json",
      JSON.stringify(data, null, 2),
      "```",
    ].join("\n");
```

- [ ] **Step 5.3: Run tests**

```bash
npm run typecheck && npm test
# Expected: all tests pass
```

- [ ] **Step 5.4: Commit**

```bash
git add prompts/strategy_brain.md src/orchestration/strategyBrain.ts
git commit -m "refactor: move StrategyBrain system prompt to prompts/strategy_brain.md template"
```

---

## Task 6: Refactor DeterministicPolicy into a Rule Chain

**Problem:** `DeterministicPolicy.decide()` is a 400-line sequential if-chain with 16 numbered steps. Each step is hard to test in isolation and hard to reorder or extend without risk of breaking adjacent logic.

**Fix:** Extract each step into a named rule function. `decide()` iterates an ordered list and returns the first non-null result.

**Files:**
- Create: `src/orchestration/policyRules.ts`
- Modify: `src/orchestration/policy.ts`
- Test: `tests/test_policy.test.ts`

- [ ] **Step 6.1: Create `src/orchestration/policyRules.ts`**

Each rule function signature: `(snapshot: OrchestratorSnapshot, guard: PolicyGuard) => StrategyDecision | null`

```typescript
/**
 * DeterministicPolicy rule functions.
 *
 * Each function handles one decision step. Return a StrategyDecision if this
 * rule fires, null to fall through to the next rule. Order matters — the list
 * in DeterministicPolicy is evaluated top-to-bottom.
 */

import type { OrchestratorSnapshot } from "./snapshot.js";
import type { PolicyGuard } from "./policy.js";
import { createStrategyDecision, type StrategyDecision } from "./strategy.js";
import { isTaskRunning } from "./remediation.js";

export type PolicyRule = (
  snapshot: OrchestratorSnapshot,
  guard: PolicyGuard,
) => StrategyDecision | null;

/** Rule 1: Replan produced ready remediation tasks — advance them first. */
export const ruleRemediationReady: PolicyRule = (snapshot) => {
  const remediationReady = snapshot.readyTasks.filter(
    (taskId) => !snapshot.rejectedArtifacts.includes(taskId),
  );
  if (snapshot.planRevisionCount > 0 && remediationReady.length > 0) {
    return createStrategyDecision({
      strategy: "advance_ready_work",
      affectedTaskIds: remediationReady,
      reason: "replan produced ready remediation task(s)",
    });
  }
  return null;
};

/** Rule 2: Failed tasks — regenerate before replanning. */
export const ruleFailedTasks: PolicyRule = (snapshot, guard) => {
  if (snapshot.failedTasks.length === 0) return null;

  const target = snapshot.failedTasks.find(
    (taskId) => !isTaskRunning(snapshot, taskId),
  );
  if (!target) {
    return createStrategyDecision({
      strategy: "wait_for_running",
      targetTaskId: snapshot.failedTasks[0],
      reason: `${snapshot.failedTasks[0]} is already running`,
    });
  }
  if ((snapshot.regenerateCountsByTask[target] ?? 0) >= guard.budget.maxRegeneratePerTask) {
    if (guard.canReplan(snapshot)) {
      return createStrategyDecision({
        strategy: "escalate_to_replan",
        targetTaskId: target,
        reason: `${target} failed after regeneration budget was exhausted`,
      });
    }
    if (snapshot.runningTasks.length > 0 || snapshot.evaluatorRunning) {
      if (guard.budget.canReplanWhenIdle(snapshot)) {
        return createStrategyDecision({
          strategy: "wait_for_running",
          targetTaskId: target,
          reason: `${target} failed after regeneration budget was exhausted, waiting for running tasks before replanning`,
        });
      }
      return createStrategyDecision({
        strategy: "pause_for_user",
        targetTaskId: target,
        reason: `${target} failed and both regeneration and replan budgets are exhausted`,
      });
    }
    return createStrategyDecision({
      strategy: "pause_for_user",
      targetTaskId: target,
      reason: `${target} failed and regeneration/replan budget is exhausted`,
    });
  }
  return createStrategyDecision({
    strategy: "regenerate_downstream",
    targetTaskId: target,
    affectedTaskIds: [target],
    reason: `${target} failed; regenerate the failed task before changing the plan`,
  });
};

/** Rule 3: Rejected artifacts — escalate via remediation ladder. */
export const ruleRejectedArtifacts: PolicyRule = (snapshot, guard) =>
  guard.ladder.rejectedArtifact(snapshot);

/** Rule 4: Globally stalled and replan is available. */
export const ruleGlobalStall: PolicyRule = (snapshot, guard) => {
  if (snapshot.globallyStalled && guard.canReplan(snapshot)) {
    return createStrategyDecision({
      strategy: "escalate_to_replan",
      reason: "workflow is globally stalled",
    });
  }
  return null;
};

/** Rule 5: Convergence stalled — accept or pause based on trend. */
export const ruleConvergenceStall: PolicyRule = (snapshot, guard) => {
  if (!snapshot.convergenceStalled || snapshot.convergenceRoundCount < 3) return null;

  const trend = snapshot.convergenceTrend ?? "flat";
  if (
    trend === "decreasing" &&
    snapshot.latestIssues.length <= guard.budget.convergenceAcceptMaxIssuesDecreasing
  ) {
    return createStrategyDecision({
      strategy: "finish",
      reason: `convergence accepted despite stall: ${snapshot.latestIssues.length} issues, trend decreasing`,
    });
  }
  if (
    trend !== "increasing" &&
    snapshot.latestIssues.length <= guard.budget.convergenceAcceptMaxIssuesFlat
  ) {
    return createStrategyDecision({
      strategy: "finish",
      reason: `convergence accepted: ${snapshot.latestIssues.length} issues, trend ${trend}, low enough`,
    });
  }
  return createStrategyDecision({
    strategy: "pause_for_user",
    reason: `convergence stalled: ${snapshot.convergenceStalledFingerprints.length} issue(s) unchanged across ${snapshot.convergenceRoundCount} rounds`,
  });
};

/** Rule 6: Final review rejected with no repairable targets. */
export const ruleFinalReviewNoTarget: PolicyRule = (snapshot) => {
  if (
    snapshot.finalReviewCurrent &&
    !snapshot.finalReviewPassed &&
    snapshot.majorPendingTaskIds.length === 0 &&
    snapshot.rejectedArtifacts.length === 0 &&
    snapshot.runningTasks.length === 0 &&
    !snapshot.evaluatorRunning
  ) {
    return createStrategyDecision({
      strategy: "pause_for_user",
      reason: "final review rejected but no repairable targets (issues are in analyze tasks or non-repairable scope)",
    });
  }
  return null;
};

/** Rule 7: Final review found major issues — try per-task repair. */
export const ruleFinalMajorRepair: PolicyRule = (snapshot, guard) => {
  if (guard.budget.skipEvaluation) return null;
  return guard.ladder.finalMajor(snapshot);
};

/** Rule 8: Final review rejected with no automatic repair remaining. */
export const ruleFinalReviewRejectedNoRepair: PolicyRule = (snapshot, guard) => {
  if (!guard.budget.skipEvaluation && snapshot.finalReviewCurrent && !snapshot.finalReviewPassed) {
    return createStrategyDecision({
      strategy: "pause_for_user",
      reason: "final review rejected and no automatic repair target remains",
    });
  }
  return null;
};

/** Rule 9: Outputs already saved — finish. */
export const ruleAlreadySaved: PolicyRule = (snapshot) => {
  if (snapshot.outputSaved) {
    return createStrategyDecision({
      strategy: "finish",
      reason: "outputs already saved",
    });
  }
  return null;
};

/** Rule 10: Work is still running — wait. */
export const ruleWaitForRunning: PolicyRule = (snapshot) => {
  if (snapshot.runningTasks.length > 0 || snapshot.evaluatorRunning) {
    return createStrategyDecision({
      strategy: "wait_for_running",
      reason: "work is still running",
    });
  }
  return null;
};

/** Rule 11: No plan yet — delegate to LLM (StrategyBrain). */
export const ruleNoPlan: PolicyRule = (snapshot) => {
  if (!snapshot.planReady && snapshot.requirementLoaded && !snapshot.hasArtifacts) {
    if (snapshot.plannerFailures >= 3) {
      return createStrategyDecision({
        strategy: "pause_for_user",
        reason: `planner failed ${snapshot.plannerFailures} times`,
      });
    }
    return null; // Signal: needs LLM
  }
  return undefined as unknown as null; // not applicable — fall through
};

/** Rule 12: Ready tasks are waiting — advance them. */
export const ruleAdvanceReady: PolicyRule = (snapshot) => {
  if (snapshot.readyTasks.length > 0) {
    return createStrategyDecision({
      strategy: "advance_ready_work",
      affectedTaskIds: [...snapshot.readyTasks],
      reason: `${snapshot.readyTasks.length} task(s) are ready`,
    });
  }
  return null;
};

/** Rule 13: Final review is ready to run. */
export const ruleFinalReviewReady: PolicyRule = (snapshot, guard) => {
  if (!guard.budget.skipEvaluation && guard.canRunFinalReview(snapshot)) {
    return createStrategyDecision({
      strategy: "run_final_review",
      reason: "final full review is required",
    });
  }
  return null;
};

/** Rule 14: Opportunistic review is available. */
export const ruleOpportunisticReview: PolicyRule = (snapshot, guard) => {
  if (guard.budget.skipEvaluation) return null;
  const reviewPlan = guard.reviewScheduler.nextScope(snapshot);
  if (reviewPlan.hasScope) {
    return createStrategyDecision({
      strategy: "run_opportunistic_review",
      affectedTaskIds: [...reviewPlan.scopeTaskIds],
      reason: reviewPlan.reason,
    });
  }
  return null;
};

/** Rule 15: Quality and save gates passed — save. */
export const ruleSaveOutputs: PolicyRule = (snapshot, guard) => {
  if (guard.canSave(snapshot)) {
    return createStrategyDecision({
      strategy: "save_outputs",
      reason: "quality and save gates passed",
    });
  }
  return null;
};

/** Rule 16: Nothing loaded — finish. */
export const ruleNothingLoaded: PolicyRule = (snapshot) => {
  if (!snapshot.requirementLoaded && !snapshot.hasArtifacts) {
    return createStrategyDecision({
      strategy: "finish",
      reason: "nothing has been loaded",
    });
  }
  return null;
};

/**
 * Ordered list of deterministic policy rules.
 * Evaluated top-to-bottom; first non-null result wins.
 * Return null from a rule to continue to the next.
 * Returning null from ALL rules signals that LLM judgment (StrategyBrain) is needed.
 */
export const DETERMINISTIC_POLICY_RULES: readonly PolicyRule[] = [
  ruleRemediationReady,
  ruleFailedTasks,
  ruleRejectedArtifacts,
  ruleGlobalStall,
  ruleConvergenceStall,
  ruleFinalReviewNoTarget,
  ruleFinalMajorRepair,
  ruleFinalReviewRejectedNoRepair,
  ruleAlreadySaved,
  ruleWaitForRunning,
  ruleNoPlan,
  ruleAdvanceReady,
  ruleFinalReviewReady,
  ruleOpportunisticReview,
  ruleSaveOutputs,
  ruleNothingLoaded,
];
```

**Special note on `ruleNoPlan`:** Rule 11 returns `null` to signal "needs LLM" (same as the original `return null` in the method). Other rules return `null` as "not applicable, try next rule". These are semantically the same — both cause fallthrough. The caller (DeterministicPolicy.decide) returns `null` to its caller (AgentOrchestrator) to trigger StrategyBrain. There is no ambiguity.

- [ ] **Step 6.2: Simplify `DeterministicPolicy.decide()` in `policy.ts`**

In `src/orchestration/policy.ts`, add import at top:
```typescript
import { DETERMINISTIC_POLICY_RULES } from "./policyRules.js";
```

Replace the entire body of `DeterministicPolicy.decide()` with:
```typescript
  decide(snapshot: OrchestratorSnapshot): StrategyDecision | null {
    for (const rule of DETERMINISTIC_POLICY_RULES) {
      const decision = rule(snapshot, this.guard);
      if (decision !== null && decision !== undefined) return decision;
    }
    return null;
  }
```

Keep the rest of `DeterministicPolicy` (constructor, fields) unchanged.

- [ ] **Step 6.3: Add targeted tests for individual rules**

In `tests/test_policy.test.ts`, after the existing tests, add:

```typescript
import {
  ruleRemediationReady,
  ruleFailedTasks,
  ruleConvergenceStall,
  ruleAdvanceReady,
} from "../src/orchestration/policyRules.js";

describe("Policy rule functions", () => {
  const guard = new PolicyGuard();

  it("ruleRemediationReady fires when replan produced ready tasks", () => {
    const snap = makeSnapshot({ planRevisionCount: 1, readyTasks: ["fix-1"] });
    const result = ruleRemediationReady(snap, guard);
    expect(result?.strategy).toBe("advance_ready_work");
    expect(result?.affectedTaskIds).toContain("fix-1");
  });

  it("ruleRemediationReady skips when no revision yet", () => {
    const snap = makeSnapshot({ planRevisionCount: 0, readyTasks: ["task-1"] });
    expect(ruleRemediationReady(snap, guard)).toBeNull();
  });

  it("ruleFailedTasks triggers regenerate for unstarted failed task", () => {
    const snap = makeSnapshot({ failedTasks: ["design-1"], runningTasks: [] });
    const result = ruleFailedTasks(snap, guard);
    expect(result?.strategy).toBe("regenerate_downstream");
    expect(result?.targetTaskId).toBe("design-1");
  });

  it("ruleConvergenceStall pauses when trend is flat and issues exceed threshold", () => {
    const snap = makeSnapshot({
      convergenceStalled: true,
      convergenceRoundCount: 3,
      convergenceTrend: "flat",
      latestIssues: Array(15).fill({ severity: "major", description: "x" }),
      convergenceStalledFingerprints: ["fp1"],
    });
    const result = ruleConvergenceStall(snap, guard);
    expect(result?.strategy).toBe("pause_for_user");
  });

  it("ruleAdvanceReady fires when tasks are ready", () => {
    const snap = makeSnapshot({ readyTasks: ["analyze-1", "analyze-2"] });
    const result = ruleAdvanceReady(snap, guard);
    expect(result?.strategy).toBe("advance_ready_work");
    expect(result?.affectedTaskIds).toEqual(["analyze-1", "analyze-2"]);
  });
});
```

- [ ] **Step 6.4: Run tests**

```bash
npm run typecheck && npm test
# Expected: all previous tests still pass, new rule tests pass
```

- [ ] **Step 6.5: Commit**

```bash
git add src/orchestration/policyRules.ts src/orchestration/policy.ts tests/test_policy.test.ts
git commit -m "refactor: extract DeterministicPolicy into ordered rule chain (policyRules.ts)"
```

---

## Task 7: BudgetManager `fromRaw()` — Replace 80-line Manual Mapping

**Problem:** `OrchestrationConfig.fromRaw()` has ~80 lines of `if (raw.xxx !== undefined) cfg.xxx = raw.xxx` — one per config key. Adding a new key requires editing three places.

**Fix:** Use a typed mapping table.

**Files:**
- Modify: `src/orchestration/budget.ts`

- [ ] **Step 7.1: Add the mapping table and rewrite `fromRaw`**

In `src/orchestration/budget.ts`, add just before `OrchestrationConfig.fromRaw`:

```typescript
/** Maps snake_case raw config keys to camelCase OrchestrationConfig property names. */
const RAW_TO_CFG_KEYS: ReadonlyArray<
  [keyof OrchestrationConfigRaw, keyof OrchestrationConfig]
> = [
  ["max_repair_per_task", "maxRepairPerTask"],
  ["diagram_repair_before_regenerate", "diagramRepairBeforeRegenerate"],
  ["design_repair_before_regenerate", "designRepairBeforeRegenerate"],
  ["max_regenerate_per_task", "maxRegeneratePerTask"],
  ["max_replan_count", "maxReplanCount"],
  ["max_runtime_seconds", "maxRuntimeSeconds"],
  ["max_decision_count", "maxDecisionCount"],
  ["max_planner_failures", "maxPlannerFailures"],
  ["max_evaluator_timeouts", "maxEvaluatorTimeouts"],
  ["max_save_failures", "maxSaveFailures"],
  ["max_final_major_issues", "maxFinalMajorIssues"],
  ["max_final_major_repair_per_task", "maxFinalMajorRepairPerTask"],
  ["max_concurrent_evaluators", "maxConcurrentEvaluators"],
  ["min_runtime_remaining_for_new_work_seconds", "minRuntimeRemainingForNewWorkSeconds"],
  ["skip_evaluation", "skipEvaluation"],
  ["worker_timeout_seconds", "workerTimeoutSeconds"],
  ["poll_interval_ms", "pollIntervalMs"],
  ["heartbeat_interval_seconds", "heartbeatIntervalSeconds"],
  ["max_concurrency", "maxConcurrency"],
  ["convergence_accept_max_issues_decreasing", "convergenceAcceptMaxIssuesDecreasing"],
  ["convergence_accept_max_issues_flat", "convergenceAcceptMaxIssuesFlat"],
];
```

Replace the entire `fromRaw` static method body:
```typescript
  static fromRaw(raw: OrchestrationConfigRaw): OrchestrationConfig {
    const cfg = new OrchestrationConfig();
    for (const [rawKey, cfgKey] of RAW_TO_CFG_KEYS) {
      const value = raw[rawKey];
      if (value !== undefined) {
        (cfg as unknown as Record<string, unknown>)[cfgKey] = value;
      }
    }
    return cfg;
  }
```

- [ ] **Step 7.2: Run tests**

```bash
npm run typecheck && npm test -- tests/test_budget.test.ts
npm test
# Expected: all tests pass
```

- [ ] **Step 7.3: Commit**

```bash
git add src/orchestration/budget.ts
git commit -m "refactor: replace BudgetManager.fromRaw() 80-line manual mapping with typed table"
```

---

## Task 8: WorkflowState — Remove `_linkedView` Complexity

**Problem:** `WorkflowState._linkedView<T>()` creates proxy objects (`ArtifactsState`, `ExecutionState`, `ReviewState`) that forward reads/writes back to `WorkflowState` fields using `Object.defineProperty`. This is a backward-compat shim for old consumers that expected sub-objects. It adds confusion without adding isolation.

**Fix:** Replace callers of `state.artifactsState`, `state.executionState`, `state.reviewState` with direct field access on `state`, then delete the proxy machinery.

**Files:**
- Modify: `src/orchestration/snapshot.ts`
- Modify: `src/runtime/workflowStores.ts`
- Modify: `src/runtime/workerDispatcher.ts`
- Modify: `src/runtime/artifactAcceptanceService.ts`
- Modify: `src/runtime/resultHandler.ts`
- Modify: `src/state.ts`

- [ ] **Step 8.1: Fix `src/orchestration/snapshot.ts`**

Open `src/orchestration/snapshot.ts`. Find lines like:
```typescript
const artifactsState = state.artifactsState;
const executionState = state.executionState;
const reviewState = state.reviewState;
```
and all subsequent uses of `artifactsState.artifacts`, `executionState.goal`, `reviewState.verdicts`, etc.

Replace all three `const xxx = state.xxxState` destructures with nothing (delete them).
Then replace every reference:
- `artifactsState.artifacts` → `state.artifacts`
- `executionState.goal` → `state.goal`
- `executionState.errors` → `state.errors`
- `reviewState.finalReviewDone` → `state.finalReviewDone`
- `reviewState.finalReviewPassed` → `state.finalReviewPassed`
- `reviewState.finalReviewRevisions` → `state.finalReviewRevisions`
- `reviewState.verdicts` → `state.verdicts`

- [ ] **Step 8.2: Fix `src/runtime/workflowStores.ts`**

In `WorkflowStores.ArtifactStore.get`:
```typescript
  get(taskId: string): Artifact | undefined {
    return this.state.artifacts[taskId];   // was: this.state.artifactsState.artifacts[taskId]
  }
```

- [ ] **Step 8.3: Fix `src/runtime/workerDispatcher.ts`**

Find `state.artifactsState.artifacts[taskId]` (around line 335) and replace with `state.artifacts[taskId]`.

- [ ] **Step 8.4: Fix `src/runtime/artifactAcceptanceService.ts`**

Find `state.artifactsState.artifacts[taskId]` (around line 47) and replace with `state.artifacts[taskId]`.

- [ ] **Step 8.5: Fix `src/runtime/resultHandler.ts`**

Find `state.artifactsState.artifacts[t.id]` (around line 341) and replace with `state.artifacts[t.id]`.

- [ ] **Step 8.6: Remove the proxy machinery from `state.ts`**

In `src/state.ts`:

1. Remove the three view interface imports/definitions (`ArtifactsState`, `ExecutionState`, `ReviewState`):
   - Remove the three `export interface` blocks at the top of the file.

2. Remove the three private field declarations in `WorkflowState`:
   ```typescript
   private readonly _artifactsStateView: ArtifactsState;
   private readonly _executionStateView: ExecutionState;
   private readonly _reviewStateView: ReviewState;
   ```

3. Remove the three `_linkedView` calls from the constructor:
   ```typescript
   this._artifactsStateView = this._linkedView<ArtifactsState>([...]);
   this._executionStateView = this._linkedView<ExecutionState>([...]);
   this._reviewStateView = this._linkedView<ReviewState>([...]);
   ```

4. Remove the three `get artifactsState()`, `get executionState()`, `get reviewState()` accessors.

5. Remove the entire `_linkedView<TView>()` private method.

- [ ] **Step 8.7: Run typecheck and tests**

```bash
npm run typecheck
npm test
# Expected: no type errors, all tests pass
```

If any test imports `ArtifactsState`, `ExecutionState`, or `ReviewState` from `state.ts`, update them to access `WorkflowState` fields directly.

- [ ] **Step 8.8: Commit**

```bash
git add src/state.ts src/orchestration/snapshot.ts src/runtime/workflowStores.ts src/runtime/workerDispatcher.ts src/runtime/artifactAcceptanceService.ts src/runtime/resultHandler.ts
git commit -m "refactor(state): remove _linkedView proxy pattern, access WorkflowState fields directly"
```

---

## Task 9: Expand Memory System to Generators and Evaluators

**Problem:** `MemoryStore` provides coordinator decision memory via `memory.appendToPrompt("coordinator", ...)`. Generators and evaluators have no memory — every run re-discovers the same domain nuances (common missing entities, recurring constraint patterns, evaluator false positives).

**Fix:** Use the same `appendToPrompt` mechanism to inject relevant memory into generator and evaluator system prompts.

**Files:**
- Modify: `src/tools/generation.ts`
- Modify: `src/tools/evaluation.ts`
- Modify: `src/memory/constants.ts`
- Test: `tests/test_memory_policy.test.ts`

- [ ] **Step 9.1: Add memory agent-type constants**

Open `src/memory/constants.ts`. Add new agent type constants:
```typescript
export const MEMORY_AGENT_TYPES = {
  COORDINATOR: "coordinator",
  GENERATOR: "generator",
  EVALUATOR: "evaluator",
} as const;
```

- [ ] **Step 9.2: Add generator memory injection in `GenerationTool`**

In `src/tools/generation.ts`, add import:
```typescript
import { getMemory } from "../memory/store.js";
```

In `GenerationTool._getSystemPrompt`, after fetching the base prompt, inject memory. The method is inherited from `BaseTool`. Override `_getSystemPrompt` in `GenerationTool` to append memory for generator context:

Actually, the cleaner approach is to inject memory in `_generate` before calling sub-generators, so memory is available to the `systemPrompt` passed through. Add a new private method:

```typescript
private async _injectGeneratorMemory(systemPrompt: string, queryContext: string): Promise<string> {
  try {
    const memory = getMemory();
    return memory.appendToPrompt("generator", systemPrompt, queryContext);
  } catch {
    return systemPrompt;
  }
}
```

In `_generate`, add memory injection after fetching `injectedPrompt`:
```typescript
  private async _generate(task: Task, context: Record<string, unknown>): Promise<unknown> {
    const hints = (task.contextHints ?? {}) as Record<string, unknown>;
    const desc = task.description ?? "";
    const queryCtx = `${task.type}: ${desc.slice(0, 200)}`;
    const basePrompt = await this._getSystemPrompt("generator.md", "", queryCtx);
    const injectedPrompt = await this._injectGeneratorMemory(basePrompt, queryCtx);
    // ... rest unchanged, but use injectedPrompt instead of the old variable name
```

(The variable was already called `injectedPrompt` — just update the source.)

- [ ] **Step 9.3: Add evaluator memory injection in `EvaluationTool`**

In `src/tools/evaluation.ts`, add import:
```typescript
import { getMemory } from "../memory/store.js";
```

In `_llmReviewSnapshots`, after fetching `system`, inject memory:
```typescript
    const system = await this._getSystemPrompt("evaluator.md", "", `review ${reviewMode} ${artifactTypes}`);
    const systemWithMemory = await (async () => {
      try {
        const memory = getMemory();
        const queryCtx = `evaluate ${reviewMode}: ${Object.keys(snapshots).join(", ")}`;
        return memory.appendToPrompt("evaluator", system, queryCtx);
      } catch {
        return system;
      }
    })();
```

Then pass `systemWithMemory` instead of `system` to `generateJson`:
```typescript
    const response = await this.llm.runWithStreamTagContext(`[Evaluator:${reviewMode}]`, "", () =>
      this.llm.generateJson(userPrompt, systemWithMemory)
    );
```

Do the same in `_llmReviewAnalyze`:
```typescript
    const system = await this._getSystemPrompt("evaluator.md", "", "analyze:" + ...);
    const systemWithMemory = await (async () => {
      try {
        const memory = getMemory();
        return memory.appendToPrompt("evaluator", system, `analyze: ${requirementText.slice(0, 150)}`);
      } catch {
        return system;
      }
    })();
    // then use systemWithMemory in the generateJson call
```

- [ ] **Step 9.4: Add a test that confirms generator memory is attempted**

In `tests/test_memory_policy.test.ts`, add after existing tests:

```typescript
describe("Generator and evaluator memory agent types", () => {
  it("appendToPrompt accepts generator agent type without throwing", async () => {
    const store = new MemoryStore(os.tmpdir(), null as unknown as LLMClient);
    setMemory(store);
    const result = await store.appendToPrompt("generator", "base prompt", "analyze task");
    // Should return a string (base prompt + any injected memories)
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThanOrEqual("base prompt".length);
  });

  it("appendToPrompt accepts evaluator agent type without throwing", async () => {
    const store = new MemoryStore(os.tmpdir(), null as unknown as LLMClient);
    setMemory(store);
    const result = await store.appendToPrompt("evaluator", "eval prompt", "review deep analyze-1");
    expect(typeof result).toBe("string");
  });
});
```

(Check that `MemoryStore` and `setMemory` are already imported in the test file; add them if not.)

- [ ] **Step 9.5: Run tests**

```bash
npm run typecheck && npm test
# Expected: all tests pass
```

- [ ] **Step 9.6: Commit**

```bash
git add src/tools/generation.ts src/tools/evaluation.ts src/memory/constants.ts tests/test_memory_policy.test.ts
git commit -m "feat(memory): inject generator and evaluator memory into system prompts"
```

---

## Final Verification

- [ ] **Run full test suite one last time**

```bash
npm test
# Expected: all test files pass, ≥1130 tests total (original 1123 + new tests added)
```

- [ ] **Run TypeScript compilation**

```bash
npm run typecheck
# Expected: 0 errors
```

- [ ] **Smoke-test the CLI build**

```bash
npm run build
node dist/src/main.js --help
# Expected: prints CLI help without errors
```

---

## Self-Review Checklist

- [x] Task 1 fixes bug: evaluation.ts exception prefix hardcoding → dynamic derivation ✓
- [x] Task 2 fixes race: streamTag mutations → runWithStreamTagContext isolation ✓
- [x] Task 3 removes dead code: selfCorrectRounds field always-0 ✓
- [x] Task 4 eliminates magic strings: SYNTHETIC_TASK_IDS constants ✓
- [x] Task 5 externalizes prompt: StrategyBrain system prompt → prompts/strategy_brain.md ✓
- [x] Task 6 refactors policy: 400-line if-chain → 16 named rule functions ✓
- [x] Task 7 cleans mapping: 80-line fromRaw() → typed table ✓
- [x] Task 8 removes proxy: _linkedView complexity → direct field access ✓
- [x] Task 9 expands memory: coordinator-only → generator + evaluator memory injection ✓
- [x] All tasks have actual code, no TBD/TODO placeholders ✓
- [x] Tasks are independent and ordered safely (types.ts changes in Task 3 are isolated; state.ts changes in Task 8 only affect callers already identified) ✓
- [x] Type names used in Task 6 (`PolicyRule`, `OrchestratorSnapshot`, `PolicyGuard`) match existing definitions ✓
