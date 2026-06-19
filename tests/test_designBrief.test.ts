import { describe, expect, it } from "vitest";
import { buildDesignBrief } from "../src/shared/designBrief.js";

describe("buildDesignBrief", () => {
  it("exposes display IDs and hides internal requirement IDs when display IDs exist", () => {
    const brief = buildDesignBrief({
      functions: [
        { id: "FUN_SEARCH_CASE", displayId: "F001", name: "SearchCase", description: "搜索案件" },
      ],
      constraints: [
        {
          id: "CON_ENCRYPTION",
          displayId: "C001",
          description: "数据库加密",
          source_text: "The database is encrypted using AES/Rijndael (128-bit block, 256-bit key).",
          related_functions: ["FUN_SEARCH_CASE"],
        },
      ],
      exceptions: [
        { id: "EXC_OPEN_FAIL", displayId: "X001", description: "打开失败", trigger: "密码错误", handling: "拒绝打开" },
      ],
      entities: [{ name: "Database", description: "数据库", attributes: [] }],
    });

    const json = JSON.stringify(brief);
    expect(brief.designContract.allowedFunctionIds).toEqual(["F001"]);
    expect(brief.designContract.allowedConstraintIds).toEqual(["C001"]);
    expect(brief.designContract.allowedExceptionIds).toEqual(["X001"]);
    expect(json).not.toContain("FUN_SEARCH_CASE");
    expect(json).not.toContain("CON_ENCRYPTION");
    expect(json).not.toContain("EXC_OPEN_FAIL");
  });

  it("keeps constraint type, source text, anchors, and normalized function links", () => {
    const brief = buildDesignBrief({
      functions: [{ id: "FUN_SAVE", displayId: "F001", name: "SaveDatabase", description: "保存数据库" }],
      constraints: [
        {
          id: "CON_ENCRYPTION",
          displayId: "C001",
          description: "加密保存",
          source_text: "AES/Rijndael (128-bit block, 256-bit key) encryption is required on save.",
          related_functions: ["FUN_SAVE"],
        },
      ],
      entities: [{ name: "Database", description: "数据库" }],
    });

    expect(brief.constraints[0]).toMatchObject({
      id: "C001",
      type: "security",
      relatedFunctions: ["F001"],
    });
    expect(brief.constraints[0].sourceText).toContain("256-bit key");
    expect(brief.constraints[0].anchors).toEqual(expect.arrayContaining(["AES/Rijndael", "128-bit", "256-bit"]));
  });

  it("builds entity slices with key attributes and source links", () => {
    const brief = buildDesignBrief({
      functions: [{ id: "F001", name: "RegisterPatient", description: "登记 Patient 患者" }],
      constraints: [
        { id: "C001", description: "Patient 身份证号必须唯一", source_text: "Patient idCard must be unique" },
      ],
      entities: [
        {
          name: "Patient",
          description: "患者",
          attributes: [
            { name: "notes", type: "String" },
            { name: "patientId", type: "String" },
            { name: "idCard", type: "String" },
            { name: "createdAt", type: "DateTime" },
            { name: "fieldA", type: "String" },
            { name: "fieldB", type: "String" },
            { name: "fieldC", type: "String" },
            { name: "fieldD", type: "String" },
            { name: "fieldE", type: "String" },
          ],
        },
      ],
    });

    expect(brief.entities[0].keyAttributes).toHaveLength(8);
    expect(brief.entities[0].keyAttributes.map((attr) => attr.name)).toEqual(expect.arrayContaining(["patientId", "idCard", "createdAt"]));
    expect(brief.entities[0].sourceFunctions).toContain("F001");
    expect(brief.entities[0].sourceConstraints).toContain("C001");
  });

  it("creates deterministic coverage skeleton entries for every function, constraint, and exception", () => {
    const brief = buildDesignBrief({
      functions: [
        { id: "F001", name: "Login", description: "登录" },
        { id: "F002", name: "Logout", description: "登出" },
      ],
      constraints: [{ id: "C001", description: "密码不少于 8 位", source_text: "密码不少于 8 位" }],
      exceptions: [{ id: "X001", description: "密码错误", trigger: "错误密码", handling: "拒绝登录" }],
      entities: [],
    });

    expect(brief.coverageSkeleton.map((entry) => `${entry.refKind}:${entry.refId}`)).toEqual([
      "function:F001",
      "function:F002",
      "constraint:C001",
      "exception:X001",
    ]);
    expect(brief.coverageSkeleton[2]).toMatchObject({
      refId: "C001",
      refKind: "constraint",
      originalText: "密码不少于 8 位",
    });
    expect(brief.coverageSkeleton[2]).not.toHaveProperty("designDecision");
    expect(brief.coverageSkeleton[2]).not.toHaveProperty("affectedModuleIds");
  });
});
