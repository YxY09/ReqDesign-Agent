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
    const { EntityRegistry } =
      await import("../src/shared/types.js");

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

  it("EntityRegistry holds entities", async () => {
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [
        {
          id: "E_CASE",
          canonicalName: "Case",
          displayName: "案件",
          aliases: ["Case", "案件"],
        },
      ],
    };
    expect(registry.entities).toHaveLength(1);
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
    expect(content).toContain("角色");
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
    const extractor = new RegistryExtractor(mockLlm);
    (extractor as any).promptTemplate = "";
    const result = await extractor.extract("some requirement text");
    expect(result).toEqual({ entities: [], actors: [] });
  });

  it("extract calls LLM and returns parsed registry", async () => {
    const { RegistryExtractor } = await import("../src/generators/registryExtractor.js");
    const mockRegistry = {
      entities: [
        { id: "E_CASE", canonicalName: "Case", displayName: "案件", aliases: ["Case"] },
      ],
      actors: [
        { id: "A_ADMIN", canonicalName: "Admin", displayName: "管理员", aliases: ["Admin"] },
      ],
    };
    const mockLlm = {
      generateJson: vi.fn().mockResolvedValue({ content: mockRegistry }),
    };
    const extractor = new RegistryExtractor(mockLlm);
    (extractor as any).promptTemplate = "template {requirement_text}";
    const result = await extractor.extract("requirement text");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].id).toBe("E_CASE");
    expect(result.actors).toHaveLength(1);
    expect(result.actors![0].id).toBe("A_ADMIN");
  });

  it("extract handles LLM returning non-array entities gracefully", async () => {
    const { RegistryExtractor } = await import("../src/generators/registryExtractor.js");
    const mockLlm = {
      generateJson: vi.fn().mockResolvedValue({ content: { entities: "not-array", actors: null } }),
    };
    const extractor = new RegistryExtractor(mockLlm);
    (extractor as any).promptTemplate = "template {requirement_text}";
    const result = await extractor.extract("requirement text");
    expect(result.entities).toEqual([]);
    expect(result.actors).toEqual([]);
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
      actors: [
        { id: "A_ADMIN", canonicalName: "Admin", displayName: "管理员", aliases: ["Admin"] },
      ],
    };
    const prompt = PlanningTool._buildUserPrompt("some requirement", "design", undefined, registry);
    expect(prompt).toContain("E_CASE");
    expect(prompt).toContain("Case");
    expect(prompt).toContain("E_USER");
    expect(prompt).toContain("A_ADMIN");
    expect(prompt).toContain("Admin");
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

  it("merge applies relationship_entities returned by post-process", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const mockLlm = {
      generateJson: vi.fn().mockResolvedValue({
        relationships: [],
        relationship_entities: [
          {
            name: "CaseRegistration",
            entityKind: "process_record",
            description: "案件注册记录",
            attributes: [
              { name: "caseRegistrationId", type: "Long", description: "ID" },
              { name: "status", type: "String", description: "状态" },
            ],
            relationships: [
              { target: "Case", type: "many-to-one", description: "关联案件" },
              { target: "Complaint", type: "many-to-one", description: "关联投诉" },
            ],
            reifies: {
              source: "business_process",
              sourceName: "CaseRegistration",
              endpoints: ["Case", "Complaint"],
              evidence: ["has_identifier", "has_status"],
            },
          },
        ],
        constraints: [],
        exceptions: [],
      }),
    };
    const merger = new (AnalyzeMerger as any)(mockLlm);
    (merger as any).postProcessPromptTemplate = "template {merged_summary} {requirement_text}";

    const result = await merger.merge(
      [
        {
          taskId: "a1",
          content: {
            actors: [],
            functions: [],
            entities: [
              { name: "Case", attributes: [{ name: "caseId", type: "Long", description: "ID" }], relationships: [] },
            ],
            constraints: [],
            exceptions: [],
            non_functional_requirements: [],
            business_processes: [
              { name: "CaseRegistration", steps: ["Assign case number", "Update status"] },
            ],
          },
        },
        {
          taskId: "a2",
          content: {
            actors: [],
            functions: [],
            entities: [
              { name: "Complaint", attributes: [{ name: "complaintId", type: "Long", description: "ID" }], relationships: [] },
            ],
            constraints: [],
            exceptions: [],
            non_functional_requirements: [],
            business_processes: [],
          },
        },
      ],
      "CaseRegistration has a registration number and status.",
    );

    const entities = result.entities as Array<Record<string, unknown>>;
    const registration = entities.find((entity) => entity.name === "CaseRegistration");
    expect(registration).toBeDefined();
    expect(registration!.entityKind).toBe("process_record");
    expect(registration!.entityRef).toBe("E_CASE_REGISTRATION");
    const relTargets = (registration!.relationships as Array<Record<string, unknown>>)
      .map((rel) => rel.target);
    expect(relTargets).toContain("E_CASE");
    expect(relTargets).toContain("E_COMPLAINT");
  });
});

