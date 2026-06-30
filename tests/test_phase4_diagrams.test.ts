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
  const validator = new MermaidValidator();

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

  // ---------------------------------------------------------------------
  // Regression (defect 1): relationship endpoint semantics.
  // The old regex `/^(\w+)\s*([<|].*[>|])\s*(\w+)\s*:/` only matched
  // inheritance arrows and never matched `-->` associations, so dangling
  // association classes (e.g. `"1" --> "*"`) slipped through.
  // ---------------------------------------------------------------------

  it("flags association endpoints (`\"1\" --> \"*\"`) referenced but never defined", () => {
    // Hospital-style: Patient/Doctor defined, Insurance/PrescriptionItem only referenced.
    const content = `classDiagram
    class Patient {
        -String id
    }
    class Doctor {
        -String id
    }
    Patient "1" --> "*" Doctor : visits
    Patient "1" --> "*" Insurance : uses
    Doctor "1" --> "*" PrescriptionItem : writes`;
    const r = validator.validate(content, "classDiagram");
    expect(r.valid).toBe(false);
    expect(r.message).toContain("未定义的类");
    expect(r.message).toContain("Insurance");
    expect(r.message).toContain("PrescriptionItem");
  });

  it("accepts association lines when both endpoints are defined (no false positive)", () => {
    const content = `classDiagram
    class Patient {
        -String id
    }
    class Doctor {
        -String id
    }
    Patient "1" --> "*" Doctor : visits`;
    const r = validator.validate(content, "classDiagram");
    expect(r.valid).toBe(true);
  });

  it("correctly handles mermaid `\"*\"` cardinality (planner regex `\"\\d*\"` would miss it)", () => {
    // The planner's original `"\d*"` pattern matches "1" but the broadened
    // design.ts-style pattern must still capture "*" cardinality endpoints.
    const content = `classDiagram
    class Order {
        -int id
    }
    Order "1" --> "*" OrderItem : contains`;
    const r = validator.validate(content, "classDiagram");
    // OrderItem is undefined → must be flagged (proves "*" endpoint was captured).
    expect(r.valid).toBe(false);
    expect(r.message).toContain("OrderItem");
  });

  it("flags dangling inheritance endpoints (<|-- and --|>)", () => {
    const content = `classDiagram
    class Dog {
        -String name
    }
    Dog --|> Animal
    Cat <|-- Feline`;
    const r = validator.validate(content, "classDiagram");
    expect(r.valid).toBe(false);
    expect(r.message).toContain("Animal");
  });

  // Regression (Warning 1): leftward association arrow `A <-- B`. The
  // shared relation regex must treat `<--` (the `<?--` alternative, optional
  // `<`) as a relationship line so its endpoints are validated. An earlier
  // revision used the escaped form `<\?--` (a literal `?`), which failed to
  // match `A <-- B`, leaving endpoint B unchecked and falsely reporting VALID.
  it("flags dangling endpoint on leftward association arrow (A <-- B)", () => {
    const content = `classDiagram
    class A {
        -int id
    }
    A <-- B`;
    const r = validator.validate(content, "classDiagram");
    // B is referenced but never defined → must be flagged INVALID.
    expect(r.valid).toBe(false);
    expect(r.message).toContain("未定义的类");
    expect(r.message).toContain("B");
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
    class Book {
        +title()
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
//  FIX B — _enforceConceptFidelity (deterministic class-diagram fidelity)
// ═══════════════════════════════════════════════════════

describe("DiagramGenerator._enforceConceptFidelity", () => {
  it("injects missing entity / line_item class blocks AND enumeration blocks", () => {
    const mermaid = [
      "classDiagram",
      "    class Existing {",
      "        -Long id",
      "    }",
      "    Existing --> \"*\" Order",
    ].join("\n");
    const domainModel = {
      concepts: [
        { id: "D001", name: "Existing", kind: "entity" },
        { id: "D002", name: "Order", kind: "entity" },
        { id: "D003", name: "StatusEnum", kind: "enumeration", literals: ["A", "B"] },
        { id: "D004", name: "LineItem", kind: "line_item", parentEntity: "Order" },
      ],
      generalizations: [],
      associations: [],
    };
    const result = DiagramGenerator._enforceConceptFidelity(mermaid, domainModel);
    // Existing must NOT be duplicated.
    const existingCount = (result.match(/class\s+Existing\s*\{/g) ?? []).length;
    expect(existingCount).toBe(1);
    // Missing entity + line_item must be injected as class blocks.
    expect(result).toContain("class Order {");
    expect(result).toContain("class LineItem {");
    // line_item.parentEntity must also produce a relationship line.
    expect(result).toContain('Order "1" --> "*" LineItem');
    // Owner decision: enumerations ARE rendered as <<enumeration>> class blocks
    // listing their literal values (and may also appear as attribute types).
    expect(result).toContain("class StatusEnum {");
    expect(result).toContain("<<enumeration>>");
    expect(result).toContain("        A");
    expect(result).toContain("        B");
  });

  it("injects missing generalization lines (<|--) and skips existing ones", () => {
    const mermaid = [
      "classDiagram",
      "    class BaseEntity {",
      "    }",
      "    class RoleA {",
      "    }",
      "    class RoleB {",
      "    }",
      "    BaseEntity <|-- RoleA",
    ].join("\n");
    const domainModel = {
      concepts: [
        { id: "D001", name: "BaseEntity", kind: "entity", abstract: true },
        { id: "D002", name: "RoleA", kind: "entity" },
        { id: "D003", name: "RoleB", kind: "entity" },
      ],
      generalizations: [
        { parent: "BaseEntity", children: ["RoleA", "RoleB"] },
      ],
      associations: [],
    };
    const result = DiagramGenerator._enforceConceptFidelity(mermaid, domainModel);
    // Existing generalization not duplicated.
    const baseRoleA = (result.match(/BaseEntity\s+<\|--\s+RoleA/g) ?? []).length;
    expect(baseRoleA).toBe(1);
    // Missing one injected.
    expect(result).toContain("BaseEntity <|-- RoleB");
  });

  it("injects missing association lines with multiplicity", () => {
    const mermaid = [
      "classDiagram",
      "    class ParentAggregate {",
      "    }",
      "    class DetailLine {",
      "    }",
    ].join("\n");
    const domainModel = {
      concepts: [
        { id: "D001", name: "ParentAggregate", kind: "entity" },
        { id: "D002", name: "DetailLine", kind: "line_item" },
      ],
      generalizations: [],
      associations: [
        { source: "ParentAggregate", target: "DetailLine", sourceMultiplicity: "1", targetMultiplicity: "*", label: "contains" },
      ],
    };
    const result = DiagramGenerator._enforceConceptFidelity(mermaid, domainModel);
    expect(result).toContain('ParentAggregate "1" --> "*" : contains');
  });

  it("does not duplicate an association that already exists (directional)", () => {
    const mermaid = [
      "classDiagram",
      "    class ParentAggregate {",
      "    }",
      "    class DetailLine {",
      "    }",
      '    ParentAggregate "1" --> "*" DetailLine : contains',
    ].join("\n");
    const domainModel = {
      concepts: [],
      generalizations: [],
      associations: [
        { source: "ParentAggregate", target: "DetailLine", sourceMultiplicity: "1", targetMultiplicity: "*", label: "contains" },
      ],
    };
    const result = DiagramGenerator._enforceConceptFidelity(mermaid, domainModel);
    const count = (result.match(/ParentAggregate\s+"1"\s+-->\s+"\*"\s+DetailLine/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("is a no-op when domain model is empty", () => {
    const mermaid = "classDiagram\n    class A {\n    }\n    A --> B";
    expect(DiagramGenerator._enforceConceptFidelity(mermaid, {})).toBe(mermaid);
    expect(DiagramGenerator._enforceConceptFidelity(mermaid, { concepts: [] })).toBe(mermaid);
  });

  it("returns non-classDiagram input untouched", () => {
    const mermaid = "flowchart TD\n    A --> B";
    expect(DiagramGenerator._enforceConceptFidelity(mermaid, { concepts: [{ name: "X", kind: "entity" }] })).toBe(mermaid);
  });

  // Regression (FIX 1): a stripped/empty class diagram becomes a faithful
  // superset of the domain model — every entity concept -> class block, every
  // generalization -> <| -- line, every association -> relationship line, and
  // every enumeration concept -> a <<enumeration>> class block.
  it("rebuilds a faithful superset from a stripped diagram (entities + generalization + association + enum block)", () => {
    const stripped = "classDiagram\n";
    const domainModel = {
      concepts: [
        { id: "D001", name: "Account", kind: "entity" },
        { id: "D002", name: "Savings", kind: "entity" },
        { id: "D003", name: "Transaction", kind: "association", connects: ["Account", "Savings"] },
        { id: "D004", name: "TxStatus", kind: "enumeration", literals: ["Open", "Closed"] },
      ],
      generalizations: [
        { parent: "Account", children: ["Savings"] },
      ],
      associations: [
        { source: "Account", target: "Savings", sourceMultiplicity: "1", targetMultiplicity: "*", label: "owns" },
      ],
    };
    const result = DiagramGenerator._enforceConceptFidelity(stripped, domainModel);
    // Every non-enum entity concept becomes a class block.
    expect(result).toContain("class Account {");
    expect(result).toContain("class Savings {");
    expect(result).toContain("class Transaction {");
    // Generalization renders as a <| -- line.
    expect(result).toContain("Account <|-- Savings");
    // Association renders as a relationship line.
    expect(result).toContain('Account "1" --> "*" : owns');
    // Association concept endpoints (connects) render as a relationship line.
    expect(result).toContain("Account --> Savings");
    // Enumeration concept becomes a <<enumeration>> class block with literals.
    expect(result).toContain("class TxStatus {");
    expect(result).toContain("<<enumeration>>");
    expect(result).toContain("        Open");
    expect(result).toContain("        Closed");
  });

  // Regression (FIX ①, abstract entity fidelity): an abstract domain entity
  // must survive into the class diagram as a `class X { <<abstract>> ... }`
  // block (concept-name copied verbatim), and its generalization renders as a
  // `<|--` line. This guards against abstract entities being dropped/renamed
  // at the rendering layer.
  it("injects an abstract entity as a <<abstract>> class block + generalization line (concept name verbatim)", () => {
    const stripped = "classDiagram\n";
    const domainModel = {
      concepts: [
        { id: "D001", name: "AbstractBase", kind: "entity", abstract: true,
          attributes: [{ name: "label", type: "String" }] },
        { id: "D002", name: "DerivedRole", kind: "entity" },
      ],
      generalizations: [
        { parent: "AbstractBase", children: ["DerivedRole"] },
      ],
      associations: [],
    };
    const result = DiagramGenerator._enforceConceptFidelity(stripped, domainModel);
    // Abstract entity injected with its verbatim concept name + abstract marker.
    expect(result).toContain("class AbstractBase {");
    expect(result).toContain("<<abstract>>");
    // Concrete subclass injected as a class block.
    expect(result).toContain("class DerivedRole {");
    // Generalization rendered as a <|-- line.
    expect(result).toContain("AbstractBase <|-- DerivedRole");
  });

  // Regression (FIX ②, enum-block injection): an enumeration concept must be
  // injected as a `class X { <<enumeration>> <literals> }` block when missing
  // from the diagram (enumerations are first-class renderable concepts).
  it("injects a missing enumeration concept as a <<enumeration>> class block with literals", () => {
    const stripped = "classDiagram\n    class Holder {\n    }\n";
    const domainModel = {
      concepts: [
        { id: "D001", name: "Holder", kind: "entity" },
        { id: "D002", name: "KindEnum", kind: "enumeration", literals: ["Alpha", "Beta", "Gamma"] },
      ],
      generalizations: [],
      associations: [],
    };
    const result = DiagramGenerator._enforceConceptFidelity(stripped, domainModel);
    // Enumeration injected as a <<enumeration>> class block.
    expect(result).toContain("class KindEnum {");
    expect(result).toContain("<<enumeration>>");
    // Each literal value is listed inside the block.
    expect(result).toContain("        Alpha");
    expect(result).toContain("        Beta");
    expect(result).toContain("        Gamma");
    // Existing entity must not be duplicated.
    const holderCount = (result.match(/class\s+Holder\s*\{/g) ?? []).length;
    expect(holderCount).toBe(1);
  });

  // Regression (FIX: repair-loop prevention): when a repair LLM flattened a
  // generalization hierarchy into a single entity carrying a role/tag
  // discriminator, the fidelity step injects the restored `Parent <|-- Child`
  // hierarchy AND must remove the leftover flattened entity — otherwise BOTH
  // coexist and re-trigger the evaluator's extra-class / naming-inconsistency
  // complaint, looping repair. Detection is GENERAL (synthetic names;
  // role/kind/type discriminator + parent-attribute subset), not specialized
  // to any domain entity.
  it("removes a leftover flattened role-tag entity superseded by an injected generalization", () => {
    // The repair LLM collapsed BaseUser -> [AdminUser, CustomerUser] into a
    // single `FlatUser` carrying a `role` discriminator (BaseUser absent).
    const mermaid = [
      "classDiagram",
      "    class FlatUser {",
      "        -String email",
      "        -String role",
      "    }",
    ].join("\n");
    const domainModel = {
      concepts: [
        { name: "BaseUser", kind: "entity", abstract: true, attributes: [{ name: "email", type: "String" }] },
        { name: "AdminUser", kind: "entity" },
        { name: "CustomerUser", kind: "entity" },
      ],
      generalizations: [{ parent: "BaseUser", children: ["AdminUser", "CustomerUser"] }],
      associations: [],
    };
    const result = DiagramGenerator._enforceConceptFidelity(mermaid, domainModel);
    // The restored hierarchy MUST be present.
    expect(result).toContain("class BaseUser {");
    expect(result).toContain("BaseUser <|-- AdminUser");
    expect(result).toContain("BaseUser <|-- CustomerUser");
    // The leftover flattened role-tag entity MUST be gone (no duplicate).
    expect(result).not.toContain("FlatUser");
  });

  it("also drops relationship lines that referenced a removed flattened entity (no dangling refs)", () => {
    const mermaid = [
      "classDiagram",
      "    class FlatUser {",
      "        -String email",
      "        -String role",
      "    }",
      "    class AuditTrail {",
      "        -String message",
      "    }",
      "    FlatUser --> AuditTrail",
    ].join("\n");
    const domainModel = {
      concepts: [
        { name: "BaseUser", kind: "entity", abstract: true, attributes: [{ name: "email", type: "String" }] },
        { name: "AdminUser", kind: "entity" },
      ],
      generalizations: [{ parent: "BaseUser", children: ["AdminUser"] }],
      associations: [],
    };
    const result = DiagramGenerator._enforceConceptFidelity(mermaid, domainModel);
    expect(result).not.toContain("FlatUser");
    // The dangling relationship line referencing FlatUser is gone too.
    expect(result).not.toMatch(/FlatUser\s+--/);
    // An unrelated legitimate class survives untouched.
    expect(result).toContain("class AuditTrail {");
  });

  it("does NOT remove a legitimate class that merely has a 'type' field (subset check guards false positives)", () => {
    // `Order` carries a `type` field but its `amount` attribute is NOT a
    // subset of the generalization parent's attributes, so it must be kept.
    const mermaid = [
      "classDiagram",
      "    class Order {",
      "        -Double amount",
      "        -String type",
      "    }",
    ].join("\n");
    const domainModel = {
      concepts: [
        { name: "BaseUser", kind: "entity", abstract: true, attributes: [{ name: "email", type: "String" }] },
        { name: "AdminUser", kind: "entity" },
      ],
      generalizations: [{ parent: "BaseUser", children: ["AdminUser"] }],
      associations: [],
    };
    const result = DiagramGenerator._enforceConceptFidelity(mermaid, domainModel);
    expect(result).toContain("class Order {");
  });

  it("does NOT prune when the hierarchy was not flattened (parent already present)", () => {
    const mermaid = [
      "classDiagram",
      "    class BaseUser {",
      "        -String email",
      "    }",
      "    class AdminUser {",
      "    }",
      "    class FlatThing {",
      "        -String email",
        "        -String role",
      "    }",
      "    BaseUser <|-- AdminUser",
    ].join("\n");
    const domainModel = {
      concepts: [
        { name: "BaseUser", kind: "entity", attributes: [{ name: "email", type: "String" }] },
        { name: "AdminUser", kind: "entity" },
      ],
      generalizations: [{ parent: "BaseUser", children: ["AdminUser"] }],
      associations: [],
    };
    const result = DiagramGenerator._enforceConceptFidelity(mermaid, domainModel);
    // Parent was present originally -> hierarchy not flattened -> no pruning.
    expect(result).toContain("class FlatThing {");
  });

  // ═══════════════════════════════════════════════════════
  //  FIX D — dual-parent generalization prevention (PRIMARY source fix)
  //  The domain model is the single source of truth for generalization.
  //  When the LLM drew a child under a DIFFERENT (alternate) parent, the
  //  injector must MIGRATE the child to the authoritative domain-model
  //  parent (dropping the alternate-parent line) instead of injecting a
  //  second parent. Synthetic names — no specialization.
  // ═══════════════════════════════════════════════════════

  // (i) Alternate parent present → migrate (no dual parent).
  it("migrates a child's alternate parent to the domain-model parent instead of creating a dual parent", () => {
    // Domain model: BaseUser <|-- AdminUser, BaseUser <|-- CustomerUser.
    // LLM (driven by an evaluator rename) drew AlternateAccount as parent.
    const mermaid = [
      "classDiagram",
      "    class BaseUser {",
      "        -String email",
      "    }",
      "    class AdminUser {",
      "    }",
      "    class CustomerUser {",
      "    }",
      "    AlternateAccount <|-- AdminUser",
      "    AlternateAccount <|-- CustomerUser",
    ].join("\n");
    const domainModel = {
      concepts: [
        { name: "BaseUser", kind: "entity", abstract: true, attributes: [{ name: "email", type: "String" }] },
        { name: "AdminUser", kind: "entity" },
        { name: "CustomerUser", kind: "entity" },
      ],
      generalizations: [{ parent: "BaseUser", children: ["AdminUser", "CustomerUser"] }],
      associations: [],
    };
    const result = DiagramGenerator._enforceConceptFidelity(mermaid, domainModel);
    // Each child ends up with EXACTLY ONE parent — the domain-model parent.
    const adminParents = (result.match(/\w+\s+<\|--\s+AdminUser/g) ?? []).length;
    const customerParents = (result.match(/\w+\s+<\|--\s+CustomerUser/g) ?? []).length;
    expect(adminParents).toBe(1);
    expect(customerParents).toBe(1);
    // The authoritative domain parent line is present.
    expect(result).toContain("BaseUser <|-- AdminUser");
    expect(result).toContain("BaseUser <|-- CustomerUser");
    // The alternate-parent lines were migrated away (removed).
    expect(result).not.toMatch(/AlternateAccount\s+<\|––/);
    // The authoritative BaseUser class block is untouched (never deleted).
    expect(result).toContain("class BaseUser {");
  });

  // (i.b) Same migration for the `Child --|> Parent` arrow direction.
  it("migrates alternate parent expressed with the --|> arrow direction", () => {
    const mermaid = [
      "classDiagram",
      "    class BaseUser {",
      "    }",
      "    class AdminUser {",
      "    }",
      "    AdminUser --|> AlternateAccount",
    ].join("\n");
    const domainModel = {
      concepts: [
        { name: "BaseUser", kind: "entity", abstract: true },
        { name: "AdminUser", kind: "entity" },
      ],
      generalizations: [{ parent: "BaseUser", children: ["AdminUser"] }],
      associations: [],
    };
    const result = DiagramGenerator._enforceConceptFidelity(mermaid, domainModel);
    const adminParents = (result.match(/\w+\s+<\|--\s+AdminUser/g) ?? []).length;
    expect(adminParents).toBe(1);
    expect(result).toContain("BaseUser <|-- AdminUser");
    expect(result).not.toMatch(/AlternateAccount/);
  });

  // (ii) Clean diagram (child has no parent yet) → injects normally.
  it("injects the domain parent normally when the child has no parent yet (no regression)", () => {
    const mermaid = [
      "classDiagram",
      "    class BaseUser {",
      "    }",
      "    class AdminUser {",
      "    }",
      "    class CustomerUser {",
      "    }",
    ].join("\n");
    const domainModel = {
      concepts: [
        { name: "BaseUser", kind: "entity", abstract: true },
        { name: "AdminUser", kind: "entity" },
        { name: "CustomerUser", kind: "entity" },
      ],
      generalizations: [{ parent: "BaseUser", children: ["AdminUser", "CustomerUser"] }],
      associations: [],
    };
    const result = DiagramGenerator._enforceConceptFidelity(mermaid, domainModel);
    expect(result).toContain("BaseUser <|-- AdminUser");
    expect(result).toContain("BaseUser <|-- CustomerUser");
    const adminParents = (result.match(/\w+\s+<\|--\s+AdminUser/g) ?? []).length;
    expect(adminParents).toBe(1);
  });

  // (iii) Child already parented to the intended parent → idempotent no-op.
  it("is a no-op when the child is already parented to the intended domain parent (idempotent)", () => {
    const mermaid = [
      "classDiagram",
      "    class BaseUser {",
      "    }",
      "    class AdminUser {",
      "    }",
      "    BaseUser <|-- AdminUser",
    ].join("\n");
    const domainModel = {
      concepts: [
        { name: "BaseUser", kind: "entity", abstract: true },
        { name: "AdminUser", kind: "entity" },
      ],
      generalizations: [{ parent: "BaseUser", children: ["AdminUser"] }],
      associations: [],
    };
    const result = DiagramGenerator._enforceConceptFidelity(mermaid, domainModel);
    const adminParents = (result.match(/\w+\s+<\|--\s+AdminUser/g) ?? []).length;
    expect(adminParents).toBe(1);
    expect(result).toContain("BaseUser <|-- AdminUser");
  });
});

// ═══════════════════════════════════════════════════════
//  FIX C — state/activity diagrams consume domain_model
// ═══════════════════════════════════════════════════════

describe("DiagramGenerator — domain_model_json consumption (FIX C)", () => {
  it("_buildPrompt substitutes {domain_model_json} when provided", () => {
    const gen = Object.create(DiagramGenerator.prototype);
    const template = "领域模型：{domain_model_json}\n需求：{requirement_json}\n设计：{design_text}";
    const domainModel = { concepts: [{ name: "SpecialConcept", kind: "entity" }] };
    const result = (gen as any)._buildPrompt(
      template, { a: 1 }, "design", "", "state_diagram", undefined, domainModel,
    );
    expect(result).toContain("SpecialConcept");
    expect(result).not.toContain("{domain_model_json}");
  });

  it("_buildPrompt substitutes {domain_model_json} with {} when absent", () => {
    const gen = Object.create(DiagramGenerator.prototype);
    const template = "领域模型：{domain_model_json}";
    const result = (gen as any)._buildPrompt(
      template, { a: 1 }, "", "", "state_diagram", undefined, null,
    );
    expect(result).toContain("领域模型：{}");
    expect(result).not.toContain("{domain_model_json}");
  });

  it("generateActivityDiagram / generateStateDiagram accept trailing domainModelJson", async () => {
    const { gen } = makeGen();
    let capturedPrompt = "";
    (gen as any).llm = {
      generateText: (p: string) => { capturedPrompt = p; return Promise.resolve("```mermaid\nflowchart TD\n    A --> B\n```"); },
    };
    (gen as any).prompts = {
      ...({} as any),
      activity_diagram: "{domain_model_json}\n{requirement_json}\n{design_text}",
    };
    await gen.generateActivityDiagram({ functions: [] }, "design", undefined, "", undefined, { concepts: [{ name: "FromDomain", kind: "entity" }] });
    expect(capturedPrompt).toContain("FromDomain");
  });
});

