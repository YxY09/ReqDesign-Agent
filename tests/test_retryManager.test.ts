import { describe, it, expect } from "vitest";
import { RetryManager } from "./retryManager.js";

describe("RetryManager", () => {
  /** Helper: create a RetryManager with zero delay for fast tests. */
  function makeManager(opts: { maxRetries?: number } = {}) {
    return new RetryManager({
      maxRetries: opts.maxRetries,
      baseDelay: 0,
      jitter: false,
    });
  }

  // ------------------------------------------------------------------
  // success on first try
  // ------------------------------------------------------------------
  it("succeeds on first try", async () => {
    const rm = makeManager({ maxRetries: 3 });
    const result = await rm.retry(() => 42);
    expect(result).toBe(42);
    expect(rm.history.length).toBe(0);
  });

  // ------------------------------------------------------------------
  // success after failures
  // ------------------------------------------------------------------
  it("succeeds after transient failures", async () => {
    const rm = makeManager({ maxRetries: 3 });
    let callCount = 0;

    const result = await rm.retry(() => {
      callCount++;
      if (callCount < 3) throw new Error("not yet");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(callCount).toBe(3);
    expect(rm.history.length).toBe(2); // 2 failures recorded
  });

  // ------------------------------------------------------------------
  // all retries exhausted
  // ------------------------------------------------------------------
  it("throws when all retries are exhausted", async () => {
    const rm = makeManager({ maxRetries: 2 });

    await expect(
      rm.retry(() => {
        throw new RuntimeError("always fails");
      }),
    ).rejects.toThrow("always fails");

    expect(rm.history.length).toBe(2);
  });

  // ------------------------------------------------------------------
  // clear history
  // ------------------------------------------------------------------
  it("clears failure history", async () => {
    const rm = makeManager({ maxRetries: 1 });

    await expect(
      rm.retry(() => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    expect(rm.hasFailures()).toBe(true);

    rm.clearHistory();

    expect(rm.hasFailures()).toBe(false);
    expect(rm.history.length).toBe(0);
  });

  // ------------------------------------------------------------------
  // maxRetries = 0
  // ------------------------------------------------------------------
  it("does not retry when maxRetries is 0", async () => {
    const rm = makeManager({ maxRetries: 0 });

    await expect(
      rm.retry(() => {
        throw new Error("no retries");
      }),
    ).rejects.toThrow("no retries");
  });
});

/** Minimal RuntimeError stand-in (browser-compatible). */
class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}