// ---------------------------------------------------------------------------
// Phase 8: buildRegistrySummary helper
// ---------------------------------------------------------------------------

describe("buildRegistrySummary", () => {
  it("formats registry entities and actors", async () => {
    const { buildRegistrySummary } = await import("../src/shared/registrySummary.js");
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [
        { id: "E_CASE", canonicalName: "Case", displayName: "案件", aliases: ["Case", "案件"] },
        { id: "E_USER", canonicalName: "User", displayName: "用户", aliases: ["User"] },
      ],
      actors: [
        { id: "A_ADMIN", canonicalName: "Admin", displayName: "管理员", aliases: ["Admin"] },
      ],
    };
    const summary = buildRegistrySummary(registry);
    expect(summary).toContain("E_CASE");
    expect(summary).toContain("Case");
    expect(summary).toContain("案件");
    expect(summary).toContain("E_USER");
    expect(summary).toContain("A_ADMIN");
    expect(summary).toContain("Admin");
  });

  it("returns empty string for empty registry", async () => {
    const { buildRegistrySummary } = await import("../src/shared/registrySummary.js");
    const summary = buildRegistrySummary({ entities: [] });
    expect(summary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Fix 2: _getWords camelCase splitting
// ---------------------------------------------------------------------------

describe("AnalyzeMerger._getWords camelCase splitting", () => {
  it("splits camelCase words into separate tokens", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const getWords = (AnalyzeMerger as any)._getWords as (s: string) => Set<string>;
    const words = getWords("AdminUser");
    expect(words.has("admin")).toBe(true);
    expect(words.has("user")).toBe(true);
  });

  it("splits multi-word camelCase", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const getWords = (AnalyzeMerger as any)._getWords as (s: string) => Set<string>;
    const words = getWords("SuperAdminUser");
    expect(words.has("super")).toBe(true);
    expect(words.has("admin")).toBe(true);
    expect(words.has("user")).toBe(true);
  });

  it("merges camelCase actors with same lowercased name", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const merger = new (AnalyzeMerger as any)(null);
    const artifacts = [
      {
        taskId: "a1",
        content: {
          entities: [],
          functions: [],
          actors: [{ name: "AdminUser", description: "Administrator user" }],
          constraints: [],
          exceptions: [],
          non_functional_requirements: [],
          business_processes: [],
        },
      },
      {
        taskId: "a2",
        content: {
          entities: [],
          functions: [],
          actors: [{ name: "ADMINUSER", description: "System administrator with full access" }],
          constraints: [],
          exceptions: [],
          non_functional_requirements: [],
          business_processes: [],
        },
      },
    ];
    const result = merger.preMerge(artifacts);
    const actors = result.actors as Array<Record<string, unknown>>;
    const adminActors = actors.filter(
      (a) => String(a.name).toLowerCase().includes("admin"),
    );
    expect(adminActors.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 5: RegistryActor type and actors in registry
// ---------------------------------------------------------------------------

describe("RegistryActor type", () => {
  it("RegistryActor has required fields", async () => {
    const actor: import("../src/shared/types.js").RegistryActor = {
      id: "A_ADMIN",
      canonicalName: "Admin",
      displayName: "管理员",
      aliases: ["Admin", "AdminUser", "Administrator", "管理员", "SuperUser"],
    };
    expect(actor.id).toBe("A_ADMIN");
    expect(actor.canonicalName).toBe("Admin");
    expect(actor.displayName).toBe("管理员");
    expect(actor.aliases).toHaveLength(5);
  });

  it("EntityRegistry holds actors", async () => {
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [],
      actors: [
        {
          id: "A_ADMIN",
          canonicalName: "Admin",
          displayName: "管理员",
          aliases: ["Admin"],
        },
      ],
    };
    expect(registry.actors).toHaveLength(1);
    expect(registry.actors![0].id).toBe("A_ADMIN");
  });
});

describe("buildRegistrySummary with actors", () => {
  it("includes actors section when actors present", async () => {
    const { buildRegistrySummary } = await import("../src/shared/registrySummary.js");
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [],
      actors: [
        { id: "A_ADMIN", canonicalName: "Admin", displayName: "管理员", aliases: ["Admin", "Administrator"] },
      ],
    };
    const summary = buildRegistrySummary(registry);
    expect(summary).toContain("A_ADMIN");
    expect(summary).toContain("Admin");
    expect(summary).toContain("管理员");
  });
});

describe("AnalyzeMerger actorRef-based grouping", () => {
  it("preMerge groups actors by actorRef when present", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const merger = new (AnalyzeMerger as any)(null);
    const artifacts = [
      {
        taskId: "a1",
        content: {
          entities: [],
          functions: [],
          actors: [
            { actorRef: "A_ADMIN", name: "Admin", description: "short" },
          ],
          constraints: [],
          exceptions: [],
          non_functional_requirements: [],
          business_processes: [],
        },
      },
      {
        taskId: "a2",
        content: {
          entities: [],
          functions: [],
          actors: [
            { actorRef: "A_ADMIN", name: "Admin", description: "Administrator with full access" },
          ],
          constraints: [],
          exceptions: [],
          non_functional_requirements: [],
          business_processes: [],
        },
      },
    ];
    const result = merger.preMerge(artifacts);
    const actors = result.actors as Array<Record<string, unknown>>;
    const adminActors = actors.filter((a) => a.actorRef === "A_ADMIN" || String(a.name) === "Admin");
    expect(adminActors.length).toBe(1);
    expect(String(adminActors[0].description)).toContain("Administrator");
  });

  it("preMerge falls back to name+Jaccard for actors without actorRef", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const merger = new (AnalyzeMerger as any)(null);
    const artifacts = [
      {
        taskId: "a1",
        content: {
          entities: [],
          functions: [],
          actors: [{ name: "Admin", description: "Admin user" }],
          constraints: [],
          exceptions: [],
          non_functional_requirements: [],
          business_processes: [],
        },
      },
      {
        taskId: "a2",
        content: {
          entities: [],
          functions: [],
          actors: [{ name: "Admin", description: "System administrator" }],
          constraints: [],
          exceptions: [],
          non_functional_requirements: [],
          business_processes: [],
        },
      },
    ];
    const result = merger.preMerge(artifacts);
    const actors = result.actors as Array<Record<string, unknown>>;
    const adminActors = actors.filter((a) => String(a.name) === "Admin");
    expect(adminActors.length).toBe(1);
  });
});

describe("RegistryExtractor with actors", () => {
  it("extract returns actors from LLM response", async () => {
    const { RegistryExtractor } = await import("../src/generators/registryExtractor.js");
    const mockRegistry = {
      entities: [
        { id: "E_CASE", canonicalName: "Case", displayName: "案件", aliases: ["Case"] },
      ],
      actors: [
        { id: "A_ADMIN", canonicalName: "Admin", displayName: "管理员", aliases: ["Admin"] },
      ],
    };
    const mockLlm = {
      generateJson: vi.fn().mockResolvedValue({ content: mockRegistry }),
    };
    const extractor = new RegistryExtractor(mockLlm);
    (extractor as any).promptTemplate = "template {requirement_text}";
    const result = await extractor.extract("requirement text");
    expect(result.entities).toHaveLength(1);
    expect(result.actors).toHaveLength(1);
    expect(result.actors![0].id).toBe("A_ADMIN");
  });
});

// ---------------------------------------------------------------------------
// Phase 3.2: RegistryFunction type and functions in registry
// ---------------------------------------------------------------------------

describe("RegistryFunction type", () => {
  it("RegistryFunction has required fields", async () => {
    const fn: import("../src/shared/types.js").RegistryFunction = {
      id: "FUN_REGISTER_CASE",
      name: "RegisterCase",
      aliases: ["注册案件", "initiate case"],
    };
    expect(fn.id).toBe("FUN_REGISTER_CASE");
    expect(fn.name).toBe("RegisterCase");
    expect(fn.aliases).toHaveLength(2);
  });

  it("EntityRegistry holds functions", async () => {
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [],
      functions: [
        { id: "FUN_REGISTER_CASE", name: "RegisterCase", aliases: ["注册案件"] },
        { id: "FUN_SEARCH_CASE", name: "SearchCase", aliases: ["搜索案件"] },
      ],
    };
    expect(registry.functions).toHaveLength(2);
    expect(registry.functions![0].id).toBe("FUN_REGISTER_CASE");
  });
});

describe("buildRegistrySummary with functions", () => {
  it("includes functions section when functions present", async () => {
    const { buildRegistrySummary } = await import("../src/shared/registrySummary.js");
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [],
      functions: [
        { id: "FUN_REGISTER_CASE", name: "RegisterCase", aliases: ["注册案件", "initiate case"] },
        { id: "FUN_SEARCH_CASE", name: "SearchCase", aliases: ["搜索案件"] },
      ],
    };
    const summary = buildRegistrySummary(registry);
    expect(summary).toContain("FUN_REGISTER_CASE");
    expect(summary).toContain("RegisterCase");
    expect(summary).toContain("FUN_SEARCH_CASE");
    expect(summary).toContain("SearchCase");
  });
});

