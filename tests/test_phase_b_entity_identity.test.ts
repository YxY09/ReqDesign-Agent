/**
 * Phase B: Entity identity enforcement tests.
 *
 * Covers: {registry_summary} prompt injection (analyze.ts),
 * proposeNewEntities absorption (merge.ts).
 */
import { describe, it, expect, vi } from "vitest";

// ═══════════════════════════════════════════════════════
//  analyze.ts — {registry_summary} injection
// ═══════════════════════════════════════════════════════

describe("RequirementAnalyzer — registry_summary injection", () => {
  it("analyze() replaces {registry_summary} placeholder with actual entity IDs", async () => {
    const { RequirementAnalyzer } = await import("../src/generators/analyze.js");
    let capturedPrompt = "";
    const mockLlm = {
      generateJson: vi.fn().mockImplementation((prompt: string) => {
        capturedPrompt = prompt;
        return Promise.resolve({
          actors: [], functions: [], entities: [], constraints: [], exceptions: [],
          non_functional_requirements: [], business_processes: [],
          proposeNewEntities: [], proposeNewFunctions: [],
        });
      }),
    };
    const analyzer = new RequirementAnalyzer(mockLlm as any);
    (analyzer as any).promptTemplate =
      "header: {registry_summary}\nbody: {requirement_text}\n{available_constraints}";

    const registry = {
      entities: [{ id: "E_CASE", canonicalName: "Case", displayName: "案件", aliases: ["Case"] }],
      actors: [],
    };

    await analyzer.analyze("some requirement text", 1, undefined, undefined, undefined, registry);

    expect(capturedPrompt).toContain("E_CASE");
    expect(capturedPrompt).not.toContain("{registry_summary}");
  });

  it("analyze() replaces {registry_summary} with empty string when no registry provided", async () => {
    const { RequirementAnalyzer } = await import("../src/generators/analyze.js");
    let capturedPrompt = "";
    const mockLlm = {
      generateJson: vi.fn().mockImplementation((prompt: string) => {
        capturedPrompt = prompt;
        return Promise.resolve({
          actors: [], functions: [], entities: [], constraints: [], exceptions: [],
          non_functional_requirements: [], business_processes: [],
          proposeNewEntities: [], proposeNewFunctions: [],
        });
      }),
    };
    const analyzer = new RequirementAnalyzer(mockLlm as any);
    (analyzer as any).promptTemplate =
      "header: {registry_summary}\nbody: {requirement_text}\n{available_constraints}";

    await analyzer.analyze("some requirement text", 1);

    expect(capturedPrompt).not.toContain("{registry_summary}");
    expect(capturedPrompt).toContain("some requirement text");
  });

  it("analyze() without {registry_summary} in template is unaffected", async () => {
    const { RequirementAnalyzer } = await import("../src/generators/analyze.js");
    let capturedPrompt = "";
    const mockLlm = {
      generateJson: vi.fn().mockImplementation((prompt: string) => {
        capturedPrompt = prompt;
        return Promise.resolve({
          actors: [], functions: [], entities: [], constraints: [], exceptions: [],
          non_functional_requirements: [], business_processes: [],
          proposeNewEntities: [], proposeNewFunctions: [],
        });
      }),
    };
    const analyzer = new RequirementAnalyzer(mockLlm as any);
    (analyzer as any).promptTemplate = "simple template: {requirement_text}\n{available_constraints}";

    const registry = {
      entities: [{ id: "E_CASE", canonicalName: "Case", displayName: "案件", aliases: ["Case"] }],
      actors: [],
    };

    await analyzer.analyze("some requirement text", 1, undefined, undefined, undefined, registry);

    expect(capturedPrompt).toContain("some requirement text");
    // Registry data must NOT appear in prompt when template has no {registry_summary} slot
    expect(capturedPrompt).not.toContain("E_CASE");
  });

  it("analyze() replaces {registry_summary} with empty string when registry has no entities", async () => {
    const { RequirementAnalyzer } = await import("../src/generators/analyze.js");
    let capturedPrompt = "";
    const mockLlm = {
      generateJson: vi.fn().mockImplementation((prompt: string) => {
        capturedPrompt = prompt;
        return Promise.resolve({
          actors: [], functions: [], entities: [], constraints: [], exceptions: [],
          non_functional_requirements: [], business_processes: [],
          proposeNewEntities: [], proposeNewFunctions: [],
        });
      }),
    };
    const analyzer = new RequirementAnalyzer(mockLlm as any);
    (analyzer as any).promptTemplate =
      "header: {registry_summary}\nbody: {requirement_text}\n{available_constraints}";

    const emptyRegistry = { entities: [], actors: [] };
    await analyzer.analyze("some requirement text", 1, undefined, undefined, undefined, emptyRegistry);

    expect(capturedPrompt).not.toContain("{registry_summary}");
  });
});

