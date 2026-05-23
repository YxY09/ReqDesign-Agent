import { describe, it, expect } from "vitest";
import { RepairTool } from "../src/tools/repair.js";
import type { Section } from "../src/tools/artifactPatcher.js";

const noopLogger = { info: (_msg: string) => {} };

describe("RepairTool._preserveClassDefinitions", () => {
  it("does nothing when no classes are lost", () => {
    const original: Section[] = [
      {
        key: "class_diagram",
        content: "classDiagram\nclass A {\n  +foo()\n}\nclass B {\n  +bar()\n}",
      },
    ];
    const patched: Section[] = [
      {
        key: "class_diagram",
        content: "classDiagram\nclass A {\n  +foo()\n}\nclass B {\n  +bar()\n}",
      },
    ];
    RepairTool._preserveClassDefinitions(original, patched, noopLogger, "t1");
    expect(patched[0].content).toBe(
      "classDiagram\nclass A {\n  +foo()\n}\nclass B {\n  +bar()\n}",
    );
  });

  it("restores a lost class definition", () => {
    const original: Section[] = [
      {
        key: "class_diagram",
        content:
          "classDiagram\n    class Calculation {\n        +Decimal result\n    }\n    class CalculatorService {\n        +performCalculation()\n    }\n    CalculatorService \"1\" --> \"*\" Calculation : creates",
      },
    ];
    const patched: Section[] = [
      {
        key: "class_diagram",
        content:
          "classDiagram\n    class Calculation {\n        +Decimal result\n    }",
      },
    ];

    RepairTool._preserveClassDefinitions(original, patched, noopLogger, "t1");

    // CalculatorService should be restored
    expect(patched[0].content).toContain("CalculatorService");
    expect(patched[0].content).toContain("performCalculation");
    // Calculation should still be there
    expect(patched[0].content).toContain("Calculation");
  });

  it("restores lost class before relationship lines", () => {
    const original: Section[] = [
      {
        key: "class_diagram",
        content:
          "classDiagram\n    class Order {\n        +Long id\n    }\n    class OrderItem {\n        +String name\n    }\n    Order \"1\" --> \"*\" OrderItem : contains",
      },
    ];
    const patched: Section[] = [
      {
        key: "class_diagram",
        content:
          "classDiagram\n    class Order {\n        +Long id\n    }\n    Order \"1\" --> \"*\" OrderItem : contains",
      },
    ];

    RepairTool._preserveClassDefinitions(original, patched, noopLogger, "t1");

    // OrderItem block inserted before relationship line
    const lines = patched[0].content.split("\n");
    const orderItemIdx = lines.findIndex(l => l.includes("class OrderItem"));
    const relIdx = lines.findIndex(l => /-->/.test(l) && l.includes("contains"));
    expect(orderItemIdx).toBeGreaterThanOrEqual(0);
    expect(relIdx).toBeGreaterThanOrEqual(0);
    expect(orderItemIdx).toBeLessThan(relIdx);
  });

  it("skips when original has no class_diagram section", () => {
    const original: Section[] = [{ key: "state_diagram", content: "xxx" }];
    const patched: Section[] = [{ key: "state_diagram", content: "yyy" }];
    RepairTool._preserveClassDefinitions(original, patched, noopLogger, "t1");
    expect(patched[0].content).toBe("yyy");
  });
});

describe("RepairTool._extractClassNames", () => {
  it("extracts class names from Mermaid classDiagram", () => {
    const names = RepairTool._extractClassNames(
      "classDiagram\n    class Foo {\n        +bar()\n    }\n    class Baz {\n        +qux()\n    }",
    );
    expect(names).toEqual(["Foo", "Baz"]);
  });

  it("returns empty array for non-classDiagram content", () => {
    expect(RepairTool._extractClassNames("stateDiagram-v2\n[*] --> Idle")).toEqual([]);
  });

  it("deduplicates class names", () => {
    const names = RepairTool._extractClassNames(
      "classDiagram\nclass X {\n}\nclass X {\n}",
    );
    expect(names).toEqual(["X"]);
  });
});

describe("RepairTool._extractClassBlocks", () => {
  it("extracts full class block for given names", () => {
    const mermaid =
      "classDiagram\n    class Calc {\n        +Decimal result\n        +calculate()\n    }\n    class Service {\n        +run()\n    }";
    const blocks = RepairTool._extractClassBlocks(mermaid, ["Calc"]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("class Calc");
    expect(blocks[0]).toContain("+calculate()");
  });

  it("returns empty when name not found", () => {
    const blocks = RepairTool._extractClassBlocks("classDiagram\nclass X {\n}", ["Y"]);
    expect(blocks).toHaveLength(0);
  });
});