describe("RegistryExtractor with functions", () => {
  it("extract returns functions from LLM response", async () => {
    const { RegistryExtractor } = await import("../src/generators/registryExtractor.js");
    const mockRegistry = {
      entities: [
        { id: "E_CASE", canonicalName: "Case", displayName: "案件", aliases: ["Case"] },
      ],
      functions: [
        { id: "FUN_REGISTER_CASE", name: "RegisterCase", aliases: ["注册案件"] },
      ],
    };
    const mockLlm = {
      generateJson: vi.fn().mockResolvedValue({ content: mockRegistry }),
    };
    const extractor = new RegistryExtractor(mockLlm);
    (extractor as any).promptTemplate = "template {requirement_text}";
    const result = await extractor.extract("requirement text");
    expect(result.functions).toHaveLength(1);
    expect(result.functions![0].id).toBe("FUN_REGISTER_CASE");
    expect(result.functions![0].name).toBe("RegisterCase");
  });

  it("extract handles missing functions gracefully", async () => {
    const { RegistryExtractor } = await import("../src/generators/registryExtractor.js");
    const mockLlm = {
      generateJson: vi.fn().mockResolvedValue({ content: { entities: [], functions: null } }),
    };
    const extractor = new RegistryExtractor(mockLlm);
    (extractor as any).promptTemplate = "template {requirement_text}";
    const result = await extractor.extract("requirement text");
    expect(result.functions).toEqual([]);
  });
});

