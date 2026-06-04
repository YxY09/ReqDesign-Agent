import { describe, it, expect } from "vitest";
import { RequirementNormalizer } from "../src/shared/normalizer.js";

describe("RequirementNormalizer", () => {
  // ----------------------------------------------------------------
  // 1. Shell entity removal
  // ----------------------------------------------------------------
  it("removes entity with only id+status if it matches an actor", () => {
    const input = {
      actors: [
        { name: "Customer", description: "顾客" },
        { name: "Admin", description: "管理员" },
      ],
      entities: [
        { name: "User", attributes: [{ name: "userId", type: "Long", description: "ID" }], relationships: [] },
        { name: "Customer", attributes: [{ name: "id", type: "Long", description: "Customer 唯一标识" }, { name: "status", type: "String", description: "Customer 状态" }], relationships: [] },
        { name: "Admin", attributes: [{ name: "id", type: "Long", description: "Admin 唯一标识" }, { name: "status", type: "String", description: "Admin 状态" }], relationships: [] },
        { name: "Order", attributes: [{ name: "orderId", type: "Long", description: "订单ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);

    const entities = result.entities as Array<Record<string, unknown>>;
    const names = entities.map(e => e.name);
    expect(names).not.toContain("Customer");
    expect(names).not.toContain("Admin");
    expect(names).toContain("User");
    expect(names).toContain("Order");

    // User should have a role attribute
    const user = entities.find(e => e.name === "User")!;
    const attrs = user.attributes as Array<Record<string, string>>;
    const roleAttr = attrs.find(a => a.name === "role");
    expect(roleAttr).toBeDefined();
    expect(roleAttr!.description).toContain("Customer");
    expect(roleAttr!.description).toContain("Admin");
  });

  it("keeps entity with id+status+extra attributes", () => {
    const input = {
      actors: [{ name: "Merchant", description: "商家" }],
      entities: [
        { name: "Merchant", attributes: [{ name: "id", type: "Long", description: "ID" }, { name: "status", type: "String", description: "状态" }, { name: "shopName", type: "String", description: "店铺名" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const names = (result.entities as Array<Record<string, unknown>>).map(e => e.name);
    expect(names).toContain("Merchant");
  });

  // ----------------------------------------------------------------
  // 2. Actor canonicalization
  // ----------------------------------------------------------------
  it("does not merge Administrator and Admin (different words)", () => {
    const input = {
      actors: [
        { name: "Administrator", description: "管理员" },
        { name: "Admin", description: "管理员" },
      ],
      entities: [
        { name: "User", attributes: [{ name: "userId", type: "Long", description: "ID" }], relationships: [] },
      ],
      functions: [
        { id: "F001", name: "Test", related_actors: ["Administrator", "Admin"] },
      ],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);

    // Administrator and Admin are different words, not case variants
    const actors = result.actors as Array<Record<string, string>>;
    expect(actors.length).toBe(2);
  });

  it("deduplicates actors with exact case-insensitive match", () => {
    const input = {
      actors: [
        { name: "Customer", description: "顾客" },
        { name: "customer", description: "顾客" },
      ],
      entities: [],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const actors = result.actors as Array<Record<string, string>>;
    expect(actors.length).toBe(1);
    expect(actors[0].name).toBe("Customer");
  });

  it("deduplicates string-array actors case-insensitively", () => {
    const input = {
      actors: ["Customer", "Admin", "customer", "admin"],
      entities: [],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const actors = result.actors as string[];
    expect(actors.length).toBe(2);
    expect(actors).toContain("Customer");
    expect(actors).toContain("Admin");
  });

  it("filters empty string actor names during canonicalization", () => {
    const input = {
      actors: ["Customer", "", "  ", "Admin"],
      entities: [],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const actors = result.actors as string[];
    expect(actors.length).toBe(2);
    expect(actors).not.toContain("");
    expect(actors).not.toContain("  ");
  });

  it("renames actor references in functions when deduplication occurs", () => {
    const input = {
      actors: [
        { name: "Customer", description: "顾客" },
        { name: "customer", description: "顾客" },
      ],
      entities: [],
      functions: [
        { id: "F001", name: "PlaceOrder", related_actors: ["customer"] },
      ],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const fn = (result.functions as Array<Record<string, unknown>>)[0];
    const related = fn.related_actors as string[];
    expect(related).toEqual(["Customer"]); // renamed to canonical form
  });

  it("keeps single actor unchanged", () => {
    const input = {
      actors: [{ name: "Solo", description: "唯一" }],
      entities: [],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const actors = result.actors as Array<Record<string, unknown>>;
    expect(actors.length).toBe(1);
  });

  // ----------------------------------------------------------------
  // 3. Acronym normalization
  // ----------------------------------------------------------------
  it("converts SKU to Sku, leaves XMLTag unchanged", () => {
    const input = {
      actors: [],
      entities: [
        { name: "SKU", attributes: [{ name: "skuId", type: "Long", description: "ID" }], relationships: [] },
        { name: "XMLTag", attributes: [{ name: "tagId", type: "String", description: "ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);

    const entities = result.entities as Array<Record<string, unknown>>;
    const names = entities.map(e => e.name);
    expect(names).toContain("Sku");
    expect(names).toContain("XMLTag"); // mixed case left as-is
    expect(names).not.toContain("SKU");
  });

  it("normalizes 2-letter acronyms like API to Api", () => {
    const input = {
      actors: [],
      entities: [
        { name: "API", attributes: [{ name: "apiId", type: "String", description: "ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const entities = result.entities as Array<Record<string, unknown>>;
    const names = entities.map(e => e.name);
    expect(names).toContain("Api");
    expect(names).not.toContain("API");
  });

  it("normalizes acronyms in actor names too", () => {
    const input = {
      actors: [{ name: "VIP", description: "重要用户" }],
      entities: [],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const actors = result.actors as Array<Record<string, unknown>>;
    expect(actors[0].name).toBe("Vip");
  });

  it("normalizes acronyms in relationship targets", () => {
    const input = {
      actors: [],
      entities: [
        { name: "Order", attributes: [{ name: "orderId", type: "Long", description: "ID" }], relationships: [{ target: "SKU", type: "many-to-one", description: "商品" }] },
        { name: "SKU", attributes: [{ name: "skuId", type: "Long", description: "ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const order = (result.entities as Array<Record<string, unknown>>).find(e => e.name === "Order")!;
    const rels = order.relationships as Array<Record<string, unknown>>;
    // "SKU" entity name was also normalized to "Sku", so target should match
    expect(rels[0].target).toBe("Sku");
  });

  it("leaves already-PascalCase names untouched", () => {
    const input = {
      actors: [],
      entities: [
        { name: "OrderItem", attributes: [{ name: "id", type: "Long", description: "ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const entities = result.entities as Array<Record<string, unknown>>;
    expect(entities[0].name).toBe("OrderItem");
  });

  // ----------------------------------------------------------------
  // 4. Constraint dedup
  // ----------------------------------------------------------------
  it("deduplicates constraints with same description", () => {
    const input = {
      actors: [],
      entities: [],
      functions: [],
      constraints: [
        { id: "C001", description: "订单金额不超过99999元", related_functions: [] },
        { id: "C005", description: "订单金额不超过99999元", related_functions: [] },
        { id: "C002", description: "库存不足时不可下单", related_functions: [] },
      ],
    };

    const result = RequirementNormalizer.normalize(input);

    const constraints = result.constraints as Array<Record<string, unknown>>;
    expect(constraints.length).toBe(2);
  });

  it("deduplicates constraints with same description but different whitespace", () => {
    const input = {
      actors: [],
      entities: [],
      functions: [],
      constraints: [
        { id: "C001", description: "订单金额  不超过  99999元", related_functions: [] },
        { id: "C005", description: "   订单金额 不超过 99999元  ", related_functions: [] },
      ],
    };

    const result = RequirementNormalizer.normalize(input);
    const constraints = result.constraints as Array<Record<string, unknown>>;
    expect(constraints.length).toBe(1);
  });

  it("no-ops on single constraint", () => {
    const input = {
      actors: [],
      entities: [],
      functions: [],
      constraints: [
        { id: "C001", description: "唯一约束", related_functions: [] },
      ],
    };

    const result = RequirementNormalizer.normalize(input);
    const constraints = result.constraints as Array<Record<string, unknown>>;
    expect(constraints.length).toBe(1);
  });

  it("keeps constraints with empty descriptions untouched", () => {
    const input = {
      actors: [],
      entities: [],
      functions: [],
      constraints: [
        { id: "C001", description: "", related_functions: [] },
        { id: "C002", description: "", related_functions: [] },
      ],
    };

    const result = RequirementNormalizer.normalize(input);
    const constraints = result.constraints as Array<Record<string, unknown>>;
    // Empty descriptions bypass dedup, both kept
    expect(constraints.length).toBe(2);
  });

  // ----------------------------------------------------------------
  // 5. User.role
  // ----------------------------------------------------------------
  it("adds role attribute to User with all actor names", () => {
    const input = {
      actors: [
        { name: "Customer", description: "顾客" },
        { name: "Merchant", description: "商家" },
      ],
      entities: [
        { name: "User", attributes: [{ name: "userId", type: "Long", description: "ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);

    const user = (result.entities as Array<Record<string, unknown>>).find(e => e.name === "User")!;
    const attrs = user.attributes as Array<Record<string, string>>;
    const roleAttr = attrs.find(a => a.name === "role");
    expect(roleAttr).toBeDefined();
    expect(roleAttr!.description).toContain("Customer");
    expect(roleAttr!.description).toContain("Merchant");
  });

  it("handles UserAccount as User entity", () => {
    const input = {
      actors: [{ name: "Producer", description: "生产者" }],
      entities: [
        { name: "UserAccount", attributes: [{ name: "userId", type: "String", description: "ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);

    const user = (result.entities as Array<Record<string, unknown>>).find(e => (e.name as string).toLowerCase().includes("user"))!;
    const attrs = user.attributes as Array<Record<string, string>>;
    const roleAttr = attrs.find(a => a.name === "role");
    expect(roleAttr).toBeDefined();
    expect(roleAttr!.description).toContain("Producer");
  });

  it("no-ops when no User entity exists", () => {
    const input = {
      actors: [{ name: "Customer", description: "顾客" }],
      entities: [
        { name: "Order", attributes: [{ name: "orderId", type: "Long", description: "ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const entities = result.entities as Array<Record<string, unknown>>;
    // No User entity, so role should not be added to anything
    const order = entities.find(e => e.name === "Order")!;
    const attrs = order.attributes as Array<Record<string, unknown>>;
    expect(attrs.some(a => a.name === "role")).toBe(false);
  });

  it("does not duplicate role attribute if already exists", () => {
    const input = {
      actors: [{ name: "Customer", description: "顾客" }],
      entities: [
        {
          name: "User",
          attributes: [
            { name: "userId", type: "Long", description: "ID" },
            { name: "role", type: "String", description: "角色" },
          ],
          relationships: [],
        },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const user = (result.entities as Array<Record<string, unknown>>).find(e => e.name === "User")!;
    const attrs = user.attributes as Array<Record<string, unknown>>;
    const roleAttrs = attrs.filter(a => a.name === "role");
    expect(roleAttrs.length).toBe(1);
  });

  it("updates role description when actors change", () => {
    const input = {
      actors: [{ name: "Customer", description: "顾客" }, { name: "Admin", description: "管理员" }],
      entities: [
        {
          name: "User",
          attributes: [
            { name: "userId", type: "Long", description: "ID" },
            { name: "role", type: "String", description: "旧描述" },
          ],
          relationships: [],
        },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const user = (result.entities as Array<Record<string, unknown>>).find(e => e.name === "User")!;
    const roleAttr = (user.attributes as Array<Record<string, unknown>>).find(a => a.name === "role");
    expect(roleAttr!.description).toBe("角色: Customer、Admin");
  });

  it("ensures function detail arrays exist", () => {
    const input = {
      actors: [],
      entities: [],
      functions: [
        { id: "F001", name: "CreateOrder", description: "创建订单" },
      ],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const fn = (result.functions as Array<Record<string, unknown>>)[0];
    expect(fn.sub_capabilities).toEqual([]);
    expect(fn.acceptance_criteria).toEqual([]);
  });

  it("removes unsupported record entities when source has no persistence evidence", () => {
    const input = {
      actors: [{ name: "User", description: "用户" }],
      entities: [
        { name: "Calculator", attributes: [{ name: "id", type: "Long", description: "ID" }], relationships: [{ target: "CalculationRecord", type: "one-to-many", description: "生成记录" }] },
        { name: "CalculationRecord", attributes: [{ name: "recordId", type: "Long", description: "ID" }, { name: "result", type: "Decimal", description: "结果" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    RequirementNormalizer.normalize(input);
    const result = RequirementNormalizer.normalizeAgainstSource(input, "用户输入两个数字，系统返回它们的和。除数不能为零。");
    const entities = result.entities as Array<Record<string, unknown>>;
    expect(entities.map(e => e.name)).toEqual(["Calculator"]);
    expect((entities[0].relationships as unknown[]).length).toBe(0);
  });

  it("keeps record entities when source mentions records", () => {
    const input = {
      actors: [],
      entities: [
        { name: "BorrowRecord", attributes: [{ name: "recordId", type: "Long", description: "ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalizeAgainstSource(input, "系统需要保存借阅记录并支持查询历史。");
    const entities = result.entities as Array<Record<string, unknown>>;
    expect(entities.map(e => e.name)).toContain("BorrowRecord");
  });

  it("promotes order item from product detail source text", () => {
    const input = {
      actors: [],
      entities: [
        { name: "Order", attributes: [{ name: "orderId", type: "Long", description: "订单ID" }], relationships: [{ target: "Product", type: "many-to-many", description: "订单包含多个商品" }] },
        { name: "Product", attributes: [{ name: "productId", type: "Long", description: "商品ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    RequirementNormalizer.normalize(input);
    const result = RequirementNormalizer.normalizeAgainstSource(input, "订单包含商品明细，商品明细记录购买数量和下单价格。");
    const entities = result.entities as Array<Record<string, unknown>>;
    const names = entities.map(e => e.name);
    expect(names).toContain("OrderItem");

    const order = entities.find(e => e.name === "Order")!;
    const rels = order.relationships as Array<Record<string, unknown>>;
    expect(rels.some(r => r.target === "OrderItem" && r.type === "one-to-many")).toBe(true);
    expect(rels.some(r => r.target === "Product" && r.type === "many-to-many")).toBe(false);
  });

  it("promotes process records when business processes have their own lifecycle data", () => {
    const input = {
      actors: [],
      entities: [
        { name: "Case", attributes: [{ name: "caseId", type: "Long", description: "案件ID" }], relationships: [] },
        { name: "Complaint", attributes: [{ name: "complaintId", type: "Long", description: "投诉ID" }], relationships: [] },
        { name: "Document", attributes: [{ name: "documentId", type: "Long", description: "文档ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
      business_processes: [
        {
          name: "CaseRegistration",
          steps: ["Register complaint", "Assign case number", "Update registration status"],
          actors: ["Citizen"],
        },
        {
          name: "CaseInvestigation",
          steps: ["Gather evidence", "Write investigation report", "Record conclusion"],
          actors: ["Officer"],
        },
        {
          name: "CaseProsecution",
          steps: ["Prepare charges", "Track court dates", "Update prosecution status"],
          actors: ["Prosecutor"],
        },
      ],
    };

    RequirementNormalizer.normalize(input);
    const result = RequirementNormalizer.normalizeAgainstSource(
      input,
      "CaseRegistration has a registration number, timestamp, and status. CaseInvestigation stores evidence, report, conclusion, and status. CaseProsecution stores court dates, judgment result, sentence, and status.",
    );

    const entities = result.entities as Array<Record<string, unknown>>;
    const names = entities.map(e => e.name);
    expect(names).toContain("CaseRegistration");
    expect(names).toContain("CaseInvestigation");
    expect(names).toContain("CaseProsecution");

    const registration = entities.find(e => e.name === "CaseRegistration")!;
    expect(registration.entityKind).toBe("process_record");
    const attrs = registration.attributes as Array<Record<string, unknown>>;
    expect(attrs.some(a => a.name === "businessNo")).toBe(true);
    expect(attrs.some(a => a.name === "status")).toBe(true);
    const rels = registration.relationships as Array<Record<string, unknown>>;
    expect(rels.some(r => r.target === "Case" && r.type === "many-to-one")).toBe(true);
    expect(rels.some(r => r.target === "Complaint" && r.type === "many-to-one")).toBe(true);

    const caseEntity = entities.find(e => e.name === "Case")!;
    const caseRels = caseEntity.relationships as Array<Record<string, unknown>>;
    expect(caseRels.some(r => r.target === "CaseRegistration" && r.type === "one-to-many")).toBe(true);
    expect(caseRels.some(r => r.target === "CaseInvestigation" && r.type === "one-to-many")).toBe(true);
    expect(caseRels.some(r => r.target === "CaseProsecution" && r.type === "one-to-many")).toBe(true);
  });

  it("does not promote ordinary processes without relationship-entity evidence", () => {
    const input = {
      actors: [],
      entities: [
        { name: "Case", attributes: [{ name: "caseId", type: "Long", description: "案件ID" }], relationships: [] },
        { name: "SearchResult", attributes: [{ name: "resultId", type: "Long", description: "结果ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
      business_processes: [
        {
          name: "SearchCase",
          steps: ["Enter keyword", "Execute search", "Display matching cases"],
          actors: ["Officer"],
        },
      ],
    };

    RequirementNormalizer.normalize(input);
    const result = RequirementNormalizer.normalizeAgainstSource(
      input,
      "The system allows users to search cases and display matching results.",
    );
    const names = (result.entities as Array<Record<string, unknown>>).map(e => e.name);
    expect(names).not.toContain("SearchCase");
  });

  // ----------------------------------------------------------------
  // Edge cases
  // ----------------------------------------------------------------
  it("handles empty input gracefully", () => {
    const result = RequirementNormalizer.normalize({});
    expect(result).toBeDefined();
    expect(Object.keys(result).length).toBe(0);
  });

  it("handles null/undefined gracefully", () => {
    const result = RequirementNormalizer.normalize(null as any);
    expect(result).toBeNull();
  });

  it("handles non-object input gracefully (number, string, boolean)", () => {
    expect(RequirementNormalizer.normalize(42 as any)).toBe(42);
    expect(RequirementNormalizer.normalize("hello" as any)).toBe("hello");
    expect(RequirementNormalizer.normalize(true as any)).toBe(true);
  });

  it("no-ops when no actors match entities", () => {
    const input = {
      actors: [{ name: "Player", description: "玩家" }],
      entities: [
        { name: "Block", attributes: [{ name: "id", type: "Long", description: "ID" }, { name: "status", type: "String", description: "状态" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const names = (result.entities as Array<Record<string, unknown>>).map(e => e.name);
    // Block has id+status but is NOT an actor, so it should NOT be removed
    expect(names).toContain("Block");
  });
});

// ---------------------------------------------------------------------------
// Entity splitting
// ---------------------------------------------------------------------------

describe("RequirementNormalizer — entity splitting", () => {
  it("splits List<OrderItem> into independent entity", () => {
    const input = {
      actors: [],
      entities: [
        {
          name: "ParentEntity",
          attributes: [
            { name: "parentId", type: "Long", description: "主键ID" },
            { name: "childItems", type: "List<ChildItem>", description: "子项列表" },
          ],
          relationships: [],
        },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const entities = result.entities as Array<Record<string, unknown>>;
    const names = entities.map(e => e.name);

    // ChildItem should be created from List<ChildItem>
    expect(names).toContain("ChildItem");

    // ParentEntity.childItems type should change to List<Long>
    const parent = entities.find(e => e.name === "ParentEntity")!;
    const childAttr = (parent.attributes as Array<Record<string, unknown>>).find(a => a.name === "childItems");
    expect(childAttr!.type).toBe("List<Long>");

    // ParentEntity should have relationship to ChildItem
    const rels = parent.relationships as Array<Record<string, unknown>>;
    expect(rels.some(r => r.target === "ChildItem")).toBe(true);
  });

  it("does not split Object type (name derivation too unreliable)", () => {
    const input = {
      actors: [],
      entities: [
        {
          name: "ParentEntity",
          attributes: [
            { name: "parentId", type: "Long", description: "主键ID" },
            { name: "nestedObject", type: "Object", description: "内嵌对象" },
          ],
          relationships: [],
        },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const entities = result.entities as Array<Record<string, unknown>>;
    const names = entities.map(e => e.name);

    // Object types are NOT split — name derivation is too unreliable
    expect(names).not.toContain("NestedObject");
    expect(names).toEqual(["ParentEntity"]);

    // ParentEntity.nestedObject type should remain Object
    const parent = entities.find(e => e.name === "ParentEntity")!;
    const objAttr = (parent.attributes as Array<Record<string, unknown>>).find(a => a.name === "nestedObject");
    expect(objAttr!.type).toBe("Object");
  });

  it("does not split if entity already exists", () => {
    const input = {
      actors: [],
      entities: [
        {
          name: "ParentEntity",
          attributes: [
            { name: "parentId", type: "Long", description: "主键ID" },
            { name: "childItems", type: "List<ChildItem>", description: "子项列表" },
          ],
          relationships: [],
        },
        {
          name: "ChildItem",
          attributes: [{ name: "id", type: "Long", description: "ID" }],
          relationships: [],
        },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const entities = result.entities as Array<Record<string, unknown>>;
    const names = entities.map(e => e.name);

    // ChildItem should appear exactly once
    expect(names.filter(n => n === "ChildItem").length).toBe(1);
  });

  it("does not split List<primitive> like List<String>", () => {
    const input = {
      actors: [],
      entities: [
        {
          name: "ParentEntity",
          attributes: [
            { name: "parentId", type: "Long", description: "主键ID" },
            { name: "tags", type: "List<String>", description: "标签列表" },
          ],
          relationships: [],
        },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const entities = result.entities as Array<Record<string, unknown>>;
    // List<String> should NOT create a "String" entity
    expect(entities.length).toBe(1);
    expect(entities[0].name).toBe("ParentEntity");
  });

  it("no-ops on empty entities array during split", () => {
    const input = {
      actors: [],
      entities: [],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const entities = result.entities as Array<Record<string, unknown>>;
    expect(entities.length).toBe(0);
  });

  it("handles entities with no attributes during split", () => {
    const input = {
      actors: [],
      entities: [
        { name: "BareEntity", attributes: [], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const entities = result.entities as Array<Record<string, unknown>>;
    expect(entities.length).toBe(1);
    expect(entities[0].name).toBe("BareEntity");
  });

  it("does not split List<Long> (primitive wrapper type)", () => {
    const input = {
      actors: [],
      entities: [
        {
          name: "ParentEntity",
          attributes: [
            { name: "parentId", type: "Long", description: "主键ID" },
            { name: "ids", type: "List<Long>", description: "ID列表" },
          ],
          relationships: [],
        },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const entities = result.entities as Array<Record<string, unknown>>;
    expect(entities.length).toBe(1); // no new entity for Long
  });

  it("splits multiple List<X> attributes in one entity", () => {
    const input = {
      actors: [],
      entities: [
        {
          name: "ParentEntity",
          attributes: [
            { name: "parentId", type: "Long", description: "主键ID" },
            { name: "childItems", type: "List<ChildItem>", description: "子项列表" },
            { name: "attachments", type: "List<Attachment>", description: "附件列表" },
          ],
          relationships: [],
        },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const entities = result.entities as Array<Record<string, unknown>>;
    const names = entities.map(e => e.name);
    expect(names).toContain("ChildItem");
    expect(names).toContain("Attachment");
    expect(entities.length).toBe(3); // ParentEntity + ChildItem + Attachment
  });

  // ----------------------------------------------------------------
  // Shell entity edge cases
  // ----------------------------------------------------------------
  it("removes shell entity with only a single id attribute", () => {
    const input = {
      actors: [{ name: "Operator", description: "操作员" }],
      entities: [
        { name: "Operator", attributes: [{ name: "id", type: "Long", description: "Operator 唯一标识" }], relationships: [] },
        { name: "Order", attributes: [{ name: "orderId", type: "Long", description: "订单ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const entities = result.entities as Array<Record<string, unknown>>;
    const names = entities.map(e => e.name);
    expect(names).not.toContain("Operator");
    expect(names).toContain("Order");
  });

  it("keeps shell entity with relationships even if only id+status", () => {
    const input = {
      actors: [{ name: "Admin", description: "管理员" }],
      entities: [
        {
          name: "Admin",
          attributes: [{ name: "id", type: "Long", description: "ID" }, { name: "status", type: "String", description: "状态" }],
          relationships: [{ target: "Department", type: "many-to-one", description: "所属部门" }],
        },
        { name: "Department", attributes: [{ name: "deptId", type: "Long", description: "部门ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const entities = result.entities as Array<Record<string, unknown>>;
    const names = entities.map(e => e.name);
    // Has relationships → NOT a shell entity → kept
    expect(names).toContain("Admin");
  });

  it("removes actor entity whose only attr ends with 'id' like accountId (shell)", () => {
    const input = {
      actors: [{ name: "Viewer", description: "游客" }],
      entities: [
        { name: "Viewer", attributes: [{ name: "accountId", type: "Long", description: "账号ID" }], relationships: [] },
      ],
      functions: [],
      constraints: [],
    };

    const result = RequirementNormalizer.normalize(input);
    const entities = result.entities as Array<Record<string, unknown>>;
    const names = entities.map(e => e.name);
    // accountId ends with "id" → matches shell check → removed (it's an actor with ≤2 attrs all like id/status/*id)
    // But wait: accountId is one attr, ends with "id", no relationships → shell
    expect(names).not.toContain("Viewer");
  });
});
