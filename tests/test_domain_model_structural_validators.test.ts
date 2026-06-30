import { describe, it, expect } from "vitest";
import { DomainModelGenerator } from "../src/generators/domainModel.js";
import { GenerationTool } from "../src/tools/generation.js";
import { createTask } from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// 确定性领域模型结构校验器回归测试（FIX1/FIX2/FIX3）
//
// 全部使用 SYNTHETIC 名称，绝不引用 S5/S12/Person/Organizer/Account/Invoice
// 等真实用例名称。验证三个校验器的触发与不触发（防误报）行为，以及通过
// GenerationTool._ruleCheck 的集成接入路径。
// ---------------------------------------------------------------------------

describe("DomainModelGenerator.validateRoleHierarchy (FIX1)", () => {
  it("fires when multiple distinct-role actors collapse into one entity with no generalization", () => {
    const model = {
      concepts: [{ id: "D001", name: "Party", kind: "entity" }],
      generalizations: [],
      associations: [],
    };
    const req = {
      actors: [
        { name: "AlphaUser", description: "管理后台、配置规则" },
        { name: "BetaUser", description: "提交申请、查看记录" },
      ],
    };
    const issues = DomainModelGenerator.validateRoleHierarchy(model, req);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain("AlphaUser");
    expect(issues[0]).toContain("BetaUser");
    expect(issues[0]).toContain("泛化");
  });

  it("does NOT fire when a generalization hierarchy exists", () => {
    const model = {
      concepts: [
        { id: "D001", name: "Party", kind: "entity", abstract: true },
        { id: "D002", name: "AlphaUser", kind: "entity" },
        { id: "D003", name: "BetaUser", kind: "entity" },
      ],
      generalizations: [{ parent: "Party", children: ["AlphaUser", "BetaUser"] }],
      associations: [],
    };
    const req = {
      actors: [
        { name: "AlphaUser", description: "管理后台、配置规则" },
        { name: "BetaUser", description: "提交申请、查看记录" },
      ],
    };
    expect(DomainModelGenerator.validateRoleHierarchy(model, req)).toEqual([]);
  });

  it("does NOT fire when actors share identical descriptions (no distinct roles)", () => {
    const model = {
      concepts: [{ id: "D001", name: "Party", kind: "entity" }],
      generalizations: [],
      associations: [],
    };
    const req = {
      actors: [
        { name: "AlphaUser", description: "普通参与者" },
        { name: "BetaUser", description: "普通参与者" },
      ],
    };
    expect(DomainModelGenerator.validateRoleHierarchy(model, req)).toEqual([]);
  });

  it("does NOT fire when fewer than 2 actors exist", () => {
    const model = {
      concepts: [{ id: "D001", name: "Party", kind: "entity" }],
      generalizations: [],
      associations: [],
    };
    const req = { actors: [{ name: "AlphaUser", description: "唯一角色" }] };
    expect(DomainModelGenerator.validateRoleHierarchy(model, req)).toEqual([]);
  });

  it("is defensive: returns [] when actors/concepts missing", () => {
    expect(DomainModelGenerator.validateRoleHierarchy({}, {})).toEqual([]);
    expect(DomainModelGenerator.validateRoleHierarchy({ concepts: [] }, { actors: [] })).toEqual([]);
  });
});

