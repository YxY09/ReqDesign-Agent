import { createTask, type Task } from "./types.js";

export function cloneTask(task: Task, overrides: Partial<Task> = {}): Task {
  const dependsOn = overrides.dependsOn ?? task.dependsOn;
  const contextHints = overrides.contextHints ?? task.contextHints;
  const targetIssues = overrides.targetIssues ?? task.targetIssues;
  const patchContext = overrides.patchContext ?? task.patchContext;

  return createTask({
    ...task,
    ...overrides,
    dependsOn: [...dependsOn],
    contextHints: { ...contextHints },
    targetIssues: targetIssues ? [...targetIssues] : undefined,
    patchContext: patchContext
      ? {
          targetArtifactId: patchContext.targetArtifactId,
          targetSections: patchContext.targetSections
            ? [...patchContext.targetSections]
            : undefined,
        }
      : undefined,
  });
}
