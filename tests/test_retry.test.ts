import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../src/utils/retry.js";

describe("withRetry", () => {
  it("首次成功时不重试", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("首次失败、第二次成功时重试 1 次", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("全部重试耗尽后抛出最后一次错误", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("persistent-fail"));
    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 5, maxDelayMs: 20 })
    ).rejects.toThrow("persistent-fail");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retry 间隔按 exponential backoff 增长", async () => {
    const start = Date.now();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockRejectedValueOnce(new Error("2"))
      .mockResolvedValueOnce("ok");
    await withRetry(fn, { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 500 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(130);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retry 间隔不超过 maxDelayMs", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockRejectedValueOnce(new Error("2"))
      .mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 70 });
    expect(result).toBe("ok");
  });

  it("shouldRetry 返回 false 时立即抛出", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(
      withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
        shouldRetry: () => false,
      })
    ).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
