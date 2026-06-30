import { describe, it, expect } from "vitest";
import { ArtifactAcceptanceService } from "../src/runtime/artifactAcceptanceService.js";
import type { WorkflowState } from "../src/state.js";
import type { Artifact } from "../src/shared/types.js";

/**
 * End-to-end regression: the persistence/acceptance gate must NOT corrupt a
 * domain concept name. This exercises the real corruption path —
 * ArtifactAcceptanceService.evaluateCandidate runs PostGenerationValidator
 * over a candidate diagram and writes the cleaned content back into the
 * artifact that the runtime then persists.
 *
 * Synthetic names are used (NOT any reference-domain entity) so the guard is
 * proven general: a domain concept (`BaseUser`) that contains an analysis
 * entity name (`User`) as a substring must survive verbatim through the gate,
 * and a repaired diagram must be persisted when accepted.
 */

// Minimal stub: WorkflowState is a large class, but evaluateCandidate only
// reads these fields for a passing candidate on the "accept" branch.
function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    artifacts: {},
    domainModelJson: {},
    requirementJson: {},
    currentArtifactRevision: () => 0,
    ...overrides,
  } as unknown as WorkflowState & Partial<WorkflowState> & WorkflowState;
}

describe("ArtifactAcceptanceService — class-diagram concept name round-trip", () => {
  it("preserves a domain concept name (BaseUser) through the acceptance gate, does NOT alias to analysis entity (User)", () => {
    // Analysis-level entity names — these are what substring-matching targets.
    const requirementJson = {
      entities: [
        { name: "User" },
        { name: "Organizer" },
        { name: "Invitation" },
      ],
    };
    // Authoritative domain model — the CORRECT concept names.
    const domainModelJson = {
      concepts: [
        { name: "BaseUser", kind: "entity", abstract: true },
        { name: "Organizer", kind: "entity" },
        { name: "InvitationRecord", kind: "entity" },
        { name: "TaskStatus", kind: "enumeration" },
      ],
    };

    const state = makeState({ requirementJson, domainModelJson });

    // The LLM produced the CORRECT diagram (this is exactly what the trace
    // showed for generation entry 6 and repair entry 24).
    const candidate: Artifact = {
      taskId: "T-diagrams",
      type: "diagrams",
      revision: 1,
      selfCheckPassed: true,
      selfCheckIssues: [],
      generationDuration: 0,
      content: {
        class_diagram: [
          "classDiagram",
          "    class BaseUser {",
          "        <<abstract>>",
          "    }",
          "    class Organizer {",
          "    }",
          "    class InvitationRecord {",
          "    }",
          "    class TaskStatus {",
          "        <<enumeration>>",
          "    }",
          "    BaseUser <|-- Organizer",
          "    InvitationRecord --> TaskStatus",
        ].join("\n"),
      },
    };

    const service = new ArtifactAcceptanceService();
    const outcome = service.evaluateCandidate({ state, taskId: "T-diagrams", artifact: candidate });

    // A passing artifact MUST be accepted.
    expect(outcome.action).toBe("accept");
    const accepted = (outcome as { artifact: Artifact }).artifact;

    // The accepted artifact content (what persistence consumes) must contain
    // the correct concept names and NOT the corrupted alias names.
    const cd = String((accepted.content as Record<string, unknown>).class_diagram);
    expect(cd).toContain("class BaseUser");
    expect(cd).toContain("class InvitationRecord");
    expect(cd).toContain("class TaskStatus");
    // The corruption alias must NOT appear as a class definition or a
    // standalone generalization source (corruption renamed BaseUser→User,
    // producing `class User {` and `User <|--`).
    expect(cd).not.toContain("class User");
    expect(cd).not.toContain("\n    User <|--");
    expect(cd).not.toContain("class Invitation {");
  });

  it("persists a successfully repaired diagram (repair output is NOT discarded)", () => {
    // Same domain model as above — repair corrected the diagram.
    const requirementJson = {
      entities: [{ name: "User" }, { name: "Invitation" }],
    };
    const domainModelJson = {
      concepts: [
        { name: "BaseUser", kind: "entity", abstract: true },
        { name: "InvitationRecord", kind: "entity" },
      ],
    };

    const state = makeState({ requirementJson, domainModelJson });

    // The repaired diagram is correct — must be the one accepted/persisted.
    const repaired: Artifact = {
      taskId: "T-diagrams",
      type: "diagrams",
      revision: 2,
      selfCheckPassed: true,
      selfCheckIssues: [],
      generationDuration: 0,
      content: {
        class_diagram: [
          "classDiagram",
          "    class BaseUser {",
          "        <<abstract>>",
          "    }",
          "    class InvitationRecord {",
          "    }",
          "    BaseUser <|-- InvitationRecord",
        ].join("\n"),
      },
    };

    const service = new ArtifactAcceptanceService();
    const outcome = service.evaluateCandidate({ state, taskId: "T-diagrams", artifact: repaired });

    expect(outcome.action).toBe("accept");
    const accepted = (outcome as { artifact: Artifact }).artifact;
    const cd = String((accepted.content as Record<string, unknown>).class_diagram);

    // The repaired (correct) concept names are what survives the gate.
    expect(cd).toContain("class BaseUser");
    expect(cd).toContain("class InvitationRecord");
    expect(cd).not.toContain("class User");
    expect(cd).not.toContain("class Invitation {");
  });

  // ------------------------------------------------------------------
  // Regression: generalization fidelity through the acceptance gate.
  // A repair-path LLM can collapse a domain-model generalization into a
  // single flattened entity + a `role` attribute (the S5-dm10 Person ->
  // Organizer/Attendee bug), dropping BOTH generalization hierarchy lines.
  // The acceptance gate must deterministically restore every authoritative
  // generalization as a `Parent <|-- Child` line, for ANY parent/child names.
  // Synthetic names (BaseUser -> AdminUser/CustomerUser) prove the guard is
  // general, not specialized to any reference domain.
  // ------------------------------------------------------------------
  it("injects <|-- generalization lines + class blocks when the class diagram is stripped/empty", () => {
    const requirementJson = { entities: [{ name: "Account" }] };
    const domainModelJson = {
      concepts: [
        { name: "BaseUser", kind: "entity", abstract: true,
          attributes: [{ name: "email", type: "String" }] },
        { name: "AdminUser", kind: "entity" },
        { name: "CustomerUser", kind: "entity" },
        { name: "Account", kind: "entity" },
      ],
      generalizations: [{ parent: "BaseUser", children: ["AdminUser", "CustomerUser"] }],
      associations: [],
    };
    const state = makeState({ requirementJson, domainModelJson });

    // (i) The diagram is effectively empty / stripped of any hierarchy.
    const stripped: Artifact = {
      taskId: "T-diagrams",
      type: "diagrams",
      revision: 1,
      selfCheckPassed: true,
      selfCheckIssues: [],
      generationDuration: 0,
      content: { class_diagram: "classDiagram\n" },
    };

    const service = new ArtifactAcceptanceService();
    const outcome = service.evaluateCandidate({ state, taskId: "T-diagrams", artifact: stripped });
    expect(outcome.action).toBe("accept");
    const cd = String(((outcome as { artifact: Artifact }).artifact.content as Record<string, unknown>).class_diagram);

    // The hierarchy is restored: parent + children class blocks ...
    expect(cd).toContain("class BaseUser {");
    expect(cd).toContain("class AdminUser {");
    expect(cd).toContain("class CustomerUser {");
    // ... with the abstract marker on the parent ...
    expect(cd).toContain("<<abstract>>");
    // ... and BOTH generalization lines, deterministically injected.
    expect(cd).toContain("BaseUser <|-- AdminUser");
    expect(cd).toContain("BaseUser <|-- CustomerUser");
  });

  it("restores <|-- generalization lines when a repair LLM flattened the hierarchy into one entity + a role attribute", () => {
    // Analysis entity (what the flat LLM entity maps to) - distinct from the
    // authoritative domain generalization roles.
    const requirementJson = { entities: [{ name: "UserAccount" }] };
    const domainModelJson = {
      concepts: [
        { name: "BaseUser", kind: "entity", abstract: true, attributes: [{ name: "email", type: "String" }] },
        { name: "AdminUser", kind: "entity" },
        { name: "CustomerUser", kind: "entity" },
      ],
      generalizations: [{ parent: "BaseUser", children: ["AdminUser", "CustomerUser"] }],
      associations: [],
    };
    const state = makeState({ requirementJson, domainModelJson });

    // (ii) The repair LLM collapsed BaseUser/AdminUser/CustomerUser into a
    // single `UserAccount` with a `role` attribute - exactly the S5-dm10
    // failure shape (generalization flattened, zero <|-- lines).
    const flattened: Artifact = {
      taskId: "T-diagrams",
      type: "diagrams",
      revision: 3,
      selfCheckPassed: true,
      selfCheckIssues: [],
      generationDuration: 0,
      content: {
        class_diagram: [
          "classDiagram",
          "    class UserAccount {",
          "        -String email",
          "        -String role",
          "    }",
        ].join("\n"),
      },
    };

    const service = new ArtifactAcceptanceService();
    const outcome = service.evaluateCandidate({ state, taskId: "T-diagrams", artifact: flattened });
    expect(outcome.action).toBe("accept");
    const cd = String(((outcome as { artifact: Artifact }).artifact.content as Record<string, unknown>).class_diagram);

    // The authoritative generalization hierarchy MUST be restored even though
    // the repair LLM flattened it. Assert the <|-- lines are present.
    expect(cd).toContain("class BaseUser {");
    expect(cd).toContain("class AdminUser {");
    expect(cd).toContain("class CustomerUser {");
    expect(cd).toContain("BaseUser <|-- AdminUser");
    expect(cd).toContain("BaseUser <|-- CustomerUser");
    // Regression (repair-loop prevention): the leftover flattened `UserAccount`
    // role-tag entity — which the restored hierarchy supersedes — MUST be
    // removed, so the diagram does not carry BOTH the hierarchy and the
    // flattened entity (which would re-trigger the evaluator and loop repair).
    expect(cd).not.toContain("UserAccount");
  });
});
