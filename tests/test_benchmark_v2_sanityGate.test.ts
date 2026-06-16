/**
 * Phase-1 unit tests: sanityGate.ts — Layer-0 deterministic gate pass/fail for
 * valid artifacts, empty diagrams, dangling entity refs, malformed mermaid,
 * and missing required artifacts. Fully offline.
 */
import { describe, it, expect } from "vitest";

import { runSanityGate } from "../src/benchmark/sanityGate.js";

// Canonical well-formed diagram sources (mirrors the legacy scorer tests).
const VALID_CLASS = "classDiagram\n  class User\n  class Order\n  User --> Order";
const VALID_ACTIVITY =
  "flowchart TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]\n  B -->|否| D[重试]";
const VALID_STATE =
  "stateDiagram-v2\n  [*] --> Open\n  Open --> Closed\n  Closed --> [*]";

/** Full present-artifact set matching the expanded REQUIRED_ARTIFACTS. */
const ALL_ARTIFACTS = ["requirement", "design", "diagrams", "tests"];

describe("runSanityGate", () => {
  it("passes for a complete, well-formed artifact set", () => {
    const out = runSanityGate({
      requirement: { entities: [{ name: "User" }, { name: "Order" }] },
      diagrams: {
        class_diagram: VALID_CLASS,
        activity_diagram: VALID_ACTIVITY,
        state_diagram: VALID_STATE,
      },
      presentArtifacts: ALL_ARTIFACTS,
    });
    expect(out.passed).toBe(true);
    expect(out.errors).toEqual([]);
  });

  it("fails when any required artifact category is missing", () => {
    // No artifacts reported present → every category (requirement/design/
    // diagrams/tests) is flagged.
    const out = runSanityGate({
      requirement: {},
      diagrams: {},
      presentArtifacts: [],
    });
    expect(out.passed).toBe(false);
    for (const cat of ["requirement", "design", "diagrams", "tests"]) {
      expect(out.errors.some((e) => e.includes(`missing required artifact: ${cat}`))).toBe(true);
    }
  });

  it("fails when only requirement is present (design/diagrams/tests absent)", () => {
    const out = runSanityGate({
      requirement: {},
      diagrams: {},
      presentArtifacts: ["requirement"],
    });
    expect(out.passed).toBe(false);
    expect(out.errors.some((e) => e.includes("missing required artifact: design"))).toBe(true);
    expect(out.errors.some((e) => e.includes("missing required artifact: tests"))).toBe(true);
  });

  it("fails on a dangling entity (declared in requirement but absent from class diagram)", () => {
    const out = runSanityGate({
      requirement: { entities: [{ name: "Phantom" }] },
      diagrams: { class_diagram: "classDiagram\n  class Real" },
      presentArtifacts: ALL_ARTIFACTS,
    });
    expect(out.passed).toBe(false);
    expect(out.errors.some((e) => e.includes("dangling entity") && e.includes("Phantom"))).toBe(true);
  });

  it("fails on malformed mermaid (missing class definitions in a classDiagram)", () => {
    const out = runSanityGate({
      requirement: { entities: [] },
      diagrams: { class_diagram: "classDiagram\n  User --> Order" }, // no `class` decls
      presentArtifacts: ALL_ARTIFACTS,
    });
    expect(out.passed).toBe(false);
    expect(out.errors.some((e) => e.includes("class_diagram"))).toBe(true);
  });

  it("detects a dangling class reference in a relation (hallucinated id)", () => {
    // Order is referenced but never declared with `class`.
    const out = runSanityGate({
      requirement: { entities: [] },
      diagrams: { class_diagram: "classDiagram\n  class User\n  User --> Order" },
      presentArtifacts: ALL_ARTIFACTS,
    });
    expect(out.passed).toBe(false);
    expect(out.errors.some((e) => e.includes("class_diagram"))).toBe(true);
  });

  it("detects a duplicate class definition", () => {
    const out = runSanityGate({
      requirement: { entities: [] },
      diagrams: {
        class_diagram: "classDiagram\n  class User\n  class User",
      },
      presentArtifacts: ALL_ARTIFACTS,
    });
    expect(out.passed).toBe(false);
  });

  it("passes when requirement.entities is empty (no entities to cross-check)", () => {
    const out = runSanityGate({
      requirement: { entities: [] },
      diagrams: { class_diagram: VALID_CLASS, activity_diagram: VALID_ACTIVITY, state_diagram: VALID_STATE },
      presentArtifacts: ALL_ARTIFACTS,
    });
    expect(out.passed).toBe(true);
  });

  it("fails when diagrams are entirely empty (Layer-0 completeness, not a quality gap)", () => {
    // A run that produced no structural view at all is invalid at Layer 0:
    // empty diagrams is a completeness failure, regardless of whether the
    // diagrams/ category is reported present.
    const out = runSanityGate({
      requirement: { entities: [] },
      diagrams: {},
      presentArtifacts: ALL_ARTIFACTS,
    });
    expect(out.passed).toBe(false);
    expect(out.errors.some((e) => e.includes("no non-empty diagram"))).toBe(true);
  });

  it("reports all diagram errors, not just the first", () => {
    const out = runSanityGate({
      requirement: { entities: [] },
      diagrams: {
        // class_diagram: relation to an undeclared class
        class_diagram: "classDiagram\n  class User\n  User --> Order",
        // activity_diagram: duplicate node id 'A' across two definition lines
        activity_diagram: "flowchart TD\n  A[X] --> B\n  A[Y] --> C",
      },
      presentArtifacts: ALL_ARTIFACTS,
    });
    expect(out.passed).toBe(false);
    expect(out.errors.filter((e) => e.includes("diagram")).length).toBeGreaterThanOrEqual(2);
  });
});