describe("DomainModelGenerator.validateLineItemDecomposition (FIX2)", () => {
  it("fires when an aggregate has a total-field + one-to-many association but no line_item", () => {
    const model = {
      concepts: [
        { id: "D001", name: "OrderMaster", kind: "entity", attributes: [{ name: "GrandTotal", type: "Decimal" }] },
        { id: "D002", name: "OrderRecord", kind: "entity" },
      ],
      generalizations: [],
      associations: [
        { source: "OrderMaster", target: "OrderRecord", sourceMultiplicity: "1", targetMultiplicity: "*" },
      ],
    };
    const issues = DomainModelGenerator.validateLineItemDecomposition(model);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain("OrderMaster");
    expect(issues[0]).toContain("line_item");
  });

  it("does NOT fire when a line_item concept decomposes the aggregate", () => {
    const model = {
      concepts: [
        { id: "D001", name: "OrderMaster", kind: "entity", attributes: [{ name: "GrandTotal", type: "Decimal" }] },
        { id: "D002", name: "OrderRecord", kind: "entity" },
        { id: "D003", name: "OrderLine", kind: "line_item", parentEntity: "OrderMaster" },
      ],
      generalizations: [],
      associations: [
        { source: "OrderMaster", target: "OrderRecord", sourceMultiplicity: "1", targetMultiplicity: "*" },
      ],
    };
    expect(DomainModelGenerator.validateLineItemDecomposition(model)).toEqual([]);
  });

  it("does NOT fire when the aggregate has no total-field", () => {
    const model = {
      concepts: [
        { id: "D001", name: "OrderMaster", kind: "entity", attributes: [{ name: "Label", type: "String" }] },
        { id: "D002", name: "OrderRecord", kind: "entity" },
      ],
      generalizations: [],
      associations: [
        { source: "OrderMaster", target: "OrderRecord", sourceMultiplicity: "1", targetMultiplicity: "*" },
      ],
    };
    expect(DomainModelGenerator.validateLineItemDecomposition(model)).toEqual([]);
  });

  it("does NOT fire when there is no one-to-many association from the aggregate", () => {
    const model = {
      concepts: [
        { id: "D001", name: "OrderMaster", kind: "entity", attributes: [{ name: "GrandTotal", type: "Decimal" }] },
        { id: "D002", name: "OrderRecord", kind: "entity" },
      ],
      generalizations: [],
      associations: [
        { source: "OrderMaster", target: "OrderRecord", sourceMultiplicity: "1", targetMultiplicity: "1" },
      ],
    };
    expect(DomainModelGenerator.validateLineItemDecomposition(model)).toEqual([]);
  });

  it("detects total-field via description signal too (name not literal 'total')", () => {
    const model = {
      concepts: [
        { id: "D001", name: "OrderMaster", kind: "entity", attributes: [{ name: "MoneyValue", type: "Number", description: "汇总金额合计" }] },
        { id: "D002", name: "OrderRecord", kind: "entity" },
      ],
      generalizations: [],
      associations: [
        { source: "OrderMaster", target: "OrderRecord", sourceMultiplicity: "1", targetMultiplicity: "1..*" },
      ],
    };
    const issues = DomainModelGenerator.validateLineItemDecomposition(model);
    expect(issues.length).toBeGreaterThan(0);
  });

  // --- 精确化回归（false-positive guard + positive confirm）---
  // TOTAL_NAME_SIGNAL_RE 将 amount 收紧为整名匹配后，下列 *Amount 非总额字段不得触发。
  it("does NOT fire on non-total numeric fields like rebateAmount/paidAmount (false-positive regression)", () => {
    const model = {
      concepts: [
        {
          id: "D001",
          name: "OrderMaster",
          kind: "entity",
          attributes: [{ name: "rebateAmount", type: "Decimal" }],
        },
        { id: "D002", name: "OrderRecord", kind: "entity" },
      ],
      generalizations: [],
      associations: [
        { source: "OrderMaster", target: "OrderRecord", sourceMultiplicity: "1", targetMultiplicity: "*" },
      ],
    };
    expect(DomainModelGenerator.validateLineItemDecomposition(model)).toEqual([]);
  });

  it("does NOT fire on a batch of *Amount non-total numeric fields", () => {
    const model = {
      concepts: [
        {
          id: "D001",
          name: "OrderMaster",
          kind: "entity",
          attributes: [
            { name: "discountAmount", type: "Decimal" },
            { name: "paidAmount", type: "Decimal" },
            { name: "baseAmount", type: "Decimal" },
            { name: "remainingAmount", type: "Decimal" },
            { name: "subAmount", type: "Decimal" },
          ],
        },
        { id: "D002", name: "OrderRecord", kind: "entity" },
      ],
      generalizations: [],
      associations: [
        { source: "OrderMaster", target: "OrderRecord", sourceMultiplicity: "1", targetMultiplicity: "*" },
      ],
    };
    expect(DomainModelGenerator.validateLineItemDecomposition(model)).toEqual([]);
  });

  it("still fires on a genuine totalAmount field (tightening did not break true positives)", () => {
    const model = {
      concepts: [
        {
          id: "D001",
          name: "OrderMaster",
          kind: "entity",
          attributes: [{ name: "totalAmount", type: "Decimal" }],
        },
        { id: "D002", name: "OrderRecord", kind: "entity" },
      ],
      generalizations: [],
      associations: [
        { source: "OrderMaster", target: "OrderRecord", sourceMultiplicity: "1", targetMultiplicity: "*" },
      ],
    };
    const issues = DomainModelGenerator.validateLineItemDecomposition(model);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain("OrderMaster");
  });

  it("still fires on a genuine 总额 (Chinese) field", () => {
    const model = {
      concepts: [
        {
          id: "D001",
          name: "OrderMaster",
          kind: "entity",
          attributes: [{ name: "总额", type: "Decimal" }],
        },
        { id: "D002", name: "OrderRecord", kind: "entity" },
      ],
      generalizations: [],
      associations: [
        { source: "OrderMaster", target: "OrderRecord", sourceMultiplicity: "1", targetMultiplicity: "*" },
      ],
    };
    const issues = DomainModelGenerator.validateLineItemDecomposition(model);
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("DomainModelGenerator.validateEndpointIntegrity (FIX3)", () => {
  it("fires when an association target endpoint does not exist", () => {
    const model = {
      concepts: [{ id: "D001", name: "OrderMaster", kind: "entity" }],
      generalizations: [],
      associations: [{ source: "OrderMaster", target: "GhostService", sourceMultiplicity: "1", targetMultiplicity: "*" }],
    };
    const issues = DomainModelGenerator.validateEndpointIntegrity(model);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.includes("GhostService"))).toBe(true);
  });

  it("fires when an association concept's connects references an undefined concept", () => {
    const model = {
      concepts: [
        { id: "D001", name: "OrderMaster", kind: "entity" },
        { id: "D002", name: "Link", kind: "association", connects: ["OrderMaster", "Phantom"] },
      ],
      generalizations: [],
      associations: [],
    };
    const issues = DomainModelGenerator.validateEndpointIntegrity(model);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.includes("Phantom"))).toBe(true);
  });

  it("fires when a line_item's parentEntity references an undefined concept", () => {
    const model = {
      concepts: [
        { id: "D001", name: "OrderMaster", kind: "entity" },
        { id: "D002", name: "Orphan", kind: "line_item", parentEntity: "Missing" },
      ],
      generalizations: [],
      associations: [],
    };
    const issues = DomainModelGenerator.validateEndpointIntegrity(model);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.includes("Missing"))).toBe(true);
  });

  it("does NOT fire when all endpoints resolve to existing concepts", () => {
    const model = {
      concepts: [
        { id: "D001", name: "OrderMaster", kind: "entity" },
        { id: "D002", name: "OrderRecord", kind: "entity" },
        { id: "D003", name: "Link", kind: "association", connects: ["OrderMaster", "OrderRecord"] },
        { id: "D004", name: "OrderLine", kind: "line_item", parentEntity: "OrderMaster" },
      ],
      generalizations: [],
      associations: [
        { source: "OrderMaster", target: "OrderRecord", sourceMultiplicity: "1", targetMultiplicity: "*" },
      ],
    };
    expect(DomainModelGenerator.validateEndpointIntegrity(model)).toEqual([]);
  });
});

