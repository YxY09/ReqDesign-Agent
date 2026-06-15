# Phase A: DesignModel JSON Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the markdown-string design artifact with a structured DesignModel JSON so downstream validators consume typed fields instead of regex-parsing markdown prose, eliminating the false-positive coverage warnings that trigger spurious regeneration cycles.

**Architecture:** `SystemDesigner.generate()` calls `llm.generateJson()` → parses result as `DesignModel` → validates with `validateDesignModel()`. `ArtifactManager._syncAggregate()` calls `renderDesignMarkdown(model)` to set `state.designText` (string, backward-compat for diagrams/tests/traceability). `state.designModel` holds the typed object. Evaluator, generation self-check, and repair detect content type (`isDesignModel` guard) and branch accordingly. Repairs still produce string artifacts (markdown) — no change to repair path.

**Tech Stack:** TypeScript 5.5, Node.js 18+, Vitest 2, ESM (NodeNext). Run tests: `npm test`. Type-check: `npx tsc --noEmit`.

---

## File Map

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add DesignModel interfaces + `isDesignModel` guard |
| `src/generators/design.ts` | `BaseGenerator<DesignModel>`, `generateDesign()` uses JSON, add `renderDesignMarkdown()`, `validateDesignModel()`, `parseDesignModel()` |
| `src/state.ts` | Add `designModel: DesignModel \| null = null` |
| `src/runtime/ArtifactManager.ts` | `_syncAggregate` design branch handles DesignModel |
| `src/runtime/persistenceService.ts` | `saveArtifactIncrementally` design branch handles DesignModel |
| `src/tools/generation.ts` | `_generateDesign` return type, `_ruleCheck` design branch |
| `src/tools/evaluation.ts` | `_ruleCheckSnapshots` design branch, `_extractDesignText` |
| `src/tools/repair.ts` | design validation snippet handles DesignModel |
| `prompts/design_planner.md` | JSON output schema replaces Markdown output spec |
| `tests/test_phase3_design.test.ts` | Add DesignModel unit tests |

---

### Task 1: Add DesignModel types to src/shared/types.ts

**Files:**
- Modify: `src/shared/types.ts` (append after `createRuntimeAction`)

- [ ] **Step 1: Append DesignModel interfaces to src/shared/types.ts**

Add after line 266 (end of file), before the closing export line if any:

```typescript
// ---------------------------------------------------------------------------
// DesignModel — structured design artifact (Phase A)
// ---------------------------------------------------------------------------

export interface DesignModuleEntry {
  id: string;
  name: string;
  responsibility: string;
  functionIds: string[];
}

export interface DesignClassEntry {
  name: string;
  kind: "domain" | "helper";
  responsibility: string;
  attributes?: Array<{ name: string; type: string; description?: string }>;
  methods?: string[];
  entityRef?: string;
}

export interface DesignDataFlow {
  name: string;
  steps: string[];
  relatedFunctionIds: string[];
}

export interface DesignCoverageEntry {
  refId: string;
  refKind: "function" | "constraint" | "exception";
  originalDescription: string;
  designDecision: string;
  affectedModuleIds: string[];
  affectedClassNames: string[];
  testImplication: string;
}

export interface DesignSupplementaryClass {
  name: string;
  justification: string;
}

export interface DesignModel {
  modules: DesignModuleEntry[];
  classes: DesignClassEntry[];
  dataFlows: DesignDataFlow[];
  coverageMatrix: DesignCoverageEntry[];
  supplementaryClasses?: DesignSupplementaryClass[];
}

/** Type guard: returns true if value has all required DesignModel array fields. */
export function isDesignModel(content: unknown): content is DesignModel {
  if (!content || typeof content !== "object" || Array.isArray(content)) return false;
  const c = content as Record<string, unknown>;
  return Array.isArray(c.modules) && Array.isArray(c.classes) &&
    Array.isArray(c.dataFlows) && Array.isArray(c.coverageMatrix);
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors about new types.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(design): add DesignModel types and isDesignModel guard to shared/types.ts"
```

---

### Task 2: Add renderDesignMarkdown, validateDesignModel, parseDesignModel to design.ts

**Files:**
- Modify: `src/generators/design.ts`

These are pure functions, no LLM calls. We add them as static methods on `SystemDesigner` and also export them as module-level functions for use by other modules.

- [ ] **Step 1: Add imports at top of design.ts**

The file already imports from `../shared/types.js` via tools — but `DesignModel` is in `../shared/types.ts`. Add the import. At the top of `src/generators/design.ts`, add:

```typescript
import type { DesignModel, DesignCoverageEntry } from "../shared/types.js";
import { isDesignModel } from "../shared/types.js";
```

- [ ] **Step 2: Add renderDesignMarkdown as static method on SystemDesigner**

Add this static method inside the `SystemDesigner` class, after `buildDesignContract`:

```typescript
static renderDesignMarkdown(model: DesignModel): string {
  const lines: string[] = [];

  lines.push("## 模块划分\n");
  lines.push("| 模块名称 | 职责描述 | 对应功能 |");
  lines.push("|----------|----------|----------|");
  for (const mod of model.modules) {
    lines.push(`| ${mod.name} | ${mod.responsibility} | ${mod.functionIds.join(", ")} |`);
  }

  lines.push("\n## 核心类/接口设计\n");
  lines.push("| 类名 | 类型 | 职责 | 关联实体 |");
  lines.push("|------|------|------|----------|");
  for (const cls of model.classes) {
    lines.push(`| ${cls.name} | ${cls.kind} | ${cls.responsibility} | ${cls.entityRef ?? "-"} |`);
  }
  for (const cls of model.classes) {
    lines.push(`\n### ${cls.name}`);
    lines.push(`- **职责**: ${cls.responsibility}`);
    if (cls.attributes && cls.attributes.length > 0) {
      lines.push("- **属性**:");
      for (const attr of cls.attributes) {
        lines.push(`  - ${attr.name}: ${attr.type}${attr.description ? ` — ${attr.description}` : ""}`);
      }
    }
    if (cls.methods && cls.methods.length > 0) {
      lines.push("- **方法**: " + cls.methods.join(", "));
    }
    if (cls.entityRef) {
      lines.push(`- **关联实体**: ${cls.entityRef}`);
    }
  }

  lines.push("\n## 数据流说明\n");
  for (const flow of model.dataFlows) {
    lines.push(`### ${flow.name}`);
    if (flow.relatedFunctionIds.length > 0) {
      lines.push(`相关功能: ${flow.relatedFunctionIds.join(", ")}`);
    }
    flow.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    lines.push("");
  }

  lines.push("\n## 设计覆盖矩阵\n");
  lines.push("| ID | 类型 | 原始描述 | 设计决策 | 影响模块 | 影响类 | 测试启示 |");
  lines.push("|-----|------|----------|----------|---------|------|--------|");
  for (const entry of model.coverageMatrix) {
    const mods = entry.affectedModuleIds.join(", ");
    const cls = entry.affectedClassNames.join(", ");
    lines.push(`| ${entry.refId} | ${entry.refKind} | ${entry.originalDescription} | ${entry.designDecision} | ${mods} | ${cls} | ${entry.testImplication} |`);
  }

  if (model.supplementaryClasses && model.supplementaryClasses.length > 0) {
    lines.push("\n## 补充核心类依据\n");
    lines.push("| 类名 | 需求原文依据 |");
    lines.push("|------|-------------|");
    for (const sc of model.supplementaryClasses) {
      lines.push(`| ${sc.name} | ${sc.justification} |`);
    }
  }

  return lines.join("\n");
}
```

- [ ] **Step 3: Add validateDesignModel as static method**

Add after `renderDesignMarkdown`:

```typescript
static validateDesignModel(model: DesignModel, requirementJson: Record<string, unknown>): string[] {
  const warnings: string[] = [];

  if (!model.modules || model.modules.length === 0) warnings.push("DesignModel 缺少 modules");
  if (!model.classes || model.classes.length === 0) warnings.push("DesignModel 缺少 classes");
  if (!model.dataFlows || model.dataFlows.length === 0) warnings.push("DesignModel 缺少 dataFlows");
  if (!model.coverageMatrix || model.coverageMatrix.length === 0) warnings.push("DesignModel 缺少 coverageMatrix");

  const coveredFunctionIds = new Set<string>(model.modules.flatMap((m) => m.functionIds));
  const functions = Array.isArray(requirementJson.functions)
    ? (requirementJson.functions as Record<string, unknown>[])
    : [];
  for (const fn of functions) {
    const id = String(fn.id ?? "");
    const displayId = String(fn.displayId ?? "");
    if ((id || displayId) && !coveredFunctionIds.has(id) && !coveredFunctionIds.has(displayId)) {
      warnings.push(`功能 ${displayId || id} 未映射到任何模块的 functionIds`);
    }
  }

  const coveredRefIds = new Set<string>(model.coverageMatrix.map((e) => e.refId));
  const constraints = Array.isArray(requirementJson.constraints)
    ? (requirementJson.constraints as Record<string, unknown>[])
    : [];
  for (const c of constraints) {
    const id = String(c.displayId ?? c.id ?? "");
    if (id && !coveredRefIds.has(id)) warnings.push(`约束 ${id} 未在 coverageMatrix 中体现`);
  }
  const exceptions = Array.isArray(requirementJson.exceptions)
    ? (requirementJson.exceptions as Record<string, unknown>[])
    : [];
  for (const e of exceptions) {
    const id = String(e.displayId ?? e.id ?? "");
    if (id && !coveredRefIds.has(id)) warnings.push(`异常 ${id} 未在 coverageMatrix 中体现`);
  }

  return warnings;
}
```

- [ ] **Step 4: Add parseDesignModel as static method**

Add after `validateDesignModel`:

```typescript
static parseDesignModel(raw: Record<string, unknown>): DesignModel | null {
  const obj = SystemDesigner._unwrapDesignContent(raw);
  if (!isDesignModel(obj)) return null;
  return obj;
}

private static _unwrapDesignContent(raw: Record<string, unknown>): unknown {
  // Unwrap {content: {...}} or {design: {...}} LLM envelope
  if (isDesignModel(raw)) return raw;
  const inner = raw["content"] ?? raw["design"] ?? raw["result"];
  if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner;
  return raw;
}
```

- [ ] **Step 5: Run tests to confirm existing tests still pass**

```bash
npm test -- --reporter=verbose tests/test_phase3_design.test.ts
```
Expected: all existing tests PASS (we haven't changed `validateDesign` yet).

- [ ] **Step 6: Commit**

```bash
git add src/generators/design.ts
git commit -m "feat(design): add renderDesignMarkdown, validateDesignModel, parseDesignModel static methods"
```

---

### Task 3: Add DesignModel unit tests

**Files:**
- Modify: `tests/test_phase3_design.test.ts`

- [ ] **Step 1: Write failing tests for renderDesignMarkdown**

Add at the end of `tests/test_phase3_design.test.ts`:

```typescript
import { isDesignModel } from "../src/shared/types.js";

const MINIMAL_MODEL = {
  modules: [{ id: "MOD_USER", name: "用户模块", responsibility: "用户管理", functionIds: ["F001"] }],
  classes: [{ name: "UserService", kind: "helper" as const, responsibility: "用户服务", entityRef: undefined }],
  dataFlows: [{ name: "登录流程", steps: ["client → UserService", "UserService → DB"], relatedFunctionIds: ["F001"] }],
  coverageMatrix: [{ refId: "F001", refKind: "function" as const, originalDescription: "用户登录", designDecision: "UserService.login()", affectedModuleIds: ["MOD_USER"], affectedClassNames: ["UserService"], testImplication: "正常/异常登录场景" }],
};

describe("renderDesignMarkdown", () => {
  it("includes function ID in module table", () => {
    const md = SystemDesigner.renderDesignMarkdown(MINIMAL_MODEL);
    expect(md).toContain("F001");
    expect(md).toContain("用户模块");
  });

  it("includes class name in class section", () => {
    const md = SystemDesigner.renderDesignMarkdown(MINIMAL_MODEL);
    expect(md).toContain("UserService");
    expect(md).toContain("## 核心类/接口设计");
  });

  it("includes data flow section", () => {
    const md = SystemDesigner.renderDesignMarkdown(MINIMAL_MODEL);
    expect(md).toContain("## 数据流说明");
    expect(md).toContain("登录流程");
  });

  it("includes coverage matrix with IDs", () => {
    const md = SystemDesigner.renderDesignMarkdown(MINIMAL_MODEL);
    expect(md).toContain("## 设计覆盖矩阵");
    expect(md).toContain("F001");
  });
});

describe("validateDesignModel", () => {
  it("warns when function not in module functionIds", () => {
    const reqJson = { functions: [{ id: "F001", displayId: "F001", name: "登录" }, { id: "F002", displayId: "F002", name: "注册" }], constraints: [], exceptions: [] };
    const warnings = SystemDesigner.validateDesignModel(MINIMAL_MODEL, reqJson);
    expect(warnings.some((w) => w.includes("F002"))).toBe(true);
  });

  it("warns when constraint not in coverageMatrix", () => {
    const reqJson = { functions: [], constraints: [{ id: "C001", displayId: "C001", description: "密码强度" }], exceptions: [] };
    const warnings = SystemDesigner.validateDesignModel(MINIMAL_MODEL, reqJson);
    expect(warnings.some((w) => w.includes("C001"))).toBe(true);
  });

  it("warns when exception not in coverageMatrix", () => {
    const reqJson = { functions: [], constraints: [], exceptions: [{ id: "X001", displayId: "X001", description: "登录失败" }] };
    const warnings = SystemDesigner.validateDesignModel(MINIMAL_MODEL, reqJson);
    expect(warnings.some((w) => w.includes("X001"))).toBe(true);
  });

  it("passes when all requirements covered", () => {
    const reqJson = { functions: [{ id: "F001", displayId: "F001" }], constraints: [], exceptions: [] };
    const warnings = SystemDesigner.validateDesignModel(MINIMAL_MODEL, reqJson);
    expect(warnings.filter((w) => w.includes("F001")).length).toBe(0);
  });
});

describe("isDesignModel", () => {
  it("returns false for string", () => {
    expect(isDesignModel("hello")).toBe(false);
  });
  it("returns false for object missing arrays", () => {
    expect(isDesignModel({ modules: "not-array" })).toBe(false);
  });
  it("returns true for valid minimal model", () => {
    expect(isDesignModel(MINIMAL_MODEL)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new tests to confirm they pass**

```bash
npm test -- --reporter=verbose tests/test_phase3_design.test.ts
```
Expected: all new tests PASS (renderDesignMarkdown, validateDesignModel, isDesignModel sections).

- [ ] **Step 3: Commit**

```bash
git add tests/test_phase3_design.test.ts
git commit -m "test(design): add DesignModel unit tests for renderDesignMarkdown, validateDesignModel, isDesignModel"
```

---

### Task 4: Update generateDesign() and generate() to produce DesignModel

**Files:**
- Modify: `src/generators/design.ts`

- [ ] **Step 1: Change class declaration and generate() method**

Change line 216 from:
```typescript
export class SystemDesigner extends BaseGenerator<string> {
```
to:
```typescript
export class SystemDesigner extends BaseGenerator<DesignModel> {
```

Change `generate()` method (currently lines 227-232):
```typescript
async generate(input: unknown): Promise<DesignModel> {
  const { requirementJson, systemPrompt } = input as {
    requirementJson: Record<string, unknown>;
    systemPrompt?: string;
  };
  return this.generateDesign(requirementJson, systemPrompt);
}
```

- [ ] **Step 2: Rewrite generateDesign() to use generateJson loop**

Replace the existing `generateDesign()` method (lines 235-257) with:

```typescript
async generateDesign(
  requirementJson: Record<string, unknown>,
  systemPrompt?: string,
): Promise<DesignModel> {
  if (!requirementJson || typeof requirementJson !== "object") {
    throw createToolError("DESIGN_EMPTY_INPUT", "需求JSON不能为空且必须是字典类型", { recoverable: false });
  }

  let reqStr = JSON.stringify(minimizeForPrompt(requirementJson), null, 2);
  reqStr = this.sanitizePlaceholder(reqStr, "requirement_json");
  reqStr = this.sanitizePlaceholder(reqStr, "design_text");
  let prompt = this.promptTemplate.replace(/\{requirement_json\}/g, reqStr);
  const contractParts: string[] = [];
  if (systemPrompt) contractParts.push(systemPrompt);
  contractParts.push(SystemDesigner.buildDesignContract(requirementJson));
  prompt = prompt.replace(/\{requirement_text\}/g, contractParts.join("\n\n"));

  const maxAttempts = 3;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await this.generateJsonWithRetry(prompt, systemPrompt ?? "", 1);
      const model = SystemDesigner.parseDesignModel(raw);
      if (!model) {
        throw createToolError("DESIGN_PARSE_FAILED", "LLM output is not a valid DesignModel (missing required arrays)", { recoverable: true });
      }
      return model;
    } catch (e) {
      if (isAbortError(e)) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw createToolError("DESIGN_FAILED", `Design JSON generation failed after ${maxAttempts} attempts: ${lastError?.message ?? "unknown"}`, { recoverable: true });
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```
Expected: may get errors in callers that expect `string` — we'll fix those in subsequent tasks. If there are only errors in `generation.ts`, `evaluation.ts`, `repair.ts` that reference `string` vs `DesignModel`, that's expected.

- [ ] **Step 4: Run phase3 tests to confirm they still compile and pass**

```bash
npm test -- tests/test_phase3_design.test.ts
```
Expected: all tests pass (the static `validateDesign` hasn't changed).

- [ ] **Step 5: Commit**

```bash
git add src/generators/design.ts
git commit -m "feat(design): generateDesign() now returns DesignModel via generateJson loop"
```

---

### Task 5: Update design_planner.md prompt for JSON output

**Files:**
- Modify: `prompts/design_planner.md`

- [ ] **Step 1: Read the full current file**

Read `prompts/design_planner.md` to see all sections.

- [ ] **Step 2: Replace output requirement section**

The file currently says "请以Markdown格式输出系统设计方案。不要用JSON包裹，直接输出Markdown文本。" — replace the entire `## 输出要求` section with:

```markdown
## 输出要求

**输出格式：合法 JSON 根对象，禁止输出 Markdown、代码围栏或解释文本。**

根对象字段：

```json
{
  "modules": [
    {
      "id": "MOD_USER",
      "name": "用户管理模块",
      "responsibility": "负责用户注册、登录、权限管理",
      "functionIds": ["F001", "F002"]
    }
  ],
  "classes": [
    {
      "name": "UserService",
      "kind": "helper",
      "responsibility": "处理用户业务逻辑",
      "attributes": [{"name": "userRepo", "type": "UserRepository", "description": "用户仓储"}],
      "methods": ["register(dto): User", "login(credentials): Token"],
      "entityRef": null
    },
    {
      "name": "User",
      "kind": "domain",
      "responsibility": "用户领域实体",
      "attributes": [{"name": "id", "type": "string"}, {"name": "username", "type": "string"}],
      "methods": ["validate(): boolean"],
      "entityRef": "User"
    }
  ],
  "dataFlows": [
    {
      "name": "用户登录流程",
      "steps": ["Client → UserService.login()", "UserService → UserRepository.findByUsername()", "返回 JWT Token"],
      "relatedFunctionIds": ["F001"]
    }
  ],
  "coverageMatrix": [
    {
      "refId": "F001",
      "refKind": "function",
      "originalDescription": "用户通过用户名和密码登录系统",
      "designDecision": "UserService.login() 验证凭证，生成 JWT",
      "affectedModuleIds": ["MOD_USER"],
      "affectedClassNames": ["UserService", "User"],
      "testImplication": "正常登录、错误密码、账号不存在三种场景"
    },
    {
      "refId": "C001",
      "refKind": "constraint",
      "originalDescription": "密码长度不少于8位",
      "designDecision": "UserService.register() 校验密码长度",
      "affectedModuleIds": ["MOD_USER"],
      "affectedClassNames": ["UserService"],
      "testImplication": "边界：7位拒绝、8位通过"
    }
  ],
  "supplementaryClasses": []
}
```

### 字段说明

- **modules**: 每条映射一个功能模块。`functionIds` 必须包含该模块负责的全部功能 ID（来自合同清单）。每个功能 ID 只映射到语义最匹配的一个模块。
- **classes**: 核心类和服务类。`kind=domain` 表示业务实体类（须与允许的核心领域类对应，entityRef 填实体名称），`kind=helper` 表示服务/仓储/控制器等辅助类（entityRef 为 null）。
- **dataFlows**: 主要业务流程的步骤序列，每步描述服务调用或数据传递。`relatedFunctionIds` 引用该流程覆盖的功能 ID。
- **coverageMatrix**: 设计覆盖矩阵，**必须为每个功能 ID、约束 ID、异常 ID 各写一条**。`refKind` 为 `function`/`constraint`/`exception`。`originalDescription` 保留需求原始语义，不能改写。
- **supplementaryClasses**: 如需补充未在实体清单中的核心类，在此列出并提供需求原文依据；否则为空数组。
```

- [ ] **Step 3: Remove the old Markdown chapter-by-chapter instruction sections**

The file has sections like `### 1. 系统概述`, `### 2. 系统分层架构`, etc. These are now superseded by the JSON schema. Remove them, keeping only the preamble (`你是一个资深的系统架构师...`), the input section, and the new output section.

- [ ] **Step 4: Add complexity-matching note to the new output section**

After the field descriptions, add:

```markdown
### 复杂度匹配要求

- 简单无状态需求应采用轻量设计，modules 数量 2-3 个，classes 数量 3-6 个，不引入数据库、消息队列、分布式组件，除非需求明确要求。
- 中大型系统根据需求中的性能、并发、技术约束设计。
- dataFlows 应覆盖最关键的 2-4 个业务主流程，不需要穷举所有操作。
```

- [ ] **Step 5: Verify prompt is saved correctly**

```bash
npx ts-node --esm -e "import { loadPrompt } from './src/promptLoader.js'; console.log(loadPrompt('design_planner.md', '').slice(0, 200));"
```

Or just read the file to confirm it saved. If ts-node isn't available, skip this step.

- [ ] **Step 6: Commit**

```bash
git add prompts/design_planner.md
git commit -m "feat(prompt): update design_planner.md to output DesignModel JSON instead of Markdown"
```

---

### Task 6: Add designModel field to state.ts

**Files:**
- Modify: `src/state.ts`

- [ ] **Step 1: Add import and field**

In `src/state.ts`, at the top with other imports, add:
```typescript
import type { DesignModel } from "./shared/types.js";
```

In the `// --- Aggregate fields` section (around line 119-126), add `designModel` after `designText`:
```typescript
designText: string = "";
designModel: DesignModel | null = null;
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Expected: no new errors from this change.

- [ ] **Step 3: Commit**

```bash
git add src/state.ts
git commit -m "feat(state): add designModel field alongside designText"
```

---

### Task 7: Update ArtifactManager._syncAggregate for DesignModel

**Files:**
- Modify: `src/runtime/ArtifactManager.ts`

- [ ] **Step 1: Add imports**

At the top of `src/runtime/ArtifactManager.ts`, add:
```typescript
import { isDesignModel } from "../shared/types.js";
import { SystemDesigner } from "../generators/design.js";
```

- [ ] **Step 2: Update _syncAggregate design branch**

Find the block (lines 79-82):
```typescript
} else if (key === "design_text" && typeof content === "string") {
  if (content) {
    this._state.designText = content;
  }
}
```

Replace with:
```typescript
} else if (key === "design_text") {
  if (isDesignModel(content)) {
    this._state.designModel = content;
    this._state.designText = SystemDesigner.renderDesignMarkdown(content);
  } else if (typeof content === "string" && content) {
    this._state.designText = content;
    this._state.designModel = null;
  }
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/test_phase3_design.test.ts tests/test_core.test.ts
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/ArtifactManager.ts
git commit -m "feat(artifact): ArtifactManager renders DesignModel to designText and stores designModel"
```

---

### Task 8: Update persistenceService.ts for DesignModel artifacts

**Files:**
- Modify: `src/runtime/persistenceService.ts`

The `saveArtifactIncrementally` method currently checks `typeof artifact.content === "string"` for design. After Phase A, the content is a DesignModel object.

- [ ] **Step 1: Add imports**

Add at the top of `src/runtime/persistenceService.ts`:
```typescript
import { isDesignModel } from "../shared/types.js";
import { SystemDesigner } from "../generators/design.js";
```

- [ ] **Step 2: Update saveArtifactIncrementally design branch**

Find (lines 55-59):
```typescript
if (
  artifact.type === "design" &&
  typeof artifact.content === "string"
) {
  manager.saveSystemDesign(artifact.content);
}
```

Replace with:
```typescript
if (artifact.type === "design") {
  if (isDesignModel(artifact.content)) {
    const rendered = SystemDesigner.renderDesignMarkdown(artifact.content);
    manager.saveSystemDesign(rendered);
  } else if (typeof artifact.content === "string" && artifact.content) {
    manager.saveSystemDesign(artifact.content);
  }
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/runtime/persistenceService.ts
git commit -m "feat(persistence): handle DesignModel content in saveArtifactIncrementally"
```

---

### Task 9: Update generation.ts _ruleCheck and _generateDesign

**Files:**
- Modify: `src/tools/generation.ts`

- [ ] **Step 1: Add imports to generation.ts**

Add at the top:
```typescript
import { isDesignModel } from "../shared/types.js";
import { SystemDesigner } from "../generators/design.js";
```

(Note: `SystemDesigner` may already be imported — check and add if missing.)

- [ ] **Step 2: Update _generateDesign return type**

Find (line 177-187):
```typescript
private async _generateDesign(
  ctx: Record<string, unknown>, _hints: Record<string, unknown>,
  _desc: string, systemPrompt: string,
): Promise<string> {
```

Change return type to `Promise<unknown>` (since it now returns DesignModel):
```typescript
private async _generateDesign(
  ctx: Record<string, unknown>, _hints: Record<string, unknown>,
  _desc: string, systemPrompt: string,
): Promise<unknown> {
```

The body stays unchanged — `generateDesign()` now returns `DesignModel` which is a valid `unknown`.

- [ ] **Step 3: Update _ruleCheck design branch**

Find (lines 271-276):
```typescript
else if (taskType === "design") {
  if (typeof content !== "string" || !content.trim())
    return ["设计文档为空"];
  const reqJson = (context.requirement_json ?? {}) as Record<string, unknown>;
  issues.push(...SystemDesigner.validateDesign(String(content), reqJson));
  issues.push(...GenerationTool._checkUndefinedExceptionIds(String(content), reqJson, "设计"));
}
```

Replace with:
```typescript
else if (taskType === "design") {
  const reqJson = (context.requirement_json ?? {}) as Record<string, unknown>;
  if (isDesignModel(content)) {
    issues.push(...SystemDesigner.validateDesignModel(content, reqJson));
    const rendered = SystemDesigner.renderDesignMarkdown(content);
    issues.push(...GenerationTool._checkUndefinedExceptionIds(rendered, reqJson, "设计"));
  } else if (typeof content === "string" && content.trim()) {
    issues.push(...SystemDesigner.validateDesign(String(content), reqJson));
    issues.push(...GenerationTool._checkUndefinedExceptionIds(String(content), reqJson, "设计"));
  } else {
    return ["设计文档为空"];
  }
}
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors in generation.ts.

- [ ] **Step 5: Run tests**

```bash
npm test -- tests/test_phase3_design.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/generation.ts
git commit -m "feat(generation): _ruleCheck handles DesignModel content, _generateDesign returns DesignModel"
```

---

### Task 10: Update evaluation.ts design branch for DesignModel

**Files:**
- Modify: `src/tools/evaluation.ts`

- [ ] **Step 1: Add imports to evaluation.ts**

Add at the top:
```typescript
import { isDesignModel } from "../shared/types.js";
```

(SystemDesigner is already imported via `import { SystemDesigner } from "../generators/design.js"`.)

- [ ] **Step 2: Update _extractDesignText**

Find (lines 195-204):
```typescript
static _extractDesignText(snapshots: Record<string, Record<string, unknown>>): string {
  for (const snapshot of Object.values(snapshots)) {
    if (String(snapshot.type ?? "") === "design") {
      const content = snapshot.content;
      if (typeof content === "string") return content;
      if (typeof content === "object" && content !== null) return JSON.stringify(content);
    }
  }
  return "";
}
```

Replace with:
```typescript
static _extractDesignText(snapshots: Record<string, Record<string, unknown>>): string {
  for (const snapshot of Object.values(snapshots)) {
    if (String(snapshot.type ?? "") === "design") {
      const content = snapshot.content;
      if (typeof content === "string") return content;
      if (isDesignModel(content)) return SystemDesigner.renderDesignMarkdown(content);
      if (typeof content === "object" && content !== null) return JSON.stringify(content);
    }
  }
  return "";
}
```

- [ ] **Step 3: Update _ruleCheckSnapshots design branch**

Find (lines 438-466):
```typescript
if (taskType === "design") {
  if (skipMissingArtifact) continue;
  if (typeof content !== "string" || !(content as string).trim()) {
    issues.push(createIssue({ severity: "blocker", targetTaskId: taskId, targetTaskType: "design", targetField: "design_text", description: "系统设计文档为空", suggestion: "重新执行设计生成任务" }));
  } else {
    for (const warning of SystemDesigner.validateDesign(String(content), requirementJson)) {
      issues.push(createIssue({
        severity: "major",
        targetTaskId: taskId,
        targetTaskType: "design",
        targetField: "design_text",
        description: warning,
        suggestion: warning.includes("未在需求中识别的核心类")
          ? "删除或下沉多余的核心类，只保留需求中识别的业务实体"
          : "补充对应模块、实体或章节，并保持与需求一致",
      }));
    }
    issues.push(
      ...this._checkUndefinedExceptionIds(
        taskId, "design", "design_text",
        String(content),
        requirementJson,
      ),
    );
  }
  continue;
}
```

Replace with:
```typescript
if (taskType === "design") {
  if (skipMissingArtifact) continue;
  const isEmpty = content === null || content === undefined ||
    (typeof content === "string" && !content.trim()) ||
    (typeof content === "object" && !isDesignModel(content));
  if (isEmpty) {
    issues.push(createIssue({ severity: "blocker", targetTaskId: taskId, targetTaskType: "design", targetField: "design_text", description: "系统设计文档为空", suggestion: "重新执行设计生成任务" }));
  } else if (isDesignModel(content)) {
    for (const warning of SystemDesigner.validateDesignModel(content, requirementJson)) {
      issues.push(createIssue({
        severity: "major",
        targetTaskId: taskId,
        targetTaskType: "design",
        targetField: "design_text",
        description: warning,
        suggestion: "补充对应模块、实体或章节，并保持与需求一致",
      }));
    }
    const rendered = SystemDesigner.renderDesignMarkdown(content);
    issues.push(
      ...this._checkUndefinedExceptionIds(taskId, "design", "design_text", rendered, requirementJson),
    );
  } else {
    for (const warning of SystemDesigner.validateDesign(String(content), requirementJson)) {
      issues.push(createIssue({
        severity: "major",
        targetTaskId: taskId,
        targetTaskType: "design",
        targetField: "design_text",
        description: warning,
        suggestion: warning.includes("未在需求中识别的核心类")
          ? "删除或下沉多余的核心类，只保留需求中识别的业务实体"
          : "补充对应模块、实体或章节，并保持与需求一致",
      }));
    }
    issues.push(
      ...this._checkUndefinedExceptionIds(taskId, "design", "design_text", String(content), requirementJson),
    );
  }
  continue;
}
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Run tests**

```bash
npm test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools/evaluation.ts
git commit -m "feat(evaluation): handle DesignModel in _ruleCheckSnapshots and _extractDesignText"
```

---

### Task 11: Update repair.ts design validation for DesignModel

**Files:**
- Modify: `src/tools/repair.ts`

- [ ] **Step 1: Add imports**

Add at the top of `src/tools/repair.ts`:
```typescript
import { isDesignModel } from "../shared/types.js";
```

(SystemDesigner is already imported.)

- [ ] **Step 2: Update design validation snippet**

Find (lines 860-868):
```typescript
const designText = typeof currentContent === "string"
  ? currentContent
  : String(currentContent ?? "");
const designWarnings = requirementJson
  ? SystemDesigner.validateDesign(designText, requirementJson)
  : [];
```

Replace with:
```typescript
let designText: string;
if (isDesignModel(currentContent)) {
  designText = SystemDesigner.renderDesignMarkdown(currentContent);
} else {
  designText = typeof currentContent === "string" ? currentContent : String(currentContent ?? "");
}
const designWarnings = requirementJson
  ? SystemDesigner.validateDesign(designText, requirementJson)
  : [];
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Run full test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/repair.ts
git commit -m "feat(repair): render DesignModel to markdown before showing in repair prompt"
```

---

### Task 12: Final verification and cleanup

- [ ] **Step 1: Run full test suite**

```bash
npm test
```
Expected: all tests pass, no regressions.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 3: Verify the pipeline works end-to-end by running a quick smoke test**

```bash
npx ts-node --esm -e "
import { isDesignModel } from './src/shared/types.js';
import { SystemDesigner } from './src/generators/design.js';

const model = {
  modules: [{ id: 'M1', name: '用户模块', responsibility: '管理用户', functionIds: ['F001'] }],
  classes: [{ name: 'UserService', kind: 'helper', responsibility: '服务' }],
  dataFlows: [{ name: '登录', steps: ['A→B'], relatedFunctionIds: ['F001'] }],
  coverageMatrix: [{ refId: 'F001', refKind: 'function', originalDescription: '登录', designDecision: 'UserService.login()', affectedModuleIds: ['M1'], affectedClassNames: ['UserService'], testImplication: '正常/异常' }],
};

console.log('isDesignModel:', isDesignModel(model));
const md = SystemDesigner.renderDesignMarkdown(model);
console.log('markdown contains F001:', md.includes('F001'));
console.log('markdown contains 模块划分:', md.includes('模块划分'));
console.log('markdown contains 覆盖矩阵:', md.includes('设计覆盖矩阵'));
"
```
Expected output:
```
isDesignModel: true
markdown contains F001: true
markdown contains 模块划分: true
markdown contains 覆盖矩阵: true
```

- [ ] **Step 4: Final commit (if any uncommitted changes)**

```bash
git status
```
If any remaining changes:
```bash
git add -p
git commit -m "feat(design-phase-a): final cleanup and verification"
```

---

## Self-Review

**Spec coverage:**
- ✅ DesignModel type → Task 1
- ✅ LLM → generateJson → DesignModel → Task 4 prompt + Task 3 generate
- ✅ renderDesignMarkdown → Task 2
- ✅ state.designModel + state.designText → Task 6 + Task 7
- ✅ ArtifactManager syncs both fields → Task 7
- ✅ Evaluator handles DesignModel → Task 10
- ✅ Generation self-check handles DesignModel → Task 9
- ✅ Repair handles DesignModel → Task 11
- ✅ Persistence saves rendered markdown → Task 8
- ✅ Tests for all new functions → Task 3

**Type consistency:**
- `isDesignModel` exported from `src/shared/types.ts`, imported in ArtifactManager, persistenceService, generation, evaluation, repair
- `SystemDesigner.renderDesignMarkdown(model: DesignModel): string` — same name used in Tasks 2, 7, 8, 9, 10, 11
- `SystemDesigner.validateDesignModel(model: DesignModel, reqJson): string[]` — same name used in Tasks 2, 3, 9, 10
- `SystemDesigner.parseDesignModel(raw): DesignModel | null` — used in Task 3 generate loop

**Placeholder scan:** No TBDs or incomplete steps. Every code block shows exact file and replacement.

**Backward compat:**
- `validateDesign(text, reqJson)` unchanged — existing tests pass
- String design artifacts (from repair) still work — all branches check type first
- `state.designText` remains a string — downstream (diagrams, tests, coverageValidator, traceabilityMatrix) unchanged
