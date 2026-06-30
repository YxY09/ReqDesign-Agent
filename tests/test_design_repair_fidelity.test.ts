import { describe, it, expect, vi } from "vitest";
import { RepairTool } from "../src/tools/repair.js";
import { SystemDesigner } from "../src/generators/design.js";
import { createTask, isDesignModel } from "../src/shared/types.js";

/**
 * Regression coverage for the design-corruption-on-repair bug.
 *
 * Two compounding root causes are fixed here:
 *   FIX 1 — module field alias coercion (`_coerceModule`): a repair LLM that
 *     drifts module field names (moduleName/description/moduleId) is recovered
 *     to the canonical schema (name/responsibility/id) instead of rendering as
 *     blank table cells.
 *   FIX 2 — design-fidelity acceptance gate: a repaired design that regresses
 *     on coverage (drops a previously-referenced D-ID, drops a previously-
 *     covered F###, or leaves a module with an empty name/responsibility) is
 *     REJECTED and the pre-repair (better) design is kept.
 *
 * All tests use SYNTHETIC names/IDs (Foo/Core/D001/F001) — no S5/S12/
 * TaskAssignment/Person/Invoice references — and the gate checks are purely
 * structural/set-based (IDs + field-population), never hardcoded names.
 */

// ---------------------------------------------------------------------------
// LLM + fixture helpers (mirror test_repair_prompt.test.ts)
// ---------------------------------------------------------------------------

function jsonRepairLlm(response: Record<string, unknown>) {
  return {
    generateText: vi.fn(),
    generateJson: vi.fn().mockResolvedValue(response),
  } as any;
}

/**
 * A minimal pre-repair DesignModel used as the baseline for the fidelity gate.
 * Coverage: domain class refs D001+D002; functions F001+F002; module Core.
 */
function preRepairDesignModel() {
  return {
    constraintImplementations: [],
    exceptionImplementations: [],
    modules: [
      {
        id: "MOD_CORE",
        name: "Core",
        responsibility: "核心处理",
        functionIds: ["F001", "F002"],
      },
    ],
    classes: [
      {
        name: "Foo",
        kind: "domain",
        responsibility: "领域对象",
        entityRef: "Foo",
        domainRefs: ["D001", "D002"],
      },
    ],
    dataFlows: [],
    coverageMatrix: [],
    supplementaryClasses: [],
  };
}

/**
 * Requirement JSON matching the synthetic IDs above. The requirement index is
 * what reconcileDesignModel uses to keep/drop module.functionIds entries.
 */
function syntheticRequirementJson() {
  return {
    entities: [{ name: "Foo", description: "领域对象" }],
    functions: [
      { id: "F001", name: "CreateFoo", description: "创建 Foo" },
      { id: "F002", name: "QueryFoo", description: "查询 Foo" },
    ],
    constraints: [],
    exceptions: [],
  };
}

// ---------------------------------------------------------------------------
// FIX 1 — module field alias coercion (unit test via parseDesignModel)
// ---------------------------------------------------------------------------

