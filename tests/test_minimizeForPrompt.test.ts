import { describe, it, expect } from "vitest";
import { minimizeForPrompt } from "../src/shared/minimizeJsonForPrompt.js";

describe("minimizeForPrompt", () => {
  it("strips internal constraint fields: normalizedRule, evidence, verification, constraintUid, descriptionZh, canonicalRuleEn", () => {
    const analysis = {
      constraints: [
        {
          displayId: "C001",
          id: "CON_001",
          description: "Must validate email",
          source_text: "Email must be valid",
          normalizedRule: "RULE_ABC",
          evidence: "some evidence",
          verification: "verify",
          constraintUid: "uid-123",
          descriptionZh: "必须验证邮箱",
          canonicalRuleEn: "email must be valid",
        },
      ],
    };

    const result = minimizeForPrompt(analysis);
    const c = (result.constraints as Array<Record<string, unknown>>)[0];

    expect(c.displayId).toBe("C001");
    expect(c.id).toBe("CON_001");
    expect(c.description).toBe("Must validate email");
    expect(c.source_text).toBe("Email must be valid");
    expect(c.normalizedRule).toBeUndefined();
    expect(c.evidence).toBeUndefined();
    expect(c.verification).toBeUndefined();
    expect(c.constraintUid).toBeUndefined();
    expect(c.descriptionZh).toBeUndefined();
    expect(c.canonicalRuleEn).toBeUndefined();
  });

  it("transforms relatedFunctions object array to related_functions string array", () => {
    const analysis = {
      constraints: [
        {
          displayId: "C001",
          id: "CON_001",
          description: "Must validate",
          source_text: "validate",
          relatedFunctions: [
            { functionId: "FUN_A", name: "func A" },
            { functionId: "FUN_B", name: "func B" },
          ],
        },
      ],
    };

    const result = minimizeForPrompt(analysis);
    const c = (result.constraints as Array<Record<string, unknown>>)[0];

    expect(c.related_functions).toEqual(["FUN_A", "FUN_B"]);
    expect(c.relatedFunctions).toBeUndefined();
  });

  it("omits related_functions when relatedFunctions was empty", () => {
    const analysis = {
      constraints: [
        {
          displayId: "C001",
          id: "CON_001",
          description: "Must validate",
          source_text: "validate",
          relatedFunctions: [],
        },
      ],
    };

    const result = minimizeForPrompt(analysis);
    const c = (result.constraints as Array<Record<string, unknown>>)[0];

    expect(c.related_functions).toBeUndefined();
    expect(c.relatedFunctions).toBeUndefined();
  });

  it("handles string-type relatedFunctions entries", () => {
    const analysis = {
      constraints: [
        {
          displayId: "C001",
          id: "CON_001",
          description: "Must validate",
          relatedFunctions: ["FUN_A", "FUN_B"],
        },
      ],
    };

    const result = minimizeForPrompt(analysis);
    const c = (result.constraints as Array<Record<string, unknown>>)[0];

    expect(c.related_functions).toEqual(["FUN_A", "FUN_B"]);
    expect(c.relatedFunctions).toBeUndefined();
  });

  it("truncates entity attributes to 5 with a marker", () => {
    const analysis = {
      entities: [
        {
          id: "ENT_USER",
          name: "User",
          description: "A user",
          attributes: [
            { name: "a1" },
            { name: "a2" },
            { name: "a3" },
            { name: "a4" },
            { name: "a5" },
            { name: "a6" },
            { name: "a7" },
          ],
        },
      ],
    };

    const result = minimizeForPrompt(analysis);
    const entity = (result.entities as Array<Record<string, unknown>>)[0];
    const attrs = entity.attributes as Array<unknown>;

    expect(attrs).toHaveLength(5);
    expect(entity._attributes_truncated).toBe(true);
  });

  it("does not truncate entity with 5 or fewer attributes", () => {
    const analysis = {
      entities: [
        {
          id: "ENT_USER",
          name: "User",
          description: "A user",
          attributes: [
            { name: "a1" },
            { name: "a2" },
            { name: "a3" },
          ],
        },
      ],
    };

    const result = minimizeForPrompt(analysis);
    const entity = (result.entities as Array<Record<string, unknown>>)[0];
    const attrs = entity.attributes as Array<unknown>;

    expect(attrs).toHaveLength(3);
    expect(entity._attributes_truncated).toBeUndefined();
  });

  it("deletes traceability from root", () => {
    const analysis = {
      entities: [],
      functions: [],
      constraints: [],
      traceability: { matrix: [{ from: "ENT_A", to: "FUN_A" }] },
    };

    const result = minimizeForPrompt(analysis);

    expect(result.traceability).toBeUndefined();
  });

  it("does not mutate the original input", () => {
    const analysis = {
      constraints: [
        {
          displayId: "C001",
          id: "CON_001",
          description: "Must validate",
          source_text: "validate",
          normalizedRule: "RULE_ABC",
          evidence: "evidence text",
          relatedFunctions: [{ functionId: "FUN_A", name: "func A" }],
        },
      ],
      entities: [
        {
          id: "ENT_A",
          attributes: [{ name: "a1" }, { name: "a2" }, { name: "a3" }, { name: "a4" }, { name: "a5" }, { name: "a6" }],
        },
      ],
      traceability: { matrix: [] },
    };

    const original = JSON.parse(JSON.stringify(analysis));
    minimizeForPrompt(analysis);

    // Original must be unchanged
    expect(analysis).toEqual(original);
  });

  it("returns empty arrays intact when no data present", () => {
    const analysis = { entities: [], functions: [], constraints: [] };

    const result = minimizeForPrompt(analysis);

    expect(result.entities).toEqual([]);
    expect(result.functions).toEqual([]);
    expect(result.constraints).toEqual([]);
  });

  it("handles missing constraint array", () => {
    const analysis = { entities: [] };

    const result = minimizeForPrompt(analysis);

    expect(result.constraints).toBeUndefined();
    expect(result.entities).toEqual([]);
  });
});
