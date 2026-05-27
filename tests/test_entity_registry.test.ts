/**
 * Tests for Entity Registry architecture.
 *
 * Covers: types, registry extraction, planning integration,
 * merge entityRef grouping, and runtime passing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Phase 1: Type definitions
// ---------------------------------------------------------------------------

describe("Entity Registry types", () => {
  it("RegistryEntity has required fields", async () => {
    const { RegistryEntity, RegistryFunction, EntityRegistry } =
      await import("../src/shared/types.js");

    // We just need to verify the types exist and are usable
    const entity: import("../src/shared/types.js").RegistryEntity = {
      id: "E_CASE",
      canonicalName: "Case",
      displayName: "案件",
      aliases: ["Case", "案件", "Police Case"],
    };
    expect(entity.id).toBe("E_CASE");
    expect(entity.canonicalName).toBe("Case");
    expect(entity.displayName).toBe("案件");
    expect(entity.aliases).toHaveLength(3);
  });

  it("RegistryFunction has required fields", async () => {
    const fn: import("../src/shared/types.js").RegistryFunction = {
      id: "F_REGISTER_COMPLAINT",
      canonicalName: "RegisterComplaint",
      aliases: ["RegisterComplaint", "注册投诉"],
    };
    expect(fn.id).toBe("F_REGISTER_COMPLAINT");
    expect(fn.canonicalName).toBe("RegisterComplaint");
    expect(fn.aliases).toHaveLength(2);
  });

  it("EntityRegistry holds entities and functions", async () => {
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [
        {
          id: "E_CASE",
          canonicalName: "Case",
          displayName: "案件",
          aliases: ["Case", "案件"],
        },
      ],
      functions: [
        {
          id: "F_REGISTER",
          canonicalName: "Register",
          aliases: ["Register", "注册"],
        },
      ],
    };
    expect(registry.entities).toHaveLength(1);
    expect(registry.functions).toHaveLength(1);
  });

  it("ExecutionPlan has optional registry field", async () => {
    const { createExecutionPlan } = await import("../src/shared/types.js");
    const plan = createExecutionPlan({
      tasks: [],
      registry: {
        entities: [
          {
            id: "E_CASE",
            canonicalName: "Case",
            displayName: "案件",
            aliases: ["Case"],
          },
        ],
        functions: [],
      },
    });
    expect(plan.registry).toBeDefined();
    expect(plan.registry!.entities).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Registry extraction prompt
// ---------------------------------------------------------------------------

describe("Registry extraction prompt", () => {
  it("prompt file exists and contains expected placeholders", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const promptPath = path.resolve(__dirname, "..", "prompts", "registry_extraction.md");
    expect(fs.existsSync(promptPath)).toBe(true);
    const content = fs.readFileSync(promptPath, "utf-8");
    expect(content).toContain("{requirement_text}");
    expect(content).toContain("实体");
    expect(content).toContain("功能");
  });
});

// ---------------------------------------------------------------------------
// Phase 3: RegistryExtractor
// ---------------------------------------------------------------------------

describe("RegistryExtractor", () => {
  it("extract returns empty registry when prompt template is empty", async () => {
    const { RegistryExtractor } = await import("../src/generators/registryExtractor.js");
    const mockLlm = {
      generateJson: vi.fn(),
    } as any;
    // Simulate empty prompt by mocking loadPrompt - constructor reads prompt
    const extractor = new RegistryExtractor(mockLlm);
    // Override promptTemplate to empty
    (extractor as any).promptTemplate = "";
    const result = await extractor.extract("some requirement text");
    expect(result).toEqual({ entities: [], functions: [] });
  });

  it("extract calls LLM and returns parsed registry", async () => {
    const { RegistryExtractor } = await import("../src/generators/registryExtractor.js");
    const mockRegistry = {
      entities: [
        { id: "E_CASE", canonicalName: "Case", displayName: "案件", aliases: ["Case"] },
      ],
      functions: [
        { id: "F_REGISTER", canonicalName: "Register", aliases: ["Register"] },
      ],
    };
    const mockLlm = {
      generateJson: vi.fn().mockResolvedValue({ content: mockRegistry }),
    };
    const extractor = new RegistryExtractor(mockLlm);
    (extractor as any).promptTemplate = "template {requirement_text}";
    const result = await extractor.extract("requirement text");
    expect(result.entities).toHaveLength(1);
    expect(result.functions).toHaveLength(1);
    expect(result.entities[0].id).toBe("E_CASE");
  });

  it("extract handles LLM returning non-array entities gracefully", async () => {
    const { RegistryExtractor } = await import("../src/generators/registryExtractor.js");
    const mockLlm = {
      generateJson: vi.fn().mockResolvedValue({ content: { entities: "not-array", functions: null } }),
    };
    const extractor = new RegistryExtractor(mockLlm);
    (extractor as any).promptTemplate = "template {requirement_text}";
    const result = await extractor.extract("requirement text");
    expect(result.entities).toEqual([]);
    expect(result.functions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 4: Planning integration — _buildUserPrompt with registry
// ---------------------------------------------------------------------------

describe("PlanningTool registry integration", () => {
  it("_buildUserPrompt includes registry summary when provided", async () => {
    const { PlanningTool } = await import("../src/tools/planning.js");
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [
        { id: "E_CASE", canonicalName: "Case", displayName: "案件", aliases: ["Case", "案件"] },
        { id: "E_USER", canonicalName: "User", displayName: "用户", aliases: ["User", "用户"] },
      ],
      functions: [
        { id: "F_REGISTER", canonicalName: "Register", aliases: ["Register", "注册"] },
      ],
    };
    const prompt = PlanningTool._buildUserPrompt("some requirement", "design", undefined, registry);
    expect(prompt).toContain("E_CASE");
    expect(prompt).toContain("Case");
    expect(prompt).toContain("E_USER");
    expect(prompt).toContain("F_REGISTER");
    expect(prompt).toContain("Register");
  });

  it("_buildUserPrompt works without registry (backward compatible)", async () => {
    const { PlanningTool } = await import("../src/tools/planning.js");
    const prompt = PlanningTool._buildUserPrompt("some requirement", "design");
    expect(prompt).toContain("some requirement");
    expect(prompt).not.toContain("全局实体注册表");
  });
});

// ---------------------------------------------------------------------------
// Phase 7: Merge — entityRef-based grouping
// ---------------------------------------------------------------------------

describe("AnalyzeMerger entityRef-based grouping", () => {
  it("preMerge groups entities by entityRef when present", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const artifacts = [
      {
        taskId: "a1",
        content: {
          entities: [
            {
              entityRef: "E_CASE",
              name: "Case",
              description: "short desc",
              attributes: [{ name: "id", type: "String", description: "ID" }],
              relationships: [{ target: "User", type: "many-to-one", description: "" }],
            },
          ],
          functions: [],
          actors: [],
          constraints: [],
          exceptions: [],
          non_functional_requirements: [],
          business_processes: [],
        },
      },
      {
        taskId: "a2",
        content: {
          entities: [
            {
              entityRef: "E_CASE",
              name: "Case",
              description: "a longer and more detailed description of the case entity",
              attributes: [
                { name: "id", type: "String", description: "ID" },
                { name: "status", type: "String", description: "状态" },
              ],
              relationships: [{ target: "Officer", type: "many-to-one", description: "" }],
            },
          ],
          functions: [],
          actors: [],
          constraints: [],
          exceptions: [],
          non_functional_requirements: [],
          business_processes: [],
        },
      },
    ];
    const result = (AnalyzeMerger as any).prototype
      ? AnalyzeMerger.prototype.preMerge.call(
          { preMerge: AnalyzeMerger.prototype.preMerge },
          artifacts,
        )
      : new (AnalyzeMerger as any)(null).preMerge(artifacts);

    // The two E_CASE entities should be merged into one
    const entities = result.entities as Array<Record<string, unknown>>;
    const caseEntities = entities.filter((e) => (e.entityRef === "E_CASE") || (e.name === "Case"));
    // Should be exactly one merged Case entity
    expect(caseEntities.length).toBe(1);
    // Merged entity should have union of attributes
    const attrs = caseEntities[0].attributes as Array<Record<string, unknown>>;
    const attrNames = attrs.map((a) => a.name);
    expect(attrNames).toContain("id");
    expect(attrNames).toContain("status");
    // Merged entity should have union of relationships
    const rels = caseEntities[0].relationships as Array<Record<string, unknown>>;
    const relTargets = rels.map((r) => r.target);
    expect(relTargets).toContain("User");
    expect(relTargets).toContain("Officer");
  });

  it("preMerge collects proposeNewEntities from artifacts", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const merger = new (AnalyzeMerger as any)(null);
    const artifacts = [
      {
        taskId: "a1",
        content: {
          entities: [
            { name: "Case", description: "案件", attributes: [], relationships: [] },
          ],
          functions: [],
          actors: [],
          constraints: [],
          exceptions: [],
          non_functional_requirements: [],
          business_processes: [],
          proposeNewEntities: [
            { name: "NewEntity1", description: "新实体1", attributes: [] },
          ],
          proposeNewFunctions: [
            { name: "NewFunc1", description: "新功能1" },
          ],
        },
      },
    ];
    const result = merger.preMerge(artifacts);
    // proposeNewEntities should be collected
    const proposed = result.proposeNewEntities as Array<Record<string, unknown>> | undefined;
    expect(proposed).toBeDefined();
    expect(proposed!.length).toBeGreaterThanOrEqual(1);
    expect(proposed!.some((e) => e.name === "NewEntity1")).toBe(true);
  });

  it("preMerge falls back to name-based grouping when entityRef absent", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const merger = new (AnalyzeMerger as any)(null);
    const artifacts = [
      {
        taskId: "a1",
        content: {
          entities: [
            { name: "Case", description: "案件实体", attributes: [{ name: "id", type: "String", description: "ID" }], relationships: [] },
          ],
          functions: [],
          actors: [],
          constraints: [],
          exceptions: [],
          non_functional_requirements: [],
          business_processes: [],
        },
      },
      {
        taskId: "a2",
        content: {
          entities: [
            { name: "Case", description: "案件实体的详细描述", attributes: [{ name: "id", type: "String", description: "标识" }, { name: "status", type: "String", description: "状态" }], relationships: [] },
          ],
          functions: [],
          actors: [],
          constraints: [],
          exceptions: [],
          non_functional_requirements: [],
          business_processes: [],
        },
      },
    ];
    const result = merger.preMerge(artifacts);
    const entities = result.entities as Array<Record<string, unknown>>;
    const caseEntities = entities.filter((e) => e.name === "Case");
    expect(caseEntities.length).toBe(1);
    const attrs = caseEntities[0].attributes as Array<Record<string, unknown>>;
    expect(attrs.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Phase 8: buildRegistrySummary helper
// ---------------------------------------------------------------------------

describe("buildRegistrySummary", () => {
  it("formats registry entities and functions", async () => {
    const { buildRegistrySummary } = await import("../src/shared/registrySummary.js");
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [
        { id: "E_CASE", canonicalName: "Case", displayName: "案件", aliases: ["Case", "案件"] },
        { id: "E_USER", canonicalName: "User", displayName: "用户", aliases: ["User"] },
      ],
      functions: [
        { id: "F_REGISTER", canonicalName: "Register", aliases: ["Register", "注册"] },
      ],
    };
    const summary = buildRegistrySummary(registry);
    expect(summary).toContain("E_CASE");
    expect(summary).toContain("Case");
    expect(summary).toContain("案件");
    expect(summary).toContain("E_USER");
    expect(summary).toContain("F_REGISTER");
    expect(summary).toContain("Register");
  });

  it("returns empty string for empty registry", async () => {
    const { buildRegistrySummary } = await import("../src/shared/registrySummary.js");
    const summary = buildRegistrySummary({ entities: [], functions: [] });
    expect(summary).toBe("");
  });
});
