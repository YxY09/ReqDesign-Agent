import { describe, it, expect } from "vitest";
import { RequirementNormalizer } from "../src/tools/normalizer.js";

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

  // ----------------------------------------------------------------
  // Edge cases
  // ----------------------------------------------------------------
  it("handles empty input gracefully", () => {
    const result = RequirementNormalizer.normalize({});
    expect(result).toBeDefined();
  });

  it("handles null/undefined gracefully", () => {
    const result = RequirementNormalizer.normalize(null as any);
    expect(result).toBeNull();
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
          name: "Order",
          attributes: [
            { name: "orderId", type: "Long", description: "订单ID" },
            { name: "orderItems", type: "List<OrderItem>", description: "商品明细" },
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

    // OrderItem should be created
    expect(names).toContain("OrderItem");

    // Order.orderItems type should change to List<Long>
    const order = entities.find(e => e.name === "Order")!;
    const orderItemsAttr = (order.attributes as Array<Record<string, unknown>>).find(a => a.name === "orderItems");
    expect(orderItemsAttr!.type).toBe("List<Long>");

    // Order should have relationship to OrderItem
    const rels = order.relationships as Array<Record<string, unknown>>;
    expect(rels.some(r => r.target === "OrderItem")).toBe(true);
  });

  it("splits Object type into independent entity", () => {
    const input = {
      actors: [],
      entities: [
        {
          name: "Order",
          attributes: [
            { name: "orderId", type: "Long", description: "订单ID" },
            { name: "paymentInfo", type: "Object", description: "支付信息" },
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

    // Payment should be created (paymentInfo stripped of 'Info' suffix)
    expect(names).toContain("Payment");

    // Order.paymentInfo type should change to Long
    const order = entities.find(e => e.name === "Order")!;
    const paymentAttr = (order.attributes as Array<Record<string, unknown>>).find(a => a.name === "paymentInfo");
    expect(paymentAttr!.type).toBe("Long");
  });

  it("does not split if entity already exists", () => {
    const input = {
      actors: [],
      entities: [
        {
          name: "Order",
          attributes: [
            { name: "orderId", type: "Long", description: "订单ID" },
            { name: "orderItems", type: "List<OrderItem>", description: "商品明细" },
          ],
          relationships: [],
        },
        {
          name: "OrderItem",
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

    // OrderItem should appear exactly once
    expect(names.filter(n => n === "OrderItem").length).toBe(1);
  });
});
