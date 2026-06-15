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
