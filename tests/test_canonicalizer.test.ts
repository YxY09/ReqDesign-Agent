import { describe, it, expect } from "vitest";
import { canonicalizeAndLink } from "../src/shared/canonicalizer.js";

describe("canonicalizeAndLink", () => {
  // ----------------------------------------------------------------
  // 1. Functions canonicalization
  // ----------------------------------------------------------------
  it("assigns FUN_UPPER_SNAKE canonicalId while preserving source order for new displayIds", () => {
    const merged: Record<string, unknown> = {
      functions: [
        { id: "temp_2", name: "SearchCase", description: "Search for cases" },
        { id: "temp_1", name: "RegisterComplaint", description: "Register a complaint" },
      ],
    };

    const maps = canonicalizeAndLink(merged);

    const fns = merged.functions as Array<Record<string, unknown>>;
    expect(fns[0].id).toBe("FUN_SEARCH_CASE");
    expect(fns[0].displayId).toBe("F001");
    expect(fns[1].id).toBe("FUN_REGISTER_COMPLAINT");
    expect(fns[1].displayId).toBe("F002");

    // Maps should have oldId → canonicalId and name → canonicalId
    expect(maps.functionMap.get("temp_1")).toBe("FUN_REGISTER_COMPLAINT");
    expect(maps.functionMap.get("temp_2")).toBe("FUN_SEARCH_CASE");
    expect(maps.functionMap.get("SearchCase")).toBe("FUN_SEARCH_CASE");
    expect(maps.functionMap.get("RegisterComplaint")).toBe("FUN_REGISTER_COMPLAINT");
  });

  it("preserves explicit source function display IDs instead of re-sorting and renumbering", () => {
    const merged: Record<string, unknown> = {
      functions: [
        { id: "F001", name: "UserRegistrationLogin", description: "用户注册与登录" },
        { id: "F007", name: "ApplyRefundReturn", description: "申请退款/退货" },
        { id: "F002", name: "BrowseProducts", description: "商品浏览" },
      ],
    };

    canonicalizeAndLink(merged);

    const fns = merged.functions as Array<Record<string, unknown>>;
    expect(fns.map((f) => f.displayId)).toEqual(["F001", "F007", "F002"]);
    expect(fns[0]).toMatchObject({
      id: "FUN_USER_REGISTRATION_LOGIN",
      displayId: "F001",
      description: "用户注册与登录",
    });
    expect(fns[1]).toMatchObject({
      id: "FUN_APPLY_REFUND_RETURN",
      displayId: "F007",
      description: "申请退款/退货",
    });
  });

  // ----------------------------------------------------------------
  // 2. Constraints canonicalization
  // ----------------------------------------------------------------
  it("assigns CON_ prefixed canonicalId and C001 displayId to constraints", () => {
    const merged: Record<string, unknown> = {
      constraints: [
        { id: "c_old_1", description: "Audit trail data cannot be modified or deleted" },
        { id: "c_old_2", description: "Search response time should be under 8 seconds" },
      ],
    };

    const maps = canonicalizeAndLink(merged);

    const constraints = merged.constraints as Array<Record<string, unknown>>;
    // Sorted alphabetically by description
    expect(constraints.length).toBe(2);
    expect(constraints[0].id).toMatch(/^CON_/);
    expect(constraints[0].displayId).toBe("C001");
    expect(constraints[1].id).toMatch(/^CON_/);
    expect(constraints[1].displayId).toBe("C002");

    expect(maps.constraintMap.get("c_old_1")).toBe(constraints[0].id);
    expect(maps.constraintMap.get("c_old_2")).toBe(constraints[1].id);
  });

  it("preserves explicit source constraint display IDs", () => {
    const merged: Record<string, unknown> = {
      constraints: [
        { id: "C013", description: "库存预警值为10件" },
        { id: "C002", description: "支付超时自动取消订单" },
      ],
    };

    canonicalizeAndLink(merged);

    const constraints = merged.constraints as Array<Record<string, unknown>>;
    expect(constraints.map((c) => c.displayId)).toEqual(["C013", "C002"]);
  });

  // ----------------------------------------------------------------
  // 3. Exceptions canonicalization
  // ----------------------------------------------------------------
  it("assigns EXC_ prefixed canonicalId and X001 displayId to exceptions", () => {
    const merged: Record<string, unknown> = {
      exceptions: [
        { id: "x_old_1", description: "Case not found in database" },
        { id: "x_old_2", description: "Database connection timeout" },
      ],
    };

    const maps = canonicalizeAndLink(merged);

    const exceptions = merged.exceptions as Array<Record<string, unknown>>;
    expect(exceptions.length).toBe(2);
    expect(exceptions[0].id).toMatch(/^EXC_/);
    expect(exceptions[0].displayId).toBe("X001");
    expect(exceptions[1].id).toMatch(/^EXC_/);
    expect(exceptions[1].displayId).toBe("X002");

    expect(maps.exceptionMap.get("x_old_1")).toBe(exceptions[0].id);
    expect(maps.exceptionMap.get("x_old_2")).toBe(exceptions[1].id);
  });

  it("preserves explicit source exception display IDs", () => {
    const merged: Record<string, unknown> = {
      exceptions: [
        { id: "X006", description: "支付失败" },
        { id: "X001", description: "并发超卖" },
      ],
    };

    canonicalizeAndLink(merged);

    const exceptions = merged.exceptions as Array<Record<string, unknown>>;
    expect(exceptions.map((x) => x.displayId)).toEqual(["X006", "X001"]);
  });

  // ----------------------------------------------------------------
  // 4. Reference resolution: constraint.related_functions
  // ----------------------------------------------------------------
  it("resolves constraint related_functions from old IDs to canonical IDs", () => {
    const merged: Record<string, unknown> = {
      functions: [
        { id: "old_fn", name: "SearchCase", description: "Search" },
      ],
      constraints: [
        {
          id: "old_con",
          description: "Must be fast",
          related_functions: ["old_fn"],
        },
      ],
    };

    canonicalizeAndLink(merged);

    const constraints = merged.constraints as Array<Record<string, unknown>>;
    const relatedFns = constraints[0].related_functions as string[];
    expect(relatedFns[0]).toBe("FUN_SEARCH_CASE");
  });

  // ----------------------------------------------------------------
  // 5. Reference resolution: exception.related_functions and related_constraints
  // ----------------------------------------------------------------
  it("resolves exception related_functions and related_constraints", () => {
    const merged: Record<string, unknown> = {
      functions: [
        { id: "fn_a", name: "SearchCase", description: "Search" },
      ],
      constraints: [
        { id: "con_a", description: "Must be fast" },
      ],
      exceptions: [
        {
          id: "exc_a",
          description: "Timeout error",
          related_functions: ["fn_a"],
          related_constraints: ["con_a"],
        },
      ],
    };

    canonicalizeAndLink(merged);

    const exceptions = merged.exceptions as Array<Record<string, unknown>>;
    const exc = exceptions[0];
    expect((exc.related_functions as string[])[0]).toBe("FUN_SEARCH_CASE");
    // con_a's canonicalId will be CON_ + hash of "Must be fast"
    const resolvedCon = (exc.related_constraints as string[])[0];
    expect(resolvedCon).toMatch(/^CON_/);
  });

  // ----------------------------------------------------------------
  // 6. Reference resolution: NFR related_constraints
  // ----------------------------------------------------------------
  it("resolves NFR related_constraints from old IDs to canonical IDs", () => {
    const merged: Record<string, unknown> = {
      constraints: [
        { id: "c1", description: "Response time under 5 seconds" },
      ],
      non_functional_requirements: [
        {
          category: "Performance",
          related_constraints: ["c1"],
        },
      ],
    };

    canonicalizeAndLink(merged);

    const nfrs = merged.non_functional_requirements as Array<Record<string, unknown>>;
    const related = nfrs[0].related_constraints as string[];
    expect(related[0]).toMatch(/^CON_/);
  });

  // ----------------------------------------------------------------
  // 7. Empty / missing arrays
  // ----------------------------------------------------------------
  it("handles empty merged object gracefully", () => {
    const merged: Record<string, unknown> = {};

    const maps = canonicalizeAndLink(merged);

    expect(maps.functionMap.size).toBe(0);
    expect(maps.constraintMap.size).toBe(0);
    expect(maps.exceptionMap.size).toBe(0);
  });

  // ----------------------------------------------------------------
  // 8. Chinese text constraint IDs use hash
  // ----------------------------------------------------------------
  it("generates hash-based canonicalId for Chinese text constraints", () => {
    const merged: Record<string, unknown> = {
      constraints: [
        { id: "c1", description: "审计跟踪数据不可修改或删除" },
      ],
    };

    canonicalizeAndLink(merged);

    const constraints = merged.constraints as Array<Record<string, unknown>>;
    expect(constraints[0].id).toMatch(/^CON_[A-Z0-9]{8}$/);
  });

  // ----------------------------------------------------------------
  // 9. Unresolved references kept as-is
  // ----------------------------------------------------------------
  it("keeps unresolved references unchanged", () => {
    const merged: Record<string, unknown> = {
      constraints: [
        {
          id: "c1",
          description: "Some constraint",
          related_functions: ["nonexistent_fn"],
        },
      ],
    };

    canonicalizeAndLink(merged);

    const constraints = merged.constraints as Array<Record<string, unknown>>;
    expect((constraints[0].related_functions as string[])[0]).toBe("nonexistent_fn");
  });

  // ----------------------------------------------------------------
  // 10. Duplicate canonicalId deduplication
  // ----------------------------------------------------------------
  it("deduplicates identical canonicalIds by appending suffixes", () => {
    const merged: Record<string, unknown> = {
      constraints: [
        { id: "c1", description: "Search response time must be under 8 seconds" },
        { id: "c2", description: "Search response time must be under 10 seconds" },
      ],
    };

    canonicalizeAndLink(merged);

    const constraints = merged.constraints as Array<Record<string, unknown>>;
    const ids = constraints.map((c) => c.id as string);
    const uniqueIds = new Set(ids);
    // All IDs must be unique
    expect(uniqueIds.size).toBe(ids.length);
    // The first should have no suffix, the second should have _2
    expect(ids[0]).toMatch(/^CON_SEARCH_RESPONSE_TIME_SECONDS$/);
    expect(ids[1]).toMatch(/^CON_SEARCH_RESPONSE_TIME_SECONDS_2$/);
  });

  it("deduplicates identical function canonicalIds", () => {
    const merged: Record<string, unknown> = {
      functions: [
        { id: "f1", name: "ConfigureSystem" },
        { id: "f2", name: "ConfigureSystem" },
      ],
    };

    canonicalizeAndLink(merged);

    const fns = merged.functions as Array<Record<string, unknown>>;
    const ids = fns.map((f) => f.id as string);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
    expect(ids[0]).toBe("FUN_CONFIGURE_SYSTEM");
    expect(ids[1]).toBe("FUN_CONFIGURE_SYSTEM_2");
  });

  it("deduplicates identical exception canonicalIds", () => {
    const merged: Record<string, unknown> = {
      exceptions: [
        { id: "x1", description: "Database connection failed" },
        { id: "x2", description: "Database connection failure" },
      ],
    };

    canonicalizeAndLink(merged);

    const excs = merged.exceptions as Array<Record<string, unknown>>;
    const ids = excs.map((x) => x.id as string);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  // ----------------------------------------------------------------
  // 10. Deterministic: same input produces same output
  // ----------------------------------------------------------------
  it("produces deterministic canonicalIds for same input", () => {
    const makeInput = () => ({
      functions: [
        { id: "a", name: "CreateUser", description: "Create a user" },
        { id: "b", name: "DeleteUser", description: "Delete a user" },
      ],
      constraints: [
        { id: "c1", description: "Users must have unique emails" },
      ],
    });

    const merged1: Record<string, unknown> = makeInput();
    const merged2: Record<string, unknown> = makeInput();

    const maps1 = canonicalizeAndLink(merged1);
    const maps2 = canonicalizeAndLink(merged2);

    const fns1 = merged1.functions as Array<Record<string, unknown>>;
    const fns2 = merged2.functions as Array<Record<string, unknown>>;

    expect(fns1[0].id).toBe(fns2[0].id);
    expect(fns1[1].id).toBe(fns2[1].id);
    expect(maps1.functionMap).toEqual(maps2.functionMap);
    expect(maps1.constraintMap).toEqual(maps2.constraintMap);
  });
});
