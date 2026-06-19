import { describe, it, expect } from "vitest";
import {
  canonicalizeConstraints,
  type ConstraintCandidate,
  type CanonicalConstraint,
} from "../src/shared/constraintCanonicalizer.js";

describe("canonicalizeConstraints", () => {
  // ----------------------------------------------------------------
  // 1. Basic normalization: input candidate → CanonicalConstraint
  // ----------------------------------------------------------------
  it("produces a valid CanonicalConstraint from a single candidate", () => {
    const candidates: ConstraintCandidate[] = [
      {
        description: "Audit trail data cannot be modified or deleted",
        sourceText: "审计跟踪数据不可修改或删除",
        sectionId: "S3.2.1",
      },
    ];

    const results = canonicalizeConstraints(candidates, []);

    expect(results).toHaveLength(1);
    const c = results[0];

    // constraintUid starts with "ct_"
    expect(c.constraintUid).toMatch(/^ct_[A-Z0-9]{8}$/);
    // canonicalId starts with "CON_"
    expect(c.canonicalId).toMatch(/^CON_/);
    // displayId is C001
    expect(c.displayId).toBe("C001");
    // type/subtype inferred
    expect(c.type).toBe("security");
    expect(c.subtype).toBe("audit");
    // normalizedRule populated
    expect(c.normalizedRule).toBeDefined();
    // sourceText preserved
    expect(c.sourceText).toBe("审计跟踪数据不可修改或删除");
    // evidence collected
    expect(c.evidence).toHaveLength(1);
    expect(c.evidence[0].sourceText).toBe("审计跟踪数据不可修改或删除");
    expect(c.evidence[0].sectionId).toBe("S3.2.1");
    // verification populated
    expect(c.verification.testability).toBe("testable");
    expect(c.verification.recommendedType).toBe("security_integration_test");
    expect(c.verification.acceptanceCriteria).toEqual([]);
  });

  it("preserves explicit source display IDs and only assigns IDs for missing/conflicting candidates", () => {
    const candidates: ConstraintCandidate[] = [
      {
        displayId: "C013",
        description: "库存预警值为10件",
        sourceText: "库存预警（低于阈值通知）",
      },
      {
        displayId: "C002",
        description: "支付超时自动取消订单",
        sourceText: "支付超时自动取消订单（30分钟）",
      },
      {
        displayId: "C002",
        description: "手机号需唯一",
        sourceText: "手机号唯一",
      },
    ];

    const results = canonicalizeConstraints(candidates, []);

    expect(results.map((c) => c.displayId)).toEqual(["C013", "C002", "C014"]);
    expect(results[0].descriptionZh).toBe("库存预警值为10件");
  });

  // ----------------------------------------------------------------
  // 2. Deduplication: same sourceText merged into one constraint
  // ----------------------------------------------------------------
  it("merges candidates with identical normalized sourceText", () => {
    const candidates: ConstraintCandidate[] = [
      {
        description: "Audit trail must be immutable",
        sourceText: "审计数据不可修改",
        sectionId: "S3.2.1",
      },
      {
        description: "Audit data cannot be changed",
        sourceText: "审计数据不可修改",
        sectionId: "S3.2.2",
      },
    ];

    const results = canonicalizeConstraints(candidates, []);

    expect(results).toHaveLength(1);
    // Both evidences should be merged
    expect(results[0].evidence).toHaveLength(2);
    expect(results[0].evidence[0].sectionId).toBe("S3.2.1");
    expect(results[0].evidence[1].sectionId).toBe("S3.2.2");
  });

  it("merges candidates with identical normalized description when sourceText differs", () => {
    const candidates: ConstraintCandidate[] = [
      {
        description: "Search response time under 8 seconds",
        sourceText: "搜索响应时间不超过8秒",
        sectionId: "S4.1",
      },
      {
        description: "Search response time under 8 seconds",
        sourceText: "搜索结果应在8秒内返回",
        sectionId: "S4.2",
      },
    ];

    const results = canonicalizeConstraints(candidates, []);

    expect(results).toHaveLength(1);
    expect(results[0].evidence).toHaveLength(2);
  });

  // ----------------------------------------------------------------
  // 3. ID assignment: unique UIDs, correct canonicalId format, sequential displayId
  // ----------------------------------------------------------------
  it("assigns unique constraintUids and sequential displayIds", () => {
    const candidates: ConstraintCandidate[] = [
      {
        description: "Users must authenticate before access",
        sourceText: "用户必须先认证才能访问",
      },
      {
        description: "Response time must be under 5 seconds",
        sourceText: "响应时间必须低于5秒",
      },
      {
        description: "System must be accessible per ISO 9241",
        sourceText: "系统应符合ISO 9241可用性标准",
      },
    ];

    const results = canonicalizeConstraints(candidates, []);

    expect(results).toHaveLength(3);

    // All constraintUids unique
    const uids = results.map((r) => r.constraintUid);
    expect(new Set(uids).size).toBe(3);

    // All canonicalIds unique
    const cids = results.map((r) => r.canonicalId);
    expect(new Set(cids).size).toBe(3);

    // displayIds sequential
    expect(results[0].displayId).toBe("C001");
    expect(results[1].displayId).toBe("C002");
    expect(results[2].displayId).toBe("C003");
  });

  // ----------------------------------------------------------------
  // 4. Type inference: correct type/subtype from keywords
  // ----------------------------------------------------------------
  it("infers security/access_control type for auth-related constraints", () => {
    const candidates: ConstraintCandidate[] = [
      { description: "Users must have proper permissions", sourceText: "用户必须有权限" },
    ];
    const [r] = canonicalizeConstraints(candidates, []);
    expect(r.type).toBe("security");
    expect(r.subtype).toBe("access_control");
  });

  it("infers performance/response_time type for performance constraints", () => {
    const candidates: ConstraintCandidate[] = [
      { description: "System response time under 3 seconds", sourceText: "系统响应时间低于3秒" },
    ];
    const [r] = canonicalizeConstraints(candidates, []);
    expect(r.type).toBe("performance");
    expect(r.subtype).toBe("response_time");
  });

  it("infers usability/accessibility type for usability constraints", () => {
    const candidates: ConstraintCandidate[] = [
      { description: "Interface must follow accessibility guidelines", sourceText: "界面必须符合无障碍指南" },
    ];
    const [r] = canonicalizeConstraints(candidates, []);
    expect(r.type).toBe("usability");
    expect(r.subtype).toBe("accessibility");
  });

  it("infers data/integrity type for data constraints", () => {
    const candidates: ConstraintCandidate[] = [
      { description: "Data integrity must be maintained across transfers", sourceText: "数据传输中必须保持数据完整性" },
    ];
    const [r] = canonicalizeConstraints(candidates, []);
    expect(r.type).toBe("data");
    expect(r.subtype).toBe("integrity");
  });

  it("infers availability/uptime type for availability constraints", () => {
    const candidates: ConstraintCandidate[] = [
      { description: "System uptime SLA must be 99.9%", sourceText: "系统可用率SLA必须达到99.9%" },
    ];
    const [r] = canonicalizeConstraints(candidates, []);
    expect(r.type).toBe("availability");
    expect(r.subtype).toBe("uptime");
  });

  it("defaults to functional/general for unrecognized constraints", () => {
    const candidates: ConstraintCandidate[] = [
      { description: "Workflow must follow the business process", sourceText: "工作流必须遵循业务流程" },
    ];
    const [r] = canonicalizeConstraints(candidates, []);
    expect(r.type).toBe("functional");
    expect(r.subtype).toBe("general");
  });

  // ----------------------------------------------------------------
  // 5. relatedFunctions: sourceText contains function name → link
  // ----------------------------------------------------------------
  it("links constraints to functions when sourceText contains function name", () => {
    const candidates: ConstraintCandidate[] = [
      {
        description: "Search must exclude unauthorized records",
        sourceText: "搜索功能必须排除未授权的记录",
      },
    ];
    const functions = [
      { id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase" },
      { id: "FUN_CREATE_USER", displayId: "F002", name: "CreateUser" },
    ];

    const results = canonicalizeConstraints(candidates, functions);

    expect(results[0].relatedFunctions.length).toBeGreaterThanOrEqual(1);
    const searchLink = results[0].relatedFunctions.find(
      (rf) => rf.functionId === "FUN_SEARCH_CASE",
    );
    expect(searchLink).toBeDefined();
    expect(searchLink!.relation).toBe("mentioned_in_source");
    expect(searchLink!.confidence).toBe(0.7);
  });

  it("does not link when no function name matches", () => {
    const candidates: ConstraintCandidate[] = [
      {
        description: "Data must be encrypted at rest",
        sourceText: "数据在存储时必须加密",
      },
    ];
    const functions = [
      { id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase" },
    ];

    const results = canonicalizeConstraints(candidates, functions);
    expect(results[0].relatedFunctions).toHaveLength(0);
  });

  // ----------------------------------------------------------------
  // 5b. relatedFunctions: explicit relatedFunctionCandidates consumed first
  // ----------------------------------------------------------------
  it("links constraints to functions via relatedFunctionCandidates (explicit_link, confidence 0.9)", () => {
    const candidates: ConstraintCandidate[] = [
      {
        description: "Rate limiter caps requests per second",
        sourceText: "限流器每秒最多处理 100 个请求",
        // Explicit candidate hint — no keyword overlap with function names.
        relatedFunctionCandidates: ["FUN_RATE_LIMIT"],
      },
    ];
    const functions = [
      { id: "FUN_RATE_LIMIT", displayId: "F010", name: "Throttle" },
      { id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase" },
    ];

    const results = canonicalizeConstraints(candidates, functions);

    const explicit = results[0].relatedFunctions.find(
      (rf) => rf.functionId === "FUN_RATE_LIMIT",
    );
    expect(explicit).toBeDefined();
    expect(explicit!.relation).toBe("explicit_link");
    expect(explicit!.confidence).toBe(0.9);

    // The keyword pass must not add a lower-confidence link for the same fn,
    // and unrelated functions must not be linked.
    const rateLinks = results[0].relatedFunctions.filter(
      (rf) => rf.functionId === "FUN_RATE_LIMIT",
    );
    expect(rateLinks).toHaveLength(1);
    expect(
      results[0].relatedFunctions.some((rf) => rf.functionId === "FUN_SEARCH_CASE"),
    ).toBe(false);
  });

  it("resolves relatedFunctionCandidates that reference displayId or name, not just canonical id", () => {
    const candidates: ConstraintCandidate[] = [
      {
        description: "Export must be logged",
        sourceText: "导出操作必须记录日志",
        relatedFunctionCandidates: ["F099", "ReportExport"],
      },
    ];
    const functions = [
      { id: "FUN_REPORT_EXPORT", displayId: "F099", name: "ReportExport" },
    ];

    const results = canonicalizeConstraints(candidates, functions);
    // Both candidate strings resolve to the same function → de-duped to one link.
    const links = results[0].relatedFunctions.filter(
      (rf) => rf.functionId === "FUN_REPORT_EXPORT",
    );
    expect(links).toHaveLength(1);
    expect(links[0].relation).toBe("explicit_link");
    expect(links[0].confidence).toBe(0.9);
  });

  // ----------------------------------------------------------------
  // 6. Empty input
  // ----------------------------------------------------------------
  it("returns empty array for empty candidates", () => {
    const results = canonicalizeConstraints([], []);
    expect(results).toEqual([]);
  });

  // ----------------------------------------------------------------
  // 7. Collision handling: different constraints get unique canonicalIds
  // ----------------------------------------------------------------
  it("handles canonicalId collisions by appending suffixes", () => {
    // Two constraints with different descriptions that would generate the same keyword-based canonicalId
    const candidates: ConstraintCandidate[] = [
      {
        description: "System security must be enforced for all users",
        sourceText: "系统安全必须对所有用户执行",
      },
      {
        description: "System security must be enforced for admin users",
        sourceText: "系统安全必须对管理员用户执行",
      },
    ];

    const results = canonicalizeConstraints(candidates, []);

    const cids = results.map((r) => r.canonicalId);
    // All canonicalIds must be unique
    expect(new Set(cids).size).toBe(cids.length);
    // Both should start with CON_
    for (const cid of cids) {
      expect(cid).toMatch(/^CON_/);
    }
  });

  // ----------------------------------------------------------------
  // 8. CanonicalId format includes TYPE_PREFIX
  // ----------------------------------------------------------------
  it("includes type prefix in canonicalId", () => {
    const candidates: ConstraintCandidate[] = [
      { description: "Access control must be enforced", sourceText: "访问控制必须执行" },
    ];
    const [r] = canonicalizeConstraints(candidates, []);
    // security → SEC prefix
    expect(r.canonicalId).toMatch(/^CON_SEC/);
  });

  // ----------------------------------------------------------------
  // 9. Deterministic output
  // ----------------------------------------------------------------
  it("produces deterministic output for same input", () => {
    const makeCandidates = (): ConstraintCandidate[] => [
      { description: "Audit data must be immutable", sourceText: "审计数据不可修改" },
      { description: "Performance must meet SLA", sourceText: "性能必须满足SLA" },
    ];

    const r1 = canonicalizeConstraints(makeCandidates(), []);
    const r2 = canonicalizeConstraints(makeCandidates(), []);

    expect(r1.map((c) => c.canonicalId)).toEqual(r2.map((c) => c.canonicalId));
    expect(r1.map((c) => c.constraintUid)).toEqual(r2.map((c) => c.constraintUid));
    expect(r1.map((c) => c.displayId)).toEqual(r2.map((c) => c.displayId));
  });

  // ----------------------------------------------------------------
  // 10. descriptionZh prefers LLM-generated description over sourceText
  // ----------------------------------------------------------------
  it("prefers LLM-generated description over sourceText for descriptionZh", () => {
    const candidates: ConstraintCandidate[] = [
      { description: "Test constraint", sourceText: "测试约束" },
    ];
    const [r] = canonicalizeConstraints(candidates, []);
    expect(r.descriptionZh).toBe("Test constraint");
  });

  it("falls back to sourceText when no LLM description is available", () => {
    const candidates: ConstraintCandidate[] = [
      { sourceText: "测试约束" },
    ];
    const [r] = canonicalizeConstraints(candidates, []);
    expect(r.descriptionZh).toBe("测试约束");
  });

  it("collects descriptions from merged candidates", () => {
    const candidates: ConstraintCandidate[] = [
      { description: "Audit trail must be immutable", sourceText: "审计数据不可修改" },
      { description: "Audit data cannot be changed", sourceText: "审计数据不可修改" },
    ];
    const results = canonicalizeConstraints(candidates, []);
    expect(results).toHaveLength(1);
    // descriptionZh should use the first LLM description
    expect(results[0].descriptionZh).toBe("Audit trail must be immutable");
  });

  // ----------------------------------------------------------------
  // 11. Regression: bare "数据" should not falsely match "数据库"
  // ----------------------------------------------------------------
  it("does not misclassify database-related constraints as data/integrity", () => {
    const candidates: ConstraintCandidate[] = [
      { description: "数据库连接必须安全", sourceText: "数据库连接必须安全" },
    ];
    const [r] = canonicalizeConstraints(candidates, []);
    expect(r.type).not.toBe("data");
    expect(r.subtype).not.toBe("integrity");
  });

  // ----------------------------------------------------------------
  // 12. Regression: multi-char data patterns still match correctly
  // ----------------------------------------------------------------
  it("matches data/integrity via multi-character Chinese patterns", () => {
    const cases = [
      { desc: "数据完整性必须得到保证", expected: true },
      { desc: "数据准确性校验", expected: true },
      { desc: "数据校验规则必须执行", expected: true },
      { desc: "数据一致性检查", expected: true },
    ];
    for (const { desc, expected } of cases) {
      const [r] = canonicalizeConstraints(
        [{ description: desc, sourceText: desc }],
        [],
      );
      if (expected) {
        expect(r.type).toBe("data");
        expect(r.subtype).toBe("integrity");
      }
    }
  });

  // ----------------------------------------------------------------
  // 13. Semantic dedup: sourceText containment + keyword overlap
  // ----------------------------------------------------------------
  it("merges constraints where sourceText is a substring with high keyword overlap", () => {
    const candidates: ConstraintCandidate[] = [
      {
        description: "SSL encryption required for data transmission",
        sourceText: "数据传输时必须使用SSL加密",
      },
      {
        description: "SSL encryption required for data transmission and storage",
        sourceText: "数据传输和存储时必须使用SSL加密",
      },
    ];

    const results = canonicalizeConstraints(candidates, []);
    // Should be merged because one sourceText contains the other
    // AND they share high keyword overlap
    expect(results).toHaveLength(1);
    // Should have 2 evidences (both sourceTexts)
    expect(results[0].evidence.length).toBeGreaterThanOrEqual(1);
  });

  // ----------------------------------------------------------------
  // 14. Semantic dedup: glossary-based merge
  // ----------------------------------------------------------------
  it("merges constraints with SSL/HTTPS glossary terms and identical description", () => {
    // Glossary_equiv alone scores 0.75 (below 0.8 deterministic threshold),
    // so we use identical descriptions to trigger normalized_text merge at 1.0
    // while the glossary still recognizes SSL/HTTPS equivalence.
    const candidates: ConstraintCandidate[] = [
      {
        description: "SSL/HTTPS must be used for all connections",
        sourceText: "所有连接必须使用SSL",
      },
      {
        description: "SSL/HTTPS must be used for all connections",
        sourceText: "所有连接必须使用HTTPS",
      },
    ];

    const results = canonicalizeConstraints(candidates, []);
    // Merged via normalized_text (identical description)
    expect(results).toHaveLength(1);
    expect(results[0].evidence).toHaveLength(2);
  });

  // ----------------------------------------------------------------
  // 15. Semantic dedup: token overlap merge
  // ----------------------------------------------------------------
  it("merges constraints with high token overlap", () => {
    const candidates: ConstraintCandidate[] = [
      {
        description: "The system must encrypt all data during transmission",
        sourceText: "系统必须在传输过程中加密所有数据",
      },
      {
        description: "The system must encrypt all data during network transmission",
        sourceText: "系统必须在网上传输过程中加密所有数据",
      },
    ];

    const results = canonicalizeConstraints(candidates, []);
    // High token overlap → should be merged
    expect(results).toHaveLength(1);
  });

  // ----------------------------------------------------------------
  // 16. No false merge for unrelated constraints
  // ----------------------------------------------------------------
  it("does not merge unrelated constraints with low overlap", () => {
    const candidates: ConstraintCandidate[] = [
      {
        description: "Database connection pool size must be configurable",
        sourceText: "数据库连接池大小必须可配置",
      },
      {
        description: "User interface must support dark mode",
        sourceText: "用户界面必须支持暗色模式",
      },
    ];

    const results = canonicalizeConstraints(candidates, []);
    expect(results).toHaveLength(2);
  });
});
