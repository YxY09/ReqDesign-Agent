import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConstraintExtractor } from "../src/generators/constraintExtractor.js";
import type { ConstraintCandidate } from "../src/shared/constraintCanonicalizer.js";

/**
 * Helper: create a mock LLMClient that returns a given JSON response.
 */
function mockLLM(response: Record<string, unknown>) {
  return {
    generateJson: vi.fn().mockResolvedValue(response),
    generateText: vi.fn(),
  };
}

describe("ConstraintExtractor", () => {
  // ----------------------------------------------------------------
  // 1. Basic extraction: returns ConstraintCandidate[] from LLM output
  // ----------------------------------------------------------------
  it("extracts constraint candidates from requirement text", async () => {
    const llmResponse = {
      content: {
        constraints: [
          {
            descriptionZh: "用户密码必须至少8位",
            canonicalRuleEn: "User password must be at least 8 characters",
            sourceText: "用户密码长度不得少于8个字符",
            type: "security",
            subtype: "password_policy",
            relatedFunctionCandidates: ["用户注册"],
          },
        ],
      },
    };

    const llm = mockLLM(llmResponse);
    const extractor = new ConstraintExtractor(llm as any);

    const candidates = await extractor.extractCandidates(
      "用户密码长度不得少于8个字符",
      [{ id: "E001", canonicalName: "User", aliases: ["用户"] }],
      [],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].description).toBe("用户密码必须至少8位");
    expect(candidates[0].sourceText).toBe("用户密码长度不得少于8个字符");
    expect(candidates[0].canonicalRuleEn).toBe(
      "User password must be at least 8 characters",
    );
    expect(candidates[0].type).toBe("security");
    expect(candidates[0].subtype).toBe("password_policy");
    expect(candidates[0].relatedFunctionCandidates).toEqual(["用户注册"]);
  });

  // ----------------------------------------------------------------
  // 2. Handles LLM returning { constraints: [...] } without content wrapper
  // ----------------------------------------------------------------
  it("handles response without content wrapper", async () => {
    const llmResponse = {
      constraints: [
        {
          descriptionZh: "响应时间不超过3秒",
          canonicalRuleEn: "Response time must not exceed 3 seconds",
          sourceText: "系统响应时间不得超过3秒",
          type: "performance",
          subtype: "response_time",
          relatedFunctionCandidates: [],
        },
      ],
    };

    const llm = mockLLM(llmResponse);
    const extractor = new ConstraintExtractor(llm as any);

    const candidates = await extractor.extractCandidates("需求文本", [], []);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe("performance");
  });

  // ----------------------------------------------------------------
  // 3. Empty result: returns empty array when no constraints found
  // ----------------------------------------------------------------
  it("returns empty array when no constraints found", async () => {
    const llmResponse = { content: { constraints: [] } };
    const llm = mockLLM(llmResponse);
    const extractor = new ConstraintExtractor(llm as any);

    const candidates = await extractor.extractCandidates("无约束的文本", [], []);

    expect(candidates).toEqual([]);
  });

  // ----------------------------------------------------------------
  // 4. Post-processing: filters out items with empty description and sourceText
  // ----------------------------------------------------------------
  it("filters out candidates with empty description and sourceText", async () => {
    const llmResponse = {
      content: {
        constraints: [
          {
            descriptionZh: "有效约束",
            canonicalRuleEn: "Valid constraint",
            sourceText: "有效的源文本",
            type: "functional",
            subtype: "general",
            relatedFunctionCandidates: [],
          },
          {
            descriptionZh: "",
            canonicalRuleEn: "",
            sourceText: "",
            type: "functional",
            subtype: "general",
            relatedFunctionCandidates: [],
          },
          {
            // Missing fields entirely
          },
        ],
      },
    };

    const llm = mockLLM(llmResponse);
    const extractor = new ConstraintExtractor(llm as any);

    const candidates = await extractor.extractCandidates("需求文本", [], []);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].description).toBe("有效约束");
  });

  // ----------------------------------------------------------------
  // 5. Post-processing: fills missing fields with defaults
  // ----------------------------------------------------------------
  it("fills missing fields with defaults", async () => {
    const llmResponse = {
      content: {
        constraints: [
          {
            descriptionZh: "系统必须可用",
            sourceText: "系统可用性要求",
            // canonicalRuleEn, type, subtype, relatedFunctionCandidates all missing
          },
        ],
      },
    };

    const llm = mockLLM(llmResponse);
    const extractor = new ConstraintExtractor(llm as any);

    const candidates = await extractor.extractCandidates("需求文本", [], []);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].canonicalRuleEn).toBe("系统必须可用");
    expect(candidates[0].type).toBe("functional");
    expect(candidates[0].subtype).toBe("general");
    expect(candidates[0].relatedFunctionCandidates).toEqual([]);
  });

  // ----------------------------------------------------------------
  // 6. Multiple constraints extraction
  // ----------------------------------------------------------------
  it("extracts multiple constraints", async () => {
    const llmResponse = {
      content: {
        constraints: [
          {
            descriptionZh: "密码必须加密存储",
            canonicalRuleEn: "Passwords must be encrypted at rest",
            sourceText: "密码必须以加密形式存储",
            type: "security",
            subtype: "encryption",
            relatedFunctionCandidates: ["用户管理"],
          },
          {
            descriptionZh: "搜索响应不超过8秒",
            canonicalRuleEn: "Search response time must not exceed 8 seconds",
            sourceText: "搜索响应时间不超过8秒",
            type: "performance",
            subtype: "response_time",
            relatedFunctionCandidates: ["搜索"],
          },
        ],
      },
    };

    const llm = mockLLM(llmResponse);
    const extractor = new ConstraintExtractor(llm as any);

    const candidates = await extractor.extractCandidates("需求文档", [], []);

    expect(candidates).toHaveLength(2);
    expect(candidates[0].type).toBe("security");
    expect(candidates[1].type).toBe("performance");
  });

  // ----------------------------------------------------------------
  // 7. Passes entity and function registries in prompt
  // ----------------------------------------------------------------
  it("calls LLM with prompt containing entity and function registries", async () => {
    const llmResponse = { content: { constraints: [] } };
    const llm = mockLLM(llmResponse);
    const extractor = new ConstraintExtractor(llm as any);

    const entities = [
      { id: "E001", canonicalName: "User", aliases: ["用户"] },
    ];
    const functions = [
      { id: "F001", name: "SearchCase", aliases: ["搜索案件"] },
    ];

    await extractor.extractCandidates("需求文档", entities, functions);

    expect(llm.generateJson).toHaveBeenCalledOnce();
    const callArgs = llm.generateJson.mock.calls[0];
    const prompt = callArgs[0] as string;

    // Prompt should contain entity and function info
    expect(prompt).toContain("User");
    expect(prompt).toContain("SearchCase");
    expect(prompt).toContain("需求文档");
  });

  // ----------------------------------------------------------------
  // 8. Handles invalid JSON response gracefully
  // ----------------------------------------------------------------
  it("returns empty array when LLM returns non-array constraints", async () => {
    const llmResponse = {
      content: {
        constraints: "not an array",
      },
    };
    const llm = mockLLM(llmResponse);
    const extractor = new ConstraintExtractor(llm as any);

    const candidates = await extractor.extractCandidates("需求文档", [], []);

    expect(candidates).toEqual([]);
  });

  // ----------------------------------------------------------------
  // 9. Sanitize placeholders in requirementText
  // ----------------------------------------------------------------
  it("strips {entity_registry} from requirementText before building prompt", async () => {
    const llmResponse = { content: { constraints: [] } };
    const llm = mockLLM(llmResponse);
    const extractor = new ConstraintExtractor(llm as any);

    await extractor.extractCandidates(
      "用户 {entity_registry} 数据",
      [],
      [],
    );

    expect(llm.generateJson).toHaveBeenCalledOnce();
    const prompt = llm.generateJson.mock.calls[0][0] as string;
    expect(prompt).not.toContain("{entity_registry}");
  });

  // ----------------------------------------------------------------
  // 10. Warns when promptTemplate is empty
  // ----------------------------------------------------------------
  it("warns when promptTemplate is empty", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm = mockLLM({});
    const extractor = new ConstraintExtractor(llm as any);
    // Simulate empty template by overriding private field
    (extractor as any).promptTemplate = "";

    const result = await extractor.extractCandidates("需求", [], []);

    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("constraint_extraction"),
    );

    warnSpy.mockRestore();
  });

  // ----------------------------------------------------------------
  // 11. generate() delegates to extractCandidates
  // ----------------------------------------------------------------
  it("generate() delegates to extractCandidates", async () => {
    const llmResponse = {
      content: {
        constraints: [
          {
            descriptionZh: "测试约束",
            sourceText: "原文",
            type: "functional",
            subtype: "general",
            relatedFunctionCandidates: [],
          },
        ],
      },
    };
    const llm = mockLLM(llmResponse);
    const extractor = new ConstraintExtractor(llm as any);

    const result = await extractor.generate({
      requirementText: "需求文档",
      entityRegistry: [],
      functionRegistry: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("测试约束");
  });
});
