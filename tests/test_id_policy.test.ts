import { describe, expect, it } from "vitest";
import {
  displayIdFromRecord,
  formatDisplayId,
  isDisplayId,
  nextDisplayIdCounter,
} from "../src/shared/idPolicy.js";

describe("idPolicy", () => {
  it("recognizes only supported business display IDs", () => {
    expect(isDisplayId("F001")).toBe(true);
    expect(isDisplayId("C013", "C")).toBe(true);
    expect(isDisplayId("X0006", "X")).toBe(true);
    expect(isDisplayId("TC-B-001")).toBe(false);
    expect(isDisplayId("F001", "C")).toBe(false);
    expect(isDisplayId("C13", "C")).toBe(false);
  });

  it("reads display IDs from displayId first and id second", () => {
    expect(displayIdFromRecord({ displayId: "F007", id: "F001" }, "F")).toBe("F007");
    expect(displayIdFromRecord({ id: "C011" }, "C")).toBe("C011");
    expect(displayIdFromRecord({ id: "TC-B-001" }, "F")).toBe("");
  });

  it("allocates after the highest existing display ID", () => {
    expect(nextDisplayIdCounter(["F001", "F007", "F002"], 1)).toBe(8);
    expect(nextDisplayIdCounter([], 3)).toBe(3);
    expect(formatDisplayId("X", 6)).toBe("X006");
  });
});