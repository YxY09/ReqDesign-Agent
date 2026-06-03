/**
 * TestPlanBuilder — 程序化测试任务规划器。
 *
 * 从 analysis.json 中枚举所有覆盖目标，按模块分组，
 * 生成结构化的 TestTask 列表供 LLM 逐组执行。
 */

export interface TestTask {
  taskId: string;
  testIdPrefix: string;
  type: "normal" | "boundary" | "exception";
  targetFunction?: string;
  targetConstraints: string[];
  targetExceptions: string[];
  mustCover: string[];
  moduleContext: string;
}

export interface TaskGroup {
  moduleContext: string;
  tasks: TestTask[];
}

// ---------------------------------------------------------------------------
// buildTestPlan — 从分析数据枚举所有覆盖目标，生成测试任务
// ---------------------------------------------------------------------------

export function buildTestPlan(analysis: Record<string, unknown>): TestTask[] {
  const functions = asArray(analysis["functions"]);
  const constraints = asArray(analysis["constraints"]);
  const exceptions = asArray(analysis["exceptions"]);

  const normalCounter = { value: 0 };
  const boundaryCounter = { value: 0 };
  const exceptionCounter = { value: 0 };

  const tasks: TestTask[] = [];

  // Track which constraints are already assigned to a function's boundary task
  const assignedConstraints = new Set<string>();

  // For each function, create 1–2 normal tasks and optional boundary task
  for (const func of functions) {
    const funcDisplayId = str(func["displayId"] ?? func["id"]);
    const funcCanonicalId = str(func["id"]);
    const funcName = str(func["name"]);
    const subCaps = asStrings(func["sub_capabilities"]);
    const acceptCrit = asStrings(func["acceptance_criteria"]);
    const module = deriveModuleFromFunction(func);

    // Happy path normal task
    const normalMustCover: string[] = [];
    if (funcName) normalMustCover.push(`功能 ${funcDisplayId} ${funcName} 正常流程`);
    for (const sub of subCaps) normalMustCover.push(`子能力: ${sub}`);
    for (const ac of acceptCrit) normalMustCover.push(`验收标准: ${ac}`);

    normalCounter.value++;
    tasks.push({
      taskId: `TASK-FUN_${funcCanonicalId}_NORMAL`,
      testIdPrefix: `TC-N-${pad3(normalCounter.value)}`,
      type: "normal",
      targetFunction: funcDisplayId || funcCanonicalId,
      targetConstraints: [],
      targetExceptions: [],
      mustCover: normalMustCover,
      moduleContext: module,
    });

    // Boundary task if function has constraints related to it
    const relatedConstraints = findConstraintsForFunction(constraints, funcDisplayId, funcCanonicalId);
    if (relatedConstraints.length > 0) {
      const boundaryMustCover: string[] = [];
      for (const con of relatedConstraints) {
        const conId = str(con["displayId"] ?? con["id"]);
        const conText = str(con["source_text"] ?? con["description"]);
        boundaryMustCover.push(`约束 ${conId}: ${conText}`);
        assignedConstraints.add(str(con["id"]));
      }

      boundaryCounter.value++;
      tasks.push({
        taskId: `TASK-FUN_${funcCanonicalId}_BOUNDARY`,
        testIdPrefix: `TC-B-${pad3(boundaryCounter.value)}`,
        type: "boundary",
        targetFunction: funcDisplayId || funcCanonicalId,
        targetConstraints: relatedConstraints.map((c) => str(c["displayId"] ?? c["id"])),
        targetExceptions: [],
        mustCover: boundaryMustCover,
        moduleContext: module,
      });
    }
  }

  // For unassigned constraints, create boundary tasks
  for (const con of constraints) {
    const conId = str(con["id"]);
    if (assignedConstraints.has(conId)) continue;

    const conDisplayId = str(con["displayId"] ?? con["id"]);
    const conText = str(con["source_text"] ?? con["description"]);
    const module = deriveModuleFromConstraint(con, tasks);

    boundaryCounter.value++;
    tasks.push({
      taskId: `TASK-CON_${conId}_BOUNDARY`,
      testIdPrefix: `TC-B-${pad3(boundaryCounter.value)}`,
      type: "boundary",
      targetFunction: undefined,
      targetConstraints: [conDisplayId],
      targetExceptions: [],
      mustCover: [`约束 ${conDisplayId}: ${conText}`],
      moduleContext: module,
    });
  }

  // For each exception, create 1 exception test task
  for (const exc of exceptions) {
    const excDisplayId = str(exc["displayId"] ?? exc["id"]);
    const excCanonicalId = str(exc["id"]);
    const trigger = str(exc["trigger"]);
    const description = str(exc["description"]);
    const module = deriveModuleFromException(exc, tasks);

    exceptionCounter.value++;
    tasks.push({
      taskId: `TASK-EXC_${excCanonicalId}_EXCEPTION`,
      testIdPrefix: `TC-E-${pad3(exceptionCounter.value)}`,
      type: "exception",
      targetFunction: undefined,
      targetConstraints: [],
      targetExceptions: [excDisplayId],
      mustCover: [
        `异常 ${excDisplayId}: ${trigger || description}`,
        trigger ? `触发条件: ${trigger}` : `描述: ${description}`,
      ],
      moduleContext: module,
    });
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// groupByModule — 按 moduleContext 分组，拆分大组
// ---------------------------------------------------------------------------

export function groupByModule(tasks: TestTask[]): TaskGroup[] {
  const moduleMap = new Map<string, TestTask[]>();

  for (const task of tasks) {
    const key = task.moduleContext || "default";
    if (!moduleMap.has(key)) moduleMap.set(key, []);
    moduleMap.get(key)!.push(task);
  }

  const groups: TaskGroup[] = [];

  for (const [moduleContext, moduleTasks] of moduleMap) {
    // Sort: normal → boundary → exception
    const typeOrder: Record<string, number> = { normal: 0, boundary: 1, exception: 2 };
    moduleTasks.sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);

    // Split groups with >5 tasks into sub-groups of 3–5
    if (moduleTasks.length <= 5) {
      groups.push({ moduleContext, tasks: moduleTasks });
    } else {
      for (let i = 0; i < moduleTasks.length; i += 4) {
        const chunk = moduleTasks.slice(i, i + 4);
        groups.push({
          moduleContext: moduleTasks.length > 4 ? `${moduleContext} (${Math.floor(i / 4) + 1})` : moduleContext,
          tasks: chunk,
        });
      }
      // Merge last chunk into previous if it has < 3 tasks
      if (groups.length >= 2 && groups[groups.length - 1].tasks.length < 3) {
        const last = groups.pop()!;
        groups[groups.length - 1].tasks.push(...last.tasks);
      }
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// formatTaskGroupForPrompt — 序列化任务组为 LLM 可读文本
// ---------------------------------------------------------------------------

export function formatTaskGroupForPrompt(group: TaskGroup): string {
  const lines: string[] = [];
  lines.push(`## 模块: ${group.moduleContext}`);
  lines.push("");

  for (const task of group.tasks) {
    lines.push(`### 测试任务: ${task.taskId}`);
    lines.push(`- 测试ID前缀: ${task.testIdPrefix}`);
    lines.push(`- 类型: ${typeLabel(task.type)}`);
    if (task.targetFunction) {
      lines.push(`- 目标功能: ${task.targetFunction}`);
    }
    if (task.targetConstraints.length > 0) {
      lines.push(`- 目标约束: ${task.targetConstraints.join(", ")}`);
    }
    if (task.targetExceptions.length > 0) {
      lines.push(`- 目标异常: ${task.targetExceptions.join(", ")}`);
    }
    lines.push(`- 必须覆盖:`);
    for (const mc of task.mustCover) {
      lines.push(`  - ${mc}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asArray(val: unknown): Array<Record<string, unknown>> {
  return Array.isArray(val) ? (val as Array<Record<string, unknown>>) : [];
}

function asStrings(val: unknown): string[] {
  if (Array.isArray(val)) return val.map((v) => String(v ?? "")).filter(Boolean);
  return [];
}

function str(val: unknown): string {
  return String(val ?? "").trim();
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function typeLabel(type: "normal" | "boundary" | "exception"): string {
  if (type === "normal") return "正常";
  if (type === "boundary") return "边界";
  return "异常";
}

function deriveModuleFromFunction(func: Record<string, unknown>): string {
  // Try related_actors first
  const actors = asStrings(func["related_actors"]);
  if (actors.length > 0) {
    return actors.join(", ");
  }
  // Fallback: derive from function name
  const name = str(func["name"]);
  if (name) {
    // Take first word or PascalCase prefix
    const match = name.match(/^[A-Z][a-z]+/);
    if (match) return match[0];
    return name.split(/[\s_]/)[0] || name;
  }
  // Fallback: derive from canonical ID
  const id = str(func["id"]);
  if (id.startsWith("FUN_")) {
    const remainder = id.slice(4);
    const match = remainder.match(/^[A-Z][a-z]+/);
    if (match) return match[0];
  }
  return "default";
}

function deriveModuleFromConstraint(
  con: Record<string, unknown>,
  existingTasks: TestTask[],
): string {
  // If constraint has related_functions, inherit module from first related function
  const related = asStrings(con["related_functions"]);
  if (related.length > 0) {
    for (const relFn of related) {
      const match = existingTasks.find(
        (t) => t.targetFunction === relFn,
      );
      if (match) return match.moduleContext;
    }
    // Use the first related function ID as module
    return related[0];
  }
  return "default";
}

function deriveModuleFromException(
  exc: Record<string, unknown>,
  existingTasks: TestTask[],
): string {
  // Try to find module from exception's description mentioning a function
  const desc = str(exc["description"]).toLowerCase();
  for (const task of existingTasks) {
    if (task.targetFunction && desc.includes(task.targetFunction.toLowerCase())) {
      return task.moduleContext;
    }
  }
  return "default";
}

function findConstraintsForFunction(
  constraints: Array<Record<string, unknown>>,
  funcDisplayId: string,
  funcCanonicalId: string,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const con of constraints) {
    const related = asStrings(con["related_functions"]);
    if (
      related.includes(funcDisplayId) ||
      related.includes(funcCanonicalId)
    ) {
      result.push(con);
    }
  }
  return result;
}
