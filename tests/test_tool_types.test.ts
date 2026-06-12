import { describe, it, expect } from "vitest";
import { createToolError, isToolError, type ToolError } from "../src/tools/types.js";

describe("createToolError", () => {
  it("creates an Error with ToolError fields", () => {
    const err = createToolError("E001", "something broke");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("E001");
    expect(err.message).toBe("something broke");
    expect(err.recoverable).toBe(true);
  });

  it("defaults recoverable to true", () => {
    const err = createToolError("E002", "default recoverable");
    expect(err.recoverable).toBe(true);
  });

  it("stores details when provided", () => {
    const err = createToolError("E003", "with details", {
      details: { file: "foo.ts", line: 42 },
    });
    expect(err.details).toEqual({ file: "foo.ts", line: 42 });
  });

  it("handles non-recoverable errors", () => {
    const err = createToolError("FATAL", "cannot proceed", { recoverable: false });
    expect(err.recoverable).toBe(false);
  });
});

describe("isToolError", () => {
  it("returns true for ToolError", () => {
    const err = createToolError("E001", "a tool error");
    expect(isToolError(err)).toBe(true);
  });

  it("returns false for plain Error and non-Error values", () => {
    expect(isToolError(new Error("plain error"))).toBe(false);
    expect(isToolError("string")).toBe(false);
    expect(isToolError(null)).toBe(false);
    expect(isToolError(undefined)).toBe(false);
    expect(isToolError(42)).toBe(false);
    expect(isToolError({ code: "X", message: "hi", recoverable: true })).toBe(false);
  });
});
