import { describe, it, expect } from "vitest";
import { PersistenceService } from "../src/runtime/persistenceService.js";
import type { PersistenceServiceDeps } from "../src/runtime/persistenceService.js";
import type { WorkflowState } from "../src/state.js";
import { WorkflowState as RealWorkflowState } from "../src/state.js";
import { resolveTraceFlags } from "../src/config.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Minimal stub deps — findOutputConsistencyIssues doesn't call any deps,
 * so we just need something that satisfies the type.
 */
function makeDeps(): PersistenceServiceDeps {
  return {
    outputManagerCtor: class {
      saveSystemDesign() {}
      saveDiagrams() {}
      saveTestCases() {}
      saveArtifactByTask() {}
      saveTraceJson() {}
      saveReviewReport() {}
      saveQualityScore() {}
      saveRequirementAnalysis() {}
      saveAll() {}
      saveSnapshot() {}
    } as unknown as PersistenceServiceDeps["outputManagerCtor"],
    trace: { log: () => {}, child: () => ({ log: () => {} }) } as unknown as PersistenceServiceDeps["trace"],
    mailbox: { send: () => {}, receive: () => [] } as unknown as PersistenceServiceDeps["mailbox"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as PersistenceServiceDeps["logger"],
    onEmitRuntimeEvent: () => {},
    onSnapshotState: () => ({}),
    // Resolve real trace flags so exportTrace won't TypeError if invoked.
    traceFlags: resolveTraceFlags({}),
  };
}

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  const state = {
    requirementJson: {
      functions: [
        { id: "FUN_ADVANCED_SEARCH", displayId: "F001", name: "Advanced Search" },
        { id: "FUN_USER_AUTH", displayId: "F002", name: "User Authentication" },
      ],
    },
    designText: "The system uses F001 for advanced search and F002 for auth.",
    testCases: "Test F001: verify search works. Test F002: verify login.",
    diagrams: {},
  } as unknown as WorkflowState;
  return Object.assign(state, overrides);
}

describe("findOutputConsistencyIssues", () => {
  it("should not flag displayId references (e.g. F001) as undefined when both id and displayId are defined", () => {
    const service = new PersistenceService(makeDeps());
    const state = makeState();
    const issues = service.findOutputConsistencyIssues(state);
    expect(issues).toEqual([]);
  });

  it("should still flag truly undefined displayId references", () => {
    const service = new PersistenceService(makeDeps());
    const state = makeState({
      designText: "This uses F999 which is not defined anywhere.",
      testCases: "",
      diagrams: {},
    });
    const issues = service.findOutputConsistencyIssues(state);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("F999");
  });

  it("should return empty when no functions are defined", () => {
    const service = new PersistenceService(makeDeps());
    const state = makeState({
      requirementJson: {},
    });
    const issues = service.findOutputConsistencyIssues(state);
    expect(issues).toEqual([]);
  });
});

describe("actionSaveIfQualityGatePassed", () => {
  function makeWorkflowState(): RealWorkflowState {
    const state = new RealWorkflowState();
    state.goal = "design";
    state.outputDir = mkdtempSync(join(tmpdir(), "reqdesign-persist-"));
    state.requirementJson = {
      functions: [
        { id: "FUN_ADVANCED_SEARCH", displayId: "F001", name: "Advanced Search" },
      ],
      constraints: [
        { id: "CON_SEC_AUDIT", displayId: "C001", description: "Audit trail required" },
      ],
      exceptions: [
        { id: "EXC_DENIED", displayId: "X001", description: "Access denied" },
      ],
    };
    state.designText = "Design covers C001.";
    state.testCases = "Test F001. Test C001. Test X001.";
    return state;
  }

  it("blocks final save when deterministic structural review validation fails", () => {
    const service = new PersistenceService(makeDeps());
    const state = makeWorkflowState();
    state.testCases = "Test F001.\n步骤：\n预期结果：";

    const saved = service.actionSaveIfQualityGatePassed(state, "unit test");

    expect(saved).toBe(false);
    expect(state.persistStatus).toBe("partial_saved");
    expect(state.qualityStatus).toBe("rejected");
    expect(state.finalReviewPassed).toBe(false);
    expect(state.errors.some((item) => item.includes("deterministic quality gate failed"))).toBe(true);
  });

  it("allows final save when only coverage is incomplete", () => {
    const service = new PersistenceService(makeDeps());
    const state = makeWorkflowState();
    state.testCases = "Test F001 only.";

    const saved = service.actionSaveIfQualityGatePassed(state, "unit test");

    expect(saved).toBe(true);
    expect(state.persistStatus).toBe("final_saved");
    expect(state.errors.some((item) => item.includes("review.覆盖率"))).toBe(false);
  });

  it("allows final save when deterministic validation passes", () => {
    const service = new PersistenceService(makeDeps());
    const state = makeWorkflowState();

    const saved = service.actionSaveIfQualityGatePassed(state, "unit test");

    expect(saved).toBe(true);
    expect(state.persistStatus).toBe("final_saved");
    expect(state.persisted).toBe(true);
  });
});

describe("PersistenceService.containsStubPlaceholders", () => {
  it("flags '(原有 XX 保持不变)' as a stub", () => {
    const text = "## 设计\n\n### 接口定义\n（原有接口定义保持不变，此处省略）";
    expect(PersistenceService.containsStubPlaceholders(text)).toBe(true);
  });

  it("flags '(此处省略)' as a stub", () => {
    const text = "## 数据流\n\n（此处省略）";
    expect(PersistenceService.containsStubPlaceholders(text)).toBe(true);
  });

  it("flags '(omitted)' / '(unchanged)' English variants", () => {
    expect(PersistenceService.containsStubPlaceholders("## X\n(omitted)")).toBe(true);
    expect(PersistenceService.containsStubPlaceholders("## Y\n(unchanged)")).toBe(true);
    expect(PersistenceService.containsStubPlaceholders("text ... unchanged ...")).toBe(true);
  });

  it("flags '保留原有内容' variant", () => {
    expect(PersistenceService.containsStubPlaceholders("## X\n（保留原有内容）")).toBe(true);
  });

  it("does NOT flag a complete design that legitimately uses the word 省略 inside content", () => {
    const text =
      "## 模块划分\n\n本系统包含完整的5个模块。\n" +
      "## 核心类设计\n\nclass Foo { method bar(): void; }\n" +
      "## 数据流\n\n用户提交 → 系统验证 → 返回结果\n" +
      "## 设计覆盖矩阵\n\n| ID | 决策 | ...";
    expect(PersistenceService.containsStubPlaceholders(text)).toBe(false);
  });

  it("does NOT trip on the literal word '不变' outside a placeholder pattern", () => {
    const text = "## 接口\n\n本接口契约一旦发布即保持向后兼容，URL 路径不变。";
    expect(PersistenceService.containsStubPlaceholders(text)).toBe(false);
  });
});
