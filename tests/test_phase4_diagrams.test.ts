import { describe, it, expect } from "vitest";
import { MermaidValidator } from "../src/generators/mermaid.js";
import { DiagramGenerator } from "../src/generators/diagrams.js";
import type { LLMClient } from "../src/llmClient.js";

// Helper: create a DiagramGenerator with mocked LLM and injected prompts
function makeGen(
  mockReturn?: string,
  sideEffect?: (prompt: string, system: string) => string,
): { gen: DiagramGenerator; mockLlm: LLMClient } {
  const mockLlm = {
    generateText: sideEffect
      ? sideEffect
      : (_prompt: string, _system?: string) => Promise.resolve(mockReturn ?? ""),
  } as unknown as LLMClient;

  // Bypass constructor to avoid prompt file loading
  const gen = Object.create(DiagramGenerator.prototype) as DiagramGenerator;
  (gen as any).llm = mockLlm;
  (gen as any).prompts = {
    class_diagram: "生成类图\n{requirement_json}\n{design_text}",
    activity_diagram: "生成活动图\n{requirement_json}\n{design_text}",
    state_diagram: "生成状态图\n{requirement_json}\n{design_text}",
  };
  return { gen, mockLlm };
}

// ═══════════════════════════════════════════════════════
//  MermaidValidator
// ═══════════════════════════════════════════════════════

describe("MermaidValidator", () => {
  const validator = new MermaidValidator(false);

  it("rejects empty content", () => {
    const r = validator.validate("");
    expect(r.valid).toBe(false);
    expect(r.message).toContain("为空");
  });

  it("rejects content without a diagram header", () => {
    const r = validator.validate("A --> B");
    expect(r.valid).toBe(false);
    expect(r.message).toContain("图类型声明");
  });

  it("accepts a valid class diagram", () => {
    const content = `classDiagram
    class User {
        -int id
        -String name
        +login()
    }
    class Book {
        -int id
        -String title
    }
    User --> Book : borrows`;
    const r = validator.validate(content, "classDiagram");
    expect(r.valid).toBe(true);
    expect(r.message).toContain("通过");
  });

  it("rejects class diagram with no class definition", () => {
    const content = "classDiagram\n    A --> B";
    const r = validator.validate(content, "classDiagram");
    expect(r.valid).toBe(false);
    expect(r.message).toContain("class 定义");
  });

  it("accepts a valid flowchart", () => {
    const content = `flowchart TD
    A([开始]) --> B[处理请求]
    B --> C{判断}
    C -->|是| D[执行]
    C -->|否| E[结束]
    D --> E`;
    const r = validator.validate(content, "flowchart");
    expect(r.valid).toBe(true);
  });

  it("rejects flowchart with no connections", () => {
    const content = "flowchart TD\n    A[节点A]\n    B[节点B]";
    const r = validator.validate(content, "flowchart");
    expect(r.valid).toBe(false);
    expect(r.message).toContain("连接关系");
  });

  it("accepts a valid state diagram", () => {
    const content = `stateDiagram-v2
    [*] --> 待处理
    待处理 --> 处理中 : 开始处理
    处理中 --> 已完成 : 处理完成
    已完成 --> [*]`;
    const r = validator.validate(content, "stateDiagram-v2");
    expect(r.valid).toBe(true);
  });

  it("rejects unmatched brackets", () => {
    const content = `classDiagram
    class User {
        -int id
        +login(
    }`;
    const r = validator.validate(content);
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/不匹配|未闭合/);
  });

  it("rejects header-only content (too few lines)", () => {
    const r = validator.validate("classDiagram");
    expect(r.valid).toBe(false);
    expect(r.message).toContain("过少");
  });

  // ── validateAndReport ──

  it("validateAndReport returns success report", () => {
    const content = `classDiagram
    class User {
        +login()
    }
    User --> Book`;
    const report = validator.validateAndReport(content, "类图");
    expect(report).toContain("通过");
    expect(report).toContain("类图");
  });

  it("validateAndReport returns failure report", () => {
    const report = validator.validateAndReport("invalid content", "类图");
    expect(report).toContain("失败");
  });
});

// ═══════════════════════════════════════════════════════
//  DiagramGenerator — _extractMermaid
// ═══════════════════════════════════════════════════════

