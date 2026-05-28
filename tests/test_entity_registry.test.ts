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
    expect(result).toEqual({ entities: [], functions: [], actors: [], constraints: [], exceptions: [] });
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

// ---------------------------------------------------------------------------
// Fix 2: _getWords camelCase splitting
// ---------------------------------------------------------------------------

describe("AnalyzeMerger._getWords camelCase splitting", () => {
  it("splits camelCase words into separate tokens", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    // Access private static method
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
    // adminuser and ADMINUSER are same name case-insensitively — should merge
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
      functions: [],
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
      functions: [],
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
      functions: [
        { id: "F_REGISTER", canonicalName: "Register", aliases: ["Register"] },
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
    expect(result.functions).toHaveLength(1);
    expect(result.actors).toHaveLength(1);
    expect(result.actors![0].id).toBe("A_ADMIN");
  });
});

// ---------------------------------------------------------------------------
// Step 1: RegistryConstraint and RegistryException types
// ---------------------------------------------------------------------------

describe("RegistryConstraint type", () => {
  it("RegistryConstraint has required fields", () => {
    const constraint: import("../src/shared/types.js").RegistryConstraint = {
      id: "C_AUDIT_TRAIL_IMMUTABLE",
      canonicalName: "AuditTrailImmutability",
      displayName: "审计跟踪不可更改",
      aliases: ["Audit trail immutability", "审计跟踪数据不可修改"],
    };
    expect(constraint.id).toBe("C_AUDIT_TRAIL_IMMUTABLE");
    expect(constraint.canonicalName).toBe("AuditTrailImmutability");
    expect(constraint.displayName).toBe("审计跟踪不可更改");
    expect(constraint.aliases).toHaveLength(2);
  });
});

describe("RegistryException type", () => {
  it("RegistryException has required fields", () => {
    const exception: import("../src/shared/types.js").RegistryException = {
      id: "X_UNAUTHORIZED_ACCESS",
      canonicalName: "UnauthorizedAccess",
      displayName: "未授权访问",
      aliases: ["unauthorized access", "未授权访问异常"],
    };
    expect(exception.id).toBe("X_UNAUTHORIZED_ACCESS");
    expect(exception.canonicalName).toBe("UnauthorizedAccess");
    expect(exception.displayName).toBe("未授权访问");
    expect(exception.aliases).toHaveLength(2);
  });
});

describe("EntityRegistry with constraints and exceptions", () => {
  it("EntityRegistry holds constraints and exceptions", () => {
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [],
      functions: [],
      constraints: [
        {
          id: "C_AUDIT_TRAIL_IMMUTABLE",
          canonicalName: "AuditTrailImmutability",
          displayName: "审计跟踪不可更改",
          aliases: ["Audit trail immutability"],
        },
      ],
      exceptions: [
        {
          id: "X_UNAUTHORIZED_ACCESS",
          canonicalName: "UnauthorizedAccess",
          displayName: "未授权访问",
          aliases: ["unauthorized access"],
        },
      ],
    };
    expect(registry.constraints).toHaveLength(1);
    expect(registry.constraints![0].id).toBe("C_AUDIT_TRAIL_IMMUTABLE");
    expect(registry.exceptions).toHaveLength(1);
    expect(registry.exceptions![0].id).toBe("X_UNAUTHORIZED_ACCESS");
  });
});