describe("FIX 1 — _coerceModule recovers module field aliases", () => {
  it("(i) coerces moduleName/description/moduleId to name/responsibility/id and renders without blank cells", () => {
    const raw = {
      modules: [
        {
          moduleName: "Core",
          description: "核心处理",
          moduleId: "MOD_CORE",
          functionIds: ["F001"],
        },
      ],
      classes: [{ name: "Foo", kind: "domain", responsibility: "领域对象" }],
      dataFlows: [],
      coverageMatrix: [],
    };

    const model = SystemDesigner.parseDesignModel(raw);
    expect(model).not.toBeNull();
    const mod = model!.modules[0];
    expect(mod.name).toBe("Core");
    expect(mod.responsibility).toBe("核心处理");
    expect(mod.id).toBe("MOD_CORE");

    // The rendered markdown must contain the recovered name (no blank cell).
    const md = SystemDesigner.renderDesignMarkdown(model!);
    expect(md).toContain("Core");
    expect(md).toContain("核心处理");
    // No empty module table row (an empty cell would look like "|  |").
    expect(md).not.toMatch(/\|\s*\|\s*\|/);
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — design-fidelity acceptance gate (integration via RepairTool.repair)
// ---------------------------------------------------------------------------

describe("FIX 2 — design-fidelity gate rejects regressing repairs", () => {
  it("(ii) rejects a repair that drops a previously-referenced D-ID (keeps pre-repair)", async () => {
    // Post-repair drops D002 (only D001 referenced) — a coverage regression.
    const postRepair = {
      ...preRepairDesignModel(),
      classes: [
        {
          name: "Foo",
          kind: "domain",
          responsibility: "领域对象",
          entityRef: "Foo",
          domainRefs: ["D001"], // dropped D002
        },
      ],
    };

    const llm = jsonRepairLlm(postRepair);
    const agent = new RepairTool(llm);
    const task = createTask({
      id: "design-did-drop",
      type: "design",
      description: "repair system design",
    });

    const result = await agent.repair(
      task,
      preRepairDesignModel(),
      [
        {
          severity: "major",
          target_field: "design_text",
          description: "微调设计",
          suggestion: "微调",
        },
      ],
      { requirement_json: syntheticRequirementJson() },
    );

    // Rejected → result is the pre-repair design (still references D002).
    expect(isDesignModel(result)).toBe(true);
    const kept = result as ReturnType<typeof preRepairDesignModel>;
    const keptDRefs = (kept.classes[0] as any).domainRefs as string[];
    expect(keptDRefs).toContain("D002");
  });

  it("(iii) rejects a repair whose module has a blank name after coercion (keeps pre-repair)", async () => {
    // Post-repair emits a module with NO name and no usable alias → blank.
    const postRepair = {
      ...preRepairDesignModel(),
      modules: [
        {
          id: "MOD_CORE",
          // no name / moduleName / title
          responsibility: "核心处理",
          functionIds: ["F001", "F002"],
        },
      ],
    };

    const llm = jsonRepairLlm(postRepair);
    const agent = new RepairTool(llm);
    const task = createTask({
      id: "design-blank-module",
      type: "design",
      description: "repair system design",
    });

    const result = await agent.repair(
      task,
      preRepairDesignModel(),
      [
        {
          severity: "major",
          target_field: "design_text",
          description: "微调设计",
          suggestion: "微调",
        },
      ],
      { requirement_json: syntheticRequirementJson() },
    );

    // Rejected → result is the pre-repair design (module still named "Core").
    expect(isDesignModel(result)).toBe(true);
    const kept = result as ReturnType<typeof preRepairDesignModel>;
    expect(kept.modules[0].name).toBe("Core");
  });

  it("(iv) rejects a repair that drops a previously-covered function F### (keeps pre-repair)", async () => {
    // Post-repair drops F002 from module.functionIds — a coverage regression.
    const postRepair = {
      ...preRepairDesignModel(),
      modules: [
        {
          id: "MOD_CORE",
          name: "Core",
          responsibility: "核心处理",
          functionIds: ["F001"], // dropped F002
        },
      ],
    };

    const llm = jsonRepairLlm(postRepair);
    const agent = new RepairTool(llm);
    const task = createTask({
      id: "design-fid-drop",
      type: "design",
      description: "repair system design",
    });

    const result = await agent.repair(
      task,
      preRepairDesignModel(),
      [
        {
          severity: "major",
          target_field: "design_text",
          description: "微调设计",
          suggestion: "微调",
        },
      ],
      { requirement_json: syntheticRequirementJson() },
    );

    // Rejected → result is the pre-repair design (still covers F002).
    expect(isDesignModel(result)).toBe(true);
    const kept = result as ReturnType<typeof preRepairDesignModel>;
    expect(kept.modules[0].functionIds).toContain("F002");
  });

  it("(v) accepts a clean repair that regresses on nothing (no false positive)", async () => {
    // Post-repair is a strict superset: keeps D001+D002, keeps F001+F002, all
    // modules populated, and adds a distinguishing marker. Should be accepted.
    const postRepair = {
      ...preRepairDesignModel(),
      classes: [
        {
          name: "Foo",
          kind: "domain",
          responsibility: "领域对象（已优化）", // marker
          entityRef: "Foo",
          domainRefs: ["D001", "D002"],
        },
      ],
      modules: [
        {
          id: "MOD_CORE",
          name: "Core",
          responsibility: "核心处理",
          functionIds: ["F001", "F002"],
        },
      ],
    };

    const llm = jsonRepairLlm(postRepair);
    const agent = new RepairTool(llm);
    const task = createTask({
      id: "design-clean",
      type: "design",
      description: "repair system design",
    });

    const result = await agent.repair(
      task,
      preRepairDesignModel(),
      [
        {
          severity: "major",
          target_field: "design_text",
          description: "优化设计",
          suggestion: "优化",
        },
      ],
      { requirement_json: syntheticRequirementJson() },
    );

    // Accepted → result is the repaired design (contains the marker).
    expect(isDesignModel(result)).toBe(true);
    expect(JSON.stringify(result)).toContain("已优化");
  });
});
