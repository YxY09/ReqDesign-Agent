import { describe, it, expect } from "vitest";
import {
  resolveEntityRef,
  normalizeRelationType,
} from "../src/shared/referenceNormalizer.js";
import type { EntityRegistry } from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// Test registry
// ---------------------------------------------------------------------------

const TEST_REGISTRY: EntityRegistry = {
  entities: [
    {
      id: "E_SUSPECT",
      canonicalName: "Suspect",
      displayName: "嫌疑人",
      aliases: ["suspect", "犯罪嫌疑人"],
    },
    {
      id: "E_CASE",
      canonicalName: "Case",
      displayName: "案件",
      aliases: ["Police Case", "Case Record"],
    },
    {
      id: "E_PROPERTY",
      canonicalName: "Property",
      displayName: "财产",
      aliases: ["property"],
    },
    {
      id: "E_DOCUMENT",
      canonicalName: "Document",
      displayName: "文档",
      aliases: ["document"],
    },
    {
      id: "E_USER",
      canonicalName: "User",
      displayName: "用户",
      aliases: ["user"],
    },
  ],
  actors: [
    {
      id: "A_ADMIN",
      canonicalName: "Admin",
      displayName: "管理员",
      aliases: ["AdminUser", "Administrator", "SuperUser"],
    },
  ],
};

// ---------------------------------------------------------------------------
// resolveEntityRef
// ---------------------------------------------------------------------------

describe("resolveEntityRef", () => {
  it("returns canonical ID when input already starts with E_", () => {
    expect(resolveEntityRef("E_SUSPECT", TEST_REGISTRY)).toBe("E_SUSPECT");
  });

  it("returns canonical ID when input already starts with A_", () => {
    expect(resolveEntityRef("A_ADMIN", TEST_REGISTRY)).toBe("A_ADMIN");
  });

  it("resolves canonicalName to entity ID", () => {
    expect(resolveEntityRef("Suspect", TEST_REGISTRY)).toBe("E_SUSPECT");
  });

  it("resolves canonicalName case-insensitively", () => {
    expect(resolveEntityRef("suspect", TEST_REGISTRY)).toBe("E_SUSPECT");
  });

  it("resolves displayName to entity ID", () => {
    expect(resolveEntityRef("嫌疑人", TEST_REGISTRY)).toBe("E_SUSPECT");
  });

  it("resolves alias to entity ID", () => {
    expect(resolveEntityRef("犯罪嫌疑人", TEST_REGISTRY)).toBe("E_SUSPECT");
  });

  it("resolves actor canonicalName to actor ID", () => {
    expect(resolveEntityRef("Admin", TEST_REGISTRY)).toBe("A_ADMIN");
  });

  it("resolves actor alias to actor ID", () => {
    expect(resolveEntityRef("Administrator", TEST_REGISTRY)).toBe("A_ADMIN");
  });

  it("resolves actor displayName to actor ID", () => {
    expect(resolveEntityRef("管理员", TEST_REGISTRY)).toBe("A_ADMIN");
  });

  it("returns original string when no match in registry", () => {
    expect(resolveEntityRef("UnknownThing", TEST_REGISTRY)).toBe("UnknownThing");
  });

  it("returns original string when registry is undefined", () => {
    expect(resolveEntityRef("Suspect", undefined)).toBe("Suspect");
  });

  it("returns empty string for empty input", () => {
    expect(resolveEntityRef("", TEST_REGISTRY)).toBe("");
  });

  it("trims whitespace before resolving", () => {
    expect(resolveEntityRef("  Suspect  ", TEST_REGISTRY)).toBe("E_SUSPECT");
  });
});

// ---------------------------------------------------------------------------
// normalizeRelationType
// ---------------------------------------------------------------------------

describe("normalizeRelationType", () => {
  it("normalizes 1:N to one-to-many", () => {
    expect(normalizeRelationType("1:N")).toBe("one-to-many");
  });

  it("normalizes o2m to one-to-many", () => {
    expect(normalizeRelationType("o2m")).toBe("one-to-many");
  });

  it("normalizes one-to-many to one-to-many (idempotent)", () => {
    expect(normalizeRelationType("one-to-many")).toBe("one-to-many");
  });

  it("normalizes 1..* to one-to-many", () => {
    expect(normalizeRelationType("1..*")).toBe("one-to-many");
  });

  it("normalizes N:1 to many-to-one", () => {
    expect(normalizeRelationType("N:1")).toBe("many-to-one");
  });

  it("normalizes 1:1 to one-to-one", () => {
    expect(normalizeRelationType("1:1")).toBe("one-to-one");
  });

  it("normalizes M:N to many-to-many", () => {
    expect(normalizeRelationType("M:N")).toBe("many-to-many");
  });

  it("normalizes m2m to many-to-many", () => {
    expect(normalizeRelationType("m2m")).toBe("many-to-many");
  });

  it("returns original for unknown type", () => {
    expect(normalizeRelationType("some-custom-type")).toBe("some-custom-type");
  });

  it("trims whitespace", () => {
    expect(normalizeRelationType("  1:N  ")).toBe("one-to-many");
  });

  it("is case-insensitive", () => {
    expect(normalizeRelationType("One-To-Many")).toBe("one-to-many");
  });
});
