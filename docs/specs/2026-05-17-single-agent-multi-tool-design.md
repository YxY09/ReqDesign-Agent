# Single Agent + Multi-Tool Renaming Design

## Motivation

The system has one agent with a decision loop, memory, and tools.
The current naming ("multi-agent") is misleading — PlannerAgent, GeneratorAgent,
EvaluatorAgent, RepairAgent are tools, not agents. Only the orchestrator has
agent properties: goal, state, memory, decision loop, stop conditions.

## Architecture

```
ReqDesignAgent (main agent)
  AgentRuntime          — runtime entry point
  AgentOrchestrator     — the brain (decide strategy)
  AgentMemory           — long-term experience (.reqdesign-memory)
  AgentPolicy           — behavior constraints (gates, budget)

  Tools (capabilities the agent calls):
    PlanningTool        — produce execution plans
    GenerationTool      — produce artifacts (analyze/design/diagrams/tests)
    EvaluationTool      — review artifacts, find issues
    RepairTool          — fix rejected artifacts

  Infrastructure:
    ToolSession         — one tool invocation context
    ToolRegistry        — session management
    ThreadBackend       — execution scheduling
```

## Directory Structure

```
src/
  agent/
    orchestrator.ts     <- src/agents/coordinator.ts
    types.ts            <- src/agents/types.ts
  tools/
    base.ts             <- src/agents/base.ts
    planning.ts         <- src/agents/planner.ts
    generation.ts       <- src/agents/generator.ts
    evaluation.ts       <- src/agents/evaluator.ts
    repair.ts           <- src/agents/repair.ts
    sessions.ts         <- src/agents/sessions.ts
```

`src/agents/` directory deleted after migration.

## Class Renames

| Old                | New               |
|--------------------|-------------------|
| BaseAgent          | BaseTool          |
| CoordinatorAgent   | AgentOrchestrator |
| PlannerAgent       | PlanningTool      |
| GeneratorAgent     | GenerationTool    |
| EvaluatorAgent     | EvaluationTool    |
| RepairAgent        | RepairTool        |
| GeneratorSession   | GenerationSession |
| EvaluatorSession   | EvaluationSession |
| PlannerSession     | PlanningSession   |
| WorkerSession      | ToolSession       |

## Unchanged Files

Only import paths and comments updated, no move/rename:

- src/runtime.ts
- src/session.ts
- src/execution/factory.ts
- src/execution/backend.ts
- src/orchestration/*
- src/generators/*
- src/memory/*

## Prompt Updates

- prompts/coordinator.md — orchestrator wording
- prompts/planner.md — PlanningTool references
- prompts/generator.md — tool memory wording
- prompts/planner_replan.md — evaluation tool references
- prompts/repair.md — EvaluationTool references
- prompts/evaluator.md — self-referencing wording