describe("buildRegistrySummary with constraints and exceptions", () => {
  it("includes constraints section when constraints present", async () => {
    const { buildRegistrySummary } = await import("../src/shared/registrySummary.js");
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [],
      functions: [],
      constraints: [
        {
          id: "C_AUDIT_TRAIL_IMMUTABLE",
          canonicalName: "AuditTrailImmutability",
          displayName: "审计跟踪不可更改",
          aliases: ["Audit trail immutability", "审计跟踪数据不可修改"],
        },
      ],
    };
    const summary = buildRegistrySummary(registry);
    expect(summary).toContain("### 约束");
    expect(summary).toContain("C_AUDIT_TRAIL_IMMUTABLE");
    expect(summary).toContain("AuditTrailImmutability");
    expect(summary).toContain("审计跟踪不可更改");
    expect(summary).toContain("别名: Audit trail immutability, 审计跟踪数据不可修改");
  });

  it("includes exceptions section when exceptions present", async () => {
    const { buildRegistrySummary } = await import("../src/shared/registrySummary.js");
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [],
      functions: [],
      exceptions: [
        {
          id: "X_UNAUTHORIZED_ACCESS",
          canonicalName: "UnauthorizedAccess",
          displayName: "未授权访问",
          aliases: ["unauthorized access", "未授权访问异常"],
        },
      ],
    };
    const summary = buildRegistrySummary(registry);
    expect(summary).toContain("### 异常");
    expect(summary).toContain("X_UNAUTHORIZED_ACCESS");
    expect(summary).toContain("UnauthorizedAccess");
    expect(summary).toContain("未授权访问");
    expect(summary).toContain("别名: unauthorized access, 未授权访问异常");
  });

  it("handles empty constraints and exceptions gracefully", async () => {
    const { buildRegistrySummary } = await import("../src/shared/registrySummary.js");
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [],
      functions: [],
      constraints: [],
      exceptions: [],
    };
    const summary = buildRegistrySummary(registry);
    expect(summary).toBe("");
  });

  it("renders constraints without aliases correctly", async () => {
    const { buildRegistrySummary } = await import("../src/shared/registrySummary.js");
    const registry: import("../src/shared/types.js").EntityRegistry = {
      entities: [],
      functions: [],
      constraints: [
        {
          id: "C_SIMPLE",
          canonicalName: "SimpleRule",
          displayName: "简单规则",
          aliases: [],
        },
      ],
    };
    const summary = buildRegistrySummary(registry);
    expect(summary).toContain("### 约束");
    expect(summary).toContain("C_SIMPLE");
    expect(summary).not.toContain("别名");
  });
});

describe("RegistryExtractor with constraints and exceptions", () => {
  it("extract returns constraints and exceptions from LLM response", async () => {
    const { RegistryExtractor } = await import("../src/generators/registryExtractor.js");
    const mockRegistry = {
      entities: [
        { id: "E_CASE", canonicalName: "Case", displayName: "案件", aliases: ["Case"] },
      ],
      functions: [
        { id: "F_REGISTER", canonicalName: "Register", aliases: ["Register"] },
      ],
      constraints: [
        { id: "C_AUDIT_TRAIL_IMMUTABLE", canonicalName: "AuditTrailImmutability", displayName: "审计跟踪不可更改", aliases: ["Audit trail immutability"] },
      ],
      exceptions: [
        { id: "X_UNAUTHORIZED_ACCESS", canonicalName: "UnauthorizedAccess", displayName: "未授权访问", aliases: ["unauthorized access"] },
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
    expect(result.constraints).toHaveLength(1);
    expect(result.constraints![0].id).toBe("C_AUDIT_TRAIL_IMMUTABLE");
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions![0].id).toBe("X_UNAUTHORIZED_ACCESS");
  });

  it("extract handles missing constraints and exceptions gracefully", async () => {
    const { RegistryExtractor } = await import("../src/generators/registryExtractor.js");
    const mockRegistry = {
      entities: [],
      functions: [],
    };
    const mockLlm = {
      generateJson: vi.fn().mockResolvedValue({ content: mockRegistry }),
    };
    const extractor = new RegistryExtractor(mockLlm);
    (extractor as any).promptTemplate = "template {requirement_text}";
    const result = await extractor.extract("requirement text");
    expect(result.constraints).toEqual([]);
    expect(result.exceptions).toEqual([]);
  });

  it("extract returns empty constraints and exceptions when prompt template is empty", async () => {
    const { RegistryExtractor } = await import("../src/generators/registryExtractor.js");
    const mockLlm = {
      generateJson: vi.fn(),
    } as any;
    const extractor = new RegistryExtractor(mockLlm);
    (extractor as any).promptTemplate = "";
    const result = await extractor.extract("some requirement text");
    expect(result).toEqual({ entities: [], functions: [], actors: [], constraints: [], exceptions: [] });
  });
});

describe("Registry extraction prompt includes constraints and exceptions", () => {
  it("prompt file contains constraint and exception extraction rules", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const promptPath = path.resolve(__dirname, "..", "prompts", "registry_extraction.md");
    const content = fs.readFileSync(promptPath, "utf-8");
    expect(content).toContain("约束");
    expect(content).toContain("异常");
    expect(content).toContain("constraints");
    expect(content).toContain("exceptions");
  });
});