describe("PlanningTool functionRegistry injection", () => {
  it("_buildUserPrompt includes functions in registry summary", async () => {
    const { PlanningTool } = await import("../src/tools/planning.js");
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [],
      functions: [
        { id: "FUN_REGISTER_CASE", name: "RegisterCase", aliases: ["注册案件"] },
      ],
    };
    const prompt = PlanningTool._buildUserPrompt("some requirement", "design", undefined, registry);
    expect(prompt).toContain("FUN_REGISTER_CASE");
    expect(prompt).toContain("RegisterCase");
  });
});

// ---------------------------------------------------------------------------
// Regression: merge() must clean entity id to entityRef before canonicalize
// ---------------------------------------------------------------------------

describe("AnalyzeMerger merge — entity id cleaned from entityRef", () => {
  it("overwrites stale LLM-assigned entity id with entityRef after merge", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const merger = new (AnalyzeMerger as any)(null);

    // Simulate a single artifact with entity having entityRef but wrong id
    const artifacts = [
      {
        taskId: "a1",
        content: {
          entities: [
            {
              id: "E002",
              entityRef: "E_CASE",
              name: "Case",
              description: "案件实体",
              attributes: [{ name: "id", type: "String", description: "ID" }],
              relationships: [],
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

    const result = await merger.merge(artifacts, "requirement text");
    const entities = result.entities as Array<Record<string, unknown>>;
    const caseEntity = entities.find((e) => e.entityRef === "E_CASE");

    expect(caseEntity).toBeDefined();
    // The stale id "E002" should be replaced with entityRef "E_CASE"
    expect(caseEntity!.id).toBe("E_CASE");
  });
});
