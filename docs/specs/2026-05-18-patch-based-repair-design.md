# Patch-Based Repair + Structural Replan

## Problem

From log analysis of 4 test runs (ecommerce order system):

1. **Repair = full rewrite**: RepairTool sends the entire artifact + issue list to LLM, LLM rewrites the whole thing. Same cost as generating from scratch, but with degraded quality because the prompt is stuffed with repair instructions.

2. **Replan = generate from scratch**: Replan creates new tasks (design-2, diagrams-state-2) that regenerate entire artifacts. The new generation prompt doesn't even contain the evaluator's issue details — only vague `context_hints`.

3. **No convergence**: Same issue reported across 7 evaluation rounds (e.g., "state diagram coupon expiry error"). Repair fails to fix it, replan creates a new task that also fails.

4. **Self-check 100% failure rate**: 6 out of 6 self-check repairs did not converge (1→1 or 1→3). The LLM cannot fix its own Mermaid output based on abstract rules.

## Design

### 1. RepairTool → Patch Mode

**Before**: Sends full artifact + issues → LLM rewrites entire artifact → replace
**After**: Sends artifact sections + issues → LLM outputs patch instructions → `ArtifactPatcher` applies patches to original artifact

#### Patch Protocol

LLM outputs a JSON array of patch operations:

```json
{
  "patches": [
    {
      "op": "replace_section",
      "section": "3.2 模块划分",
      "content": "### 3.2 模块划分\n\n| 模块 | 功能编号 | API |\n..."
    },
    {
      "op": "replace_section",
      "section": "state_diagram",
      "content": "stateDiagram-v2\n..."
    }
  ]
}
```

Operations:
- `replace_section`: Replace an entire section (by heading for Markdown, by diagram type for Mermaid)
- `insert_after`: Insert new content after a specified section
- `remove_section`: Remove a section entirely

#### ArtifactPatcher

New utility class `src/tools/artifactPatcher.ts`:

- `parseSections(content, type)`: Split artifact into sections
  - Markdown: split by `## ` / `### ` headings
  - Diagrams: split by diagram type keys (`class_diagram`, `activity_diagram`, `state_diagram`)
- `applyPatches(sections, patches)`: Apply patch operations, return reconstructed content
- `validateResult(original, patched)`: Ensure patched content is valid (length ≥ 50% of original, no truncation)

#### Repair Prompt Changes

In `repair.md`, instruct LLM:
- "Output ONLY the sections that need to change, as patch operations"
- "Do NOT rewrite unchanged sections"
- Provide section listing so LLM knows what sections exist

### 2. Replan → Task Topology Only

**Before**: Replan outputs `PlanMutation` with new tasks → new tasks regenerate entire artifacts
**After**: Replan only adds `targeted` tasks with specific issue context

#### Task Type Extension

Add `targeted` field to Task:

```typescript
interface Task {
  // ... existing fields
  targeted?: boolean;          // true = targeted generation, not full
  targetIssues?: Issue[];      // evaluator issues that triggered this task
  patchContext?: {              // what to patch into which artifact
    targetArtifactId: string;   // e.g., "design-1"
    targetSections?: string[];  // sections to focus on
  };
}
```

#### Replan Behavior Change

- `_ensureIssueTargetedTasks()`: New tasks are marked `targeted: true` with issue details
- Replan prompt: "Create targeted tasks that address specific evaluator issues. Each new task should focus on ONE missing piece, not regenerate everything."
- Replan no longer creates `design-2`, `diagrams-state-2` etc. Instead creates `design-1-patch-1`, `diagrams-state-1-patch-1` etc.

### 3. GenerationTool → Targeted Mode

**Before**: Always generates complete artifact from prompt + context
**After**: When `task.targeted === true`, generates only the missing/incorrect sections

#### Targeted Generation Flow

1. Load existing artifact from `patchContext.targetArtifactId`
2. Parse it into sections via `ArtifactPatcher.parseSections()`
3. Build prompt with: existing artifact sections + evaluator issues + "only generate the sections listed in targetSections"
4. LLM outputs only the new/changed sections
5. Apply via `ArtifactPatcher` to merge back into original

#### When targeted is NOT used

- Initial generation (all tasks)
- Tasks without `targeted` flag
- Analyze tasks (these should always be full)

### 4. Self-Check Optimization

**Before**: Self-check finds issue → tries to fix → almost always fails (6/6 failure rate)
**After**: Self-check finds issue → record issue → skip retry → let downstream evaluator handle it

- Remove the self-check retry loop in `GenerationTool`
- Self-check issues are recorded in task metadata
- Evaluator can see self-check issues as additional signal

### 5. Convergence Tracking

Track issue history across evaluation rounds:

```typescript
interface EvaluationHistory {
  round: number;
  issueFingerprints: string[];  // first 100 chars of description, normalized
  majorCount: number;
}
```

Policy decision:
- If same issue fingerprint appears in 3+ consecutive rounds → stop repairing that issue
- If total major issues doesn't decrease over 3 rounds → `pause_for_user` instead of continuing

## Files Changed

| File | Change |
|------|--------|
| `src/tools/artifactPatcher.ts` | **New** — section parser + patch applicator |
| `src/tools/repair.ts` | Patch-mode prompt, apply patches instead of full replace |
| `src/agent/types.ts` | Add `targeted`, `targetIssues`, `patchContext` to Task |
| `src/tools/planning.ts` | Replan produces targeted tasks |
| `src/tools/generation.ts` | Support targeted generation mode |
| `src/orchestration/gates.ts` | Convergence tracking, stop-after-3-identical-rounds |
| `src/orchestration/policy.ts` | Use convergence history in strategy decisions |
| `prompts/repair.md` | Patch-mode instructions |
| `prompts/generator.md` | Targeted generation instructions |

## Implementation Order

1. `artifactPatcher.ts` — pure utility, no dependencies, testable in isolation
2. `types.ts` — Task extension
3. `repair.ts` + `repair.md` — patch-based repair
4. `generation.ts` + `generator.md` — targeted generation
5. `planning.ts` — targeted replan
6. `gates.ts` + `policy.ts` — convergence tracking
7. Integration test: run against ecommerce example, verify llm_trace.json shows fewer LLM calls

## Success Criteria

- [ ] Repair produces patch operations, not full artifact rewrites
- [ ] Replan creates targeted tasks, not full regeneration tasks
- [ ] Self-check no longer retries on failure
- [ ] Same evaluator issue does not persist across 3+ rounds without triggering pause
- [ ] Total LLM calls for ecommerce example reduced by ≥30%
- [ ] All 435 existing tests still pass