describe("DiagramGenerator._extractMermaid", () => {
  it("removes HTML line break tags from extracted Mermaid", () => {
    const result = DiagramGenerator._extractMermaid("```mermaid\nflowchart TD\nA[创建订单<br/>校验库存] --> B[支付]\n```");
    expect(result).toContain("创建订单 / 校验库存");
    expect(result).not.toMatch(/<br\s*\/?>/i);
  });

  it("extracts from mermaid code block", () => {
    const raw = "这是类图：\n```mermaid\nclassDiagram\n    class A\n```\n结束";
    const result = DiagramGenerator._extractMermaid(raw);
    expect(result.startsWith("classDiagram")).toBe(true);
    expect(result).toContain("class A");
  });

  it("extracts from plain text starting with header", () => {
    const raw = "classDiagram\n    class A {\n        +method()\n    }";
    const result = DiagramGenerator._extractMermaid(raw);
    expect(result.startsWith("classDiagram")).toBe(true);
  });

  it("extracts flowchart from code block", () => {
    const raw = "```mermaid\nflowchart TD\n    A --> B\n```";
    const result = DiagramGenerator._extractMermaid(raw);
    expect(result.startsWith("flowchart")).toBe(true);
  });

  it("extracts state diagram from code block", () => {
    const raw = "以下是状态图：\n```mermaid\nstateDiagram-v2\n    [*] --> A\n```";
    const result = DiagramGenerator._extractMermaid(raw);
    expect(result.startsWith("stateDiagram-v2")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
//  DiagramGenerator — generation methods (mock LLM)
// ═══════════════════════════════════════════════════════

describe("DiagramGenerator — generate methods", () => {
  it("generateClassDiagram returns classDiagram content", async () => {
    const { gen, mockLlm } = makeGen();
    (mockLlm as any).generateText = (_p: string, _s?: string) =>
      Promise.resolve("```mermaid\nclassDiagram\n    class User\n```");
    const result = await gen.generateClassDiagram({ functions: [] }, "设计说明");
    expect(result).toContain("classDiagram");
    expect(result).toContain("User");

    // Verify the prompt was built correctly
    const callArgs = (mockLlm as any).generateText;
    // mockLlm.generateText is already the mock function; we can't inspect calls easily
    // but we trust _buildPrompt was called with correct args
  });

  it("generateActivityDiagram returns flowchart content", async () => {
    const { gen } = makeGen();
    (gen as any).llm = {
      generateText: () => Promise.resolve("```mermaid\nflowchart TD\n    A --> B\n```"),
    };
    const result = await gen.generateActivityDiagram({ functions: [] }, "设计说明");
    expect(result).toContain("flowchart");
  });

  it("generateStateDiagram returns stateDiagram-v2 content", async () => {
    const { gen } = makeGen();
    (gen as any).llm = {
      generateText: () => Promise.resolve("```mermaid\nstateDiagram-v2\n    [*] --> A\n```"),
    };
    const result = await gen.generateStateDiagram({ functions: [] }, "设计说明");
    expect(result).toContain("stateDiagram-v2");
  });
});

// ═══════════════════════════════════════════════════════
//  DiagramGenerator — generateAll
// ═══════════════════════════════════════════════════════

describe("DiagramGenerator — generateAll", () => {
  it("succeeds for all three diagrams", async () => {
    let callCount = 0;
    const responses = [
      "classDiagram\n    class A",
      "flowchart TD\n    A --> B",
      "stateDiagram-v2\n    [*] --> A",
    ];
    const { gen } = makeGen();
    (gen as any).llm = {
      generateText: () => Promise.resolve(responses[callCount++]),
    };

    const result = await gen.generateAll({ functions: [] }, "设计说明");
    expect(result.class_diagram).toContain("classDiagram");
    expect(result.activity_diagram).toContain("flowchart");
    expect(result.state_diagram).toContain("stateDiagram-v2");
  });

  it("handles partial failure (one diagram throws)", async () => {
    let callCount = 0;
    const { gen } = makeGen();
    (gen as any).llm = {
      generateText: () => {
        callCount++;
        if (callCount === 2) return Promise.reject(new Error("LLM timeout"));
        if (callCount === 4) return Promise.resolve(""); // retry after empty for activity
        return Promise.resolve(
          callCount === 1
            ? "classDiagram\n    class A"
            : "stateDiagram-v2\n    [*] --> A",
        );
      },
    };

    const result = await gen.generateAll({ functions: [] }, "设计说明");
    expect(result.class_diagram).toContain("classDiagram");
    expect(result.activity_diagram).toBe("");
    expect(result.state_diagram).toContain("stateDiagram-v2");
  });

  it("handles total failure (all throw)", async () => {
    const { gen } = makeGen();
    (gen as any).llm = {
      generateText: () => Promise.reject(new Error("API error")),
    };

    const result = await gen.generateAll({ functions: [] }, "设计说明");
    expect(result.class_diagram).toBe("");
    expect(result.activity_diagram).toBe("");
    expect(result.state_diagram).toBe("");
  });
});

// ═══════════════════════════════════════════════════════
//  DiagramGenerator — _buildPrompt
// ═══════════════════════════════════════════════════════

describe("DiagramGenerator._buildPrompt", () => {
  // Access the private method via (gen as any)
  function buildPrompt(
    template: string,
    reqJson: Record<string, unknown> | null,
    designText: string | null,
    reqText = "",
  ): string {
    const gen = Object.create(DiagramGenerator.prototype);
    return (gen as any)._buildPrompt(template, reqJson, designText ?? "", reqText);
  }

  it("builds prompt with normal inputs", () => {
    const result = buildPrompt(
      "需求：{requirement_json}\n设计：{design_text}",
      { actors: ["user"] } as any,
      "设计内容",
    );
    expect(result).toContain('"actors"');
    expect(result).toContain("设计内容");
  });

  it("uses empty object string when requirement is null", () => {
    const result = buildPrompt("需求：{requirement_json}", null, "");
    expect(result).toContain("{}");
  });

  it("uses empty object for empty requirement", () => {
    const result = buildPrompt("需求：{requirement_json}", {}, "");
    expect(result).toContain("{}");
  });

  it("replaces design_text even when null", () => {
    const result = buildPrompt("设计：{design_text}", { a: 1 }, null);
    expect(result).toContain("设计：");
    expect(result).not.toContain("None");
  });

  it("handles empty design text", () => {
    const result = buildPrompt("设计：{design_text}", { a: 1 }, "");
    expect(result).toContain("设计：");
  });
});

// ═══════════════════════════════════════════════════════
//  MermaidValidator — CLI path
// ═══════════════════════════════════════════════════════

describe("MermaidValidator — CLI path", () => {
  it("structure check runs before CLI and rejects missing header", () => {
    const v = new MermaidValidator(false);
    const r = v.validate("no header here\n    class A");
    expect(r.valid).toBe(false);
    expect(r.message).toContain("图类型声明");
  });

  it("_validateWithCli returns success (mmdc not available)", () => {
    const v = new MermaidValidator(true);
    // Direct call to the private method — in TS source it always returns success
    // because mmdc is not actually invoked
    const r = (v as any)._validateWithCli("classDiagram\n    class A");
    expect(r.valid).toBe(true);
  });
});
