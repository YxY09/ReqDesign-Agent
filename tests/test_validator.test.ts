import { describe, it, expect } from "vitest";
import { PostGenerationValidator } from "../src/tools/validator.js";

const ANALYSIS = {
  functions: [
    { id: "F001", name: "DoSomething" },
    { id: "F002", name: "DoOther" },
    { id: "F003", name: "DoMore" },
  ],
  entities: [
    { name: "User", attributes: [{ name: "id", type: "Long" }] },
    { name: "Product", attributes: [{ name: "id", type: "Long" }] },
    { name: "Order", attributes: [{ name: "id", type: "Long" }] },
  ],
};

describe("PostGenerationValidator", () => {
  // ------------------------------------------------------------------
  // Design — ghost IDs
  // ------------------------------------------------------------------
  it("removes ghost function IDs from design text", () => {
    const text = "| 用户模块 | 管理用户 | F001 |\n| 幽灵模块 | 不存在 | F999 |\n| 产品模块 | 管理产品 | F002 |";

    const result = PostGenerationValidator.validate(ANALYSIS, "design", text);
    expect(result).not.toBeNull();
    const cleaned = result as string;
    expect(cleaned).not.toContain("F999");
    expect(cleaned).not.toContain("幽灵模块");
    expect(cleaned).toContain("F001");
    expect(cleaned).toContain("F002");
  });

  it("returns null when design has no ghost IDs", () => {
    const text = "| A | F001 |\n| B | F002, F003 |";
    const result = PostGenerationValidator.validate(ANALYSIS, "design", text);
    expect(result).toBeNull();
  });

  it("accepts display IDs when analysis stores canonical function IDs", () => {
    const analysis = {
      functions: [{ id: "FUN_LOGIN", displayId: "F001", name: "Login" }],
    };

    expect(PostGenerationValidator.validate(analysis, "design", "| Auth | F001 |")).toBeNull();

    const cleaned = PostGenerationValidator.validate(analysis, "design", "| Ghost | F999 |") as string;
    expect(cleaned).not.toContain("F999");
  });

  // ------------------------------------------------------------------
  // Diagrams — extra classes
  // ------------------------------------------------------------------
  it("removes classes not in analysis entities", () => {
    const obj = {
      class_diagram: [
        "classDiagram",
        "    class User {",
        "        -Long id",
        "    }",
        "    class ExtraFoo {",
        "        -String bar",
        "    }",
        "    class Product {",
        "        -Long id",
        "    }",
        '    User "1" --> "*" Product : uses',
        '    ExtraFoo "1" --> "*" User : relates',
      ].join("\n"),
      activity_diagram: "flowchart TD\nA --> B",
    };

    const result = PostGenerationValidator.validate(ANALYSIS, "diagrams", obj);
    expect(result).not.toBeNull();
    const cleaned = result as Record<string, unknown>;
    const cd = String(cleaned.class_diagram ?? "");

    expect(cd).toContain("class User");
    expect(cd).toContain("class Product");
    expect(cd).not.toContain("class ExtraFoo");
    expect(cd).not.toContain("ExtraFoo");
    // activity diagram should be untouched
    expect(cleaned.activity_diagram).toBe("flowchart TD\nA --> B");
  });

  it("fixes renamed entity names in class diagram", () => {
    const obj = {
      class_diagram: [
        "classDiagram",
        "    class ShippingAddress {",
        "        -String line1",
        "    }",
        '    ShippingAddress "1" --> "*" Order : delivers',
      ].join("\n"),
    };

    const analysis = {
      entities: [
        { name: "Address", attributes: [{ name: "id", type: "Long" }] },
        { name: "Order", attributes: [{ name: "id", type: "Long" }] },
      ],
    };

    const result = PostGenerationValidator.validate(analysis, "diagrams", obj);
    expect(result).not.toBeNull();
    const cleaned = result as Record<string, unknown>;
    const cd = String(cleaned.class_diagram ?? "");

    // ShippingAddress should be renamed to Address
    expect(cd).not.toContain("ShippingAddress");
    expect(cd).toContain("class Address {");
    expect(cd).toContain('Address "1" -->');
  });

  it("returns null when class diagram has no issues", () => {
    const obj = {
      class_diagram: [
        "classDiagram",
        "    class User {",
        "        -Long id",
        "    }",
        "    class Product {",
        "        -Long id",
        "    }",
        '    User "1" --> "*" Product : uses',
      ].join("\n"),
    };

    const result = PostGenerationValidator.validate(ANALYSIS, "diagrams", obj);
    expect(result).toBeNull();
  });

  // ------------------------------------------------------------------
  // Tests — ghost IDs
  // ------------------------------------------------------------------
  it("removes ghost function IDs from test cases", () => {
    const text = [
      "## TC-N-001: Test",
      "- **类型**: 正常",
      "- **测试对象**: F001",
      "- **预期结果**: OK",
      "",
      "## TC-N-999: Ghost test",
      "- **类型**: 正常",
      "- **测试对象**: F999",
      "- **前置条件**: None",
      "- **预期结果**: Ghost",
    ].join("\n");

    const result = PostGenerationValidator.validate(ANALYSIS, "tests", text);
    expect(result).not.toBeNull();
    const cleaned = result as string;
    expect(cleaned).toContain("TC-N-001");
    expect(cleaned).not.toContain("F999");
    expect(cleaned).not.toContain("TC-N-999");
  });

  it("returns null when tests have no ghost IDs", () => {
    const text = "F001 and F002 are valid";
    const result = PostGenerationValidator.validate(ANALYSIS, "tests", text);
    expect(result).toBeNull();
  });

  // ------------------------------------------------------------------
  // Unsupported types
  // ------------------------------------------------------------------
  it("returns null for unsupported artifact types", () => {
    const result = PostGenerationValidator.validate(ANALYSIS, "analyze", {});
    expect(result).toBeNull();
  });

  it("returns null when analysis is null", () => {
    const text = "F999 is a ghost";
    const result = PostGenerationValidator.validate(null, "design", text);
    expect(result).toBeNull();
  });
});