describe("GenerationTool._ruleCheck — domain_model integration", () => {
  // 综合用例：三个校验器都不应触发的“干净模型”（防误报守卫）
  const cleanModel = {
    concepts: [
      { id: "D001", name: "Party", kind: "entity", abstract: true },
      { id: "D002", name: "AlphaUser", kind: "entity" },
      { id: "D003", name: "BetaUser", kind: "entity" },
      { id: "D004", name: "OrderMaster", kind: "entity", attributes: [{ name: "GrandTotal", type: "Decimal" }] },
      { id: "D005", name: "OrderRecord", kind: "entity" },
      { id: "D006", name: "OrderLine", kind: "line_item", parentEntity: "OrderMaster" },
    ],
    generalizations: [{ parent: "Party", children: ["AlphaUser", "BetaUser"] }],
    associations: [
      { source: "OrderMaster", target: "OrderRecord", sourceMultiplicity: "1", targetMultiplicity: "*" },
    ],
  };
  const cleanReq = {
    actors: [
      { name: "AlphaUser", description: "管理后台、配置规则" },
      { name: "BetaUser", description: "提交申请、查看记录" },
    ],
  };

  it("clean model: all three validators return [] via _ruleCheck (false-positive guard)", () => {
    const task = createTask({ id: "dm-clean", type: "domain_model", description: "clean" });
    const issues = GenerationTool._ruleCheck(task, cleanModel, { requirement_json: cleanReq });
    // 仅允许基础结构检查通过（无任何 FIX1/FIX2/FIX3 触发）
    expect(issues.filter((i) => i.includes("泛化") || i.includes("line_item") || i.includes("未定义的概念"))).toEqual([]);
  });

  it("collapsed-actor model: FIX1 surfaces via _ruleCheck", () => {
    const model = {
      concepts: [{ id: "D001", name: "Party", kind: "entity" }],
      generalizations: [],
      associations: [],
    };
    const task = createTask({ id: "dm-collapse", type: "domain_model", description: "collapse" });
    const issues = GenerationTool._ruleCheck(task, model, { requirement_json: cleanReq });
    expect(issues.some((i) => i.includes("泛化") && i.includes("AlphaUser"))).toBe(true);
  });

  it("aggregate-without-lineitem model: FIX2 surfaces via _ruleCheck", () => {
    const model = {
      concepts: [
        { id: "D001", name: "OrderMaster", kind: "entity", attributes: [{ name: "GrandTotal", type: "Decimal" }] },
        { id: "D002", name: "OrderRecord", kind: "entity" },
      ],
      generalizations: [],
      associations: [
        { source: "OrderMaster", target: "OrderRecord", sourceMultiplicity: "1", targetMultiplicity: "*" },
      ],
    };
    const task = createTask({ id: "dm-agg", type: "domain_model", description: "aggregate" });
    const issues = GenerationTool._ruleCheck(task, model, { requirement_json: cleanReq });
    expect(issues.some((i) => i.includes("line_item") && i.includes("OrderMaster"))).toBe(true);
  });

  it("dangling-endpoint model: FIX3 surfaces via _ruleCheck", () => {
    const model = {
      concepts: [{ id: "D001", name: "OrderMaster", kind: "entity" }],
      generalizations: [],
      associations: [
        { source: "OrderMaster", target: "GhostService", sourceMultiplicity: "1", targetMultiplicity: "*" },
      ],
    };
    const task = createTask({ id: "dm-dangling", type: "domain_model", description: "dangling" });
    const issues = GenerationTool._ruleCheck(task, model, { requirement_json: cleanReq });
    expect(issues.some((i) => i.includes("GhostService"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateDomainDesignConsistency — Validator 5 (FIX2)
// Generalization-parent name reconciliation: a kind=domain design class that
// references a generalization PARENT concept (by D-ID via domainRefs) must use
// the SAME name as the domain concept. A divergent alias name is what makes
// the evaluator demand a rename, seeding the dual-parent repair loop. Cutting
// it here stops the BaseUser<->User toggle at its source.
// All synthetic names (Foo/D###-style); structural — no hardcoded names.
// ---------------------------------------------------------------------------

describe("DomainModelGenerator.validateDomainDesignConsistency — parent-name reconciliation (FIX2)", () => {
  it("warns when a domain design class names a generalization parent differently from the concept", () => {
    // Domain concept parent is named "Foo" (D001); the design class calls it
    // "FooAlias" but still references the Foo parent concept via domainRefs.
    const domainModel = {
      concepts: [
        { id: "D001", name: "Foo", kind: "entity", abstract: true },
        { id: "D002", name: "FooChild", kind: "entity" },
      ],
      generalizations: [{ parent: "Foo", children: ["FooChild"] }],
      associations: [],
    };
    const designClasses = [
      { name: "FooAlias", kind: "domain", domainRefs: ["D001"] },
      { name: "FooChild", kind: "domain", domainRefs: ["D002"] },
    ];
    const warnings = DomainModelGenerator.validateDomainDesignConsistency(
      domainModel, designClasses,
    );
    const divergent = warnings.filter((w) => w.includes("FooAlias"));
    expect(divergent.length).toBe(1);
    expect(divergent[0]).toContain("Foo");
    expect(divergent[0]).toContain("名称");
  });

  it("does NOT warn when the parent design class uses the same name as the concept", () => {
    const domainModel = {
      concepts: [
        { id: "D001", name: "Foo", kind: "entity", abstract: true },
        { id: "D002", name: "FooChild", kind: "entity" },
      ],
      generalizations: [{ parent: "Foo", children: ["FooChild"] }],
      associations: [],
    };
    const designClasses = [
      { name: "Foo", kind: "domain", domainRefs: ["D001"] },
      { name: "FooChild", kind: "domain", domainRefs: ["D002"] },
    ];
    const warnings = DomainModelGenerator.validateDomainDesignConsistency(
      domainModel, designClasses,
    );
    // No name-divergence warnings at all (other validators may be silent too).
    expect(warnings.filter((w) => w.includes("名称"))).toEqual([]);
  });

  it("does NOT flag a CHILD design class (child references its own concept, never the parent D-ID)", () => {
    // FooChild references D002 (its own concept), NOT D001 (the parent).
    // The check must only fire for the parent concept itself.
    const domainModel = {
      concepts: [
        { id: "D001", name: "Foo", kind: "entity", abstract: true },
        { id: "D002", name: "FooChild", kind: "entity" },
        { id: "D003", name: "FooOtherChild", kind: "entity" },
      ],
      generalizations: [{ parent: "Foo", children: ["FooChild", "FooOtherChild"] }],
      associations: [],
    };
    const designClasses = [
      { name: "Foo", kind: "domain", domainRefs: ["D001"] },
      { name: "FooChild", kind: "domain", domainRefs: ["D002"] },
      { name: "FooOtherChild", kind: "domain", domainRefs: ["D003"] },
    ];
    const warnings = DomainModelGenerator.validateDomainDesignConsistency(
      domainModel, designClasses,
    );
    expect(warnings.filter((w) => w.includes("名称"))).toEqual([]);
  });

  it("does NOT flag when there are no generalizations", () => {
    const domainModel = {
      concepts: [
        { id: "D001", name: "Foo", kind: "entity" },
        { id: "D002", name: "Bar", kind: "entity" },
      ],
      generalizations: [],
      associations: [],
    };
    const designClasses = [
      { name: "FooAlias", kind: "domain", domainRefs: ["D001"] },
    ];
    const warnings = DomainModelGenerator.validateDomainDesignConsistency(
      domainModel, designClasses,
    );
    expect(warnings.filter((w) => w.includes("名称"))).toEqual([]);
  });
});