// ═══════════════════════════════════════════════════════
//  merge.ts — proposeNewEntities absorption
// ═══════════════════════════════════════════════════════

describe("AnalyzeMerger — proposeNewEntities absorbed into final entities", () => {
  it("merge() single-artifact: proposeNewEntities items are added to entities", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const merger = new (AnalyzeMerger as any)(null);

    const result = await merger.merge(
      [
        {
          taskId: "a1",
          content: {
            entities: [
              {
                entityRef: "E_CASE",
                name: "Case",
                description: "案件",
                attributes: [{ name: "id", type: "Long", description: "ID" }],
                relationships: [],
              },
            ],
            functions: [], actors: [], constraints: [], exceptions: [],
            non_functional_requirements: [], business_processes: [],
            proposeNewEntities: [
              {
                name: "Evidence",
                description: "证据",
                attributes: [{ name: "evidenceId", type: "Long", description: "证据ID" }],
                relationships: [],
              },
            ],
            proposeNewFunctions: [],
          },
        },
      ],
      "Case has an Evidence attachment."
    );

    const entities = result.entities as Array<Record<string, unknown>>;
    const evidenceEntity = entities.find(
      (e) => String(e.name ?? e.canonicalName ?? "").includes("Evidence"),
    );
    expect(evidenceEntity).toBeDefined();
  });

  it("merge() multi-artifact: proposeNewEntities from shards are absorbed", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const merger = new (AnalyzeMerger as any)(null);

    const result = await merger.merge(
      [
        {
          taskId: "a1",
          content: {
            entities: [
              { entityRef: "E_CASE", name: "Case", description: "案件", attributes: [], relationships: [] },
            ],
            functions: [], actors: [], constraints: [], exceptions: [],
            non_functional_requirements: [], business_processes: [],
            proposeNewEntities: [
              {
                name: "Evidence",
                description: "证据",
                attributes: [{ name: "evidenceId", type: "Long", description: "" }],
                relationships: [],
              },
            ],
            proposeNewFunctions: [],
          },
        },
        {
          taskId: "a2",
          content: {
            entities: [
              { entityRef: "E_USER", name: "User", description: "用户", attributes: [], relationships: [] },
            ],
            functions: [], actors: [], constraints: [], exceptions: [],
            non_functional_requirements: [], business_processes: [],
            proposeNewEntities: [],
            proposeNewFunctions: [],
          },
        },
      ],
      "Case has User and Evidence."
    );

    const entities = result.entities as Array<Record<string, unknown>>;
    const evidenceEntity = entities.find(
      (e) => String(e.name ?? e.canonicalName ?? "").includes("Evidence"),
    );
    expect(evidenceEntity).toBeDefined();
    // Original entities still present
    expect(entities.some((e) => String(e.name ?? "").includes("Case"))).toBe(true);
    expect(entities.some((e) => String(e.name ?? "").includes("User"))).toBe(true);
  });

  it("_absorbProposedEntities skips entities whose name already exists in entities", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const merger = new (AnalyzeMerger as any)(null);

    const result = await merger.merge(
      [
        {
          taskId: "a1",
          content: {
            entities: [
              { name: "Case", description: "案件（已有）", attributes: [], relationships: [] },
            ],
            functions: [], actors: [], constraints: [], exceptions: [],
            non_functional_requirements: [], business_processes: [],
            proposeNewEntities: [
              { name: "Case", description: "案件（重复）", attributes: [], relationships: [] },
            ],
            proposeNewFunctions: [],
          },
        },
      ],
      "Case entity dedup test."
    );

    const entities = result.entities as Array<Record<string, unknown>>;
    const caseEntities = entities.filter(
      (e) => String(e.name ?? e.canonicalName ?? "").toLowerCase().includes("case"),
    );
    // Must not have been duplicated
    expect(caseEntities.length).toBe(1);
  });

  it("absorbed entities receive canonical IDs via normalizeEntityIdentities", async () => {
    const { AnalyzeMerger } = await import("../src/generators/merge.js");
    const merger = new (AnalyzeMerger as any)(null);

    const result = await merger.merge(
      [
        {
          taskId: "a1",
          content: {
            entities: [],
            functions: [], actors: [], constraints: [], exceptions: [],
            non_functional_requirements: [], business_processes: [],
            proposeNewEntities: [
              {
                name: "EvidenceDocument",
                description: "证据文件",
                attributes: [{ name: "docId", type: "Long", description: "文件ID" }],
                relationships: [],
              },
            ],
            proposeNewFunctions: [],
          },
        },
      ],
      "EvidenceDocument is a core entity."
    );

    const entities = result.entities as Array<Record<string, unknown>>;
    const doc = entities.find(
      (e) => String(e.name ?? e.canonicalName ?? "").toLowerCase().includes("evidence"),
    );
    expect(doc).toBeDefined();
    // Should have a canonical ID (starts with E_)
    expect(String(doc!.id ?? "")).toMatch(/^E_/);
  });
});
