import { describe, it, expect } from "vitest";
import { WorkflowState } from "../src/state.js";
import { createArtifact, createTask } from "../src/agent/types.js";

describe("Validator integration — addArtifact cleans downstream", () => {
  it("removes extra classes from class diagram on add", () => {
    const state = new WorkflowState();
    
    // Setup analysis
    state.addArtifact(createArtifact({
      taskId: "analyze-1",
      type: "analyze",
      content: {
        entities: [
          { name: "User", attributes: [{ name: "id", type: "Long" }] },
          { name: "Product", attributes: [{ name: "id", type: "Long" }] },
        ],
        functions: [
          { id: "F001", name: "Test" },
          { id: "F002", name: "Test2" },
        ],
      },
    }));

    // Add a class diagram with an extra class
    state.addArtifact(createArtifact({
      taskId: "diagrams-class",
      type: "diagrams",
      content: {
        class_diagram: [
          "classDiagram",
          "    class User {",
          "        -Long id",
          "    }",
          "    class Product {",
          "        -Long id",
          "    }",
          "    class ExtraFoo {",
          "        -String bar",
          "    }",
          '    User "1" --> "*" Product : uses',
          '    ExtraFoo "1" --> "*" User : relates',
        ].join("\n"),
      },
    }));

    // Check the stored diagram
    const savedArtifact = state.artifactsState.artifacts["diagrams-class"];
    expect(savedArtifact).toBeDefined();
    const content = savedArtifact!.content as Record<string, unknown>;
    const cd = String(content.class_diagram ?? "");

    // ExtraFoo should be removed by validator
    expect(cd).not.toContain("ExtraFoo");
    expect(cd).toContain("class User");
    expect(cd).toContain("class Product");
  });

  it("removes ghost IDs from design on add", () => {
    const state = new WorkflowState();

    // Setup analysis
    state.addArtifact(createArtifact({
      taskId: "analyze-1",
      type: "analyze",
      content: {
        entities: [],
        functions: [
          { id: "F001", name: "RealFunc" },
        ],
      },
    }));

    // Add design with ghost ID
    state.addArtifact(createArtifact({
      taskId: "design-1",
      type: "design",
      content: "| Module A | Does stuff | F001 |\n| Module B | Ghost | F999 |\n",
    }));

    const saved = state.artifactsState.artifacts["design-1"];
    expect(saved).toBeDefined();
    const content = String(saved!.content ?? "");

    expect(content).not.toContain("F999");
    expect(content).toContain("F001");
    expect(content).not.toContain("Module B"); // removed with F999 row
  });
});
