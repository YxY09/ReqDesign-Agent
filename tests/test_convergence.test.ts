import { describe, it, expect } from "vitest";
import {
  ConvergenceTracker,
  type EvaluationRound,
} from "../src/orchestration/snapshot.js";

describe("ConvergenceTracker", () => {
  it("detects identical issue across rounds", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({
      issues: [{ fingerprint: "state coupon C002", severity: "major" }],
    });
    tracker.addRound({
      issues: [{ fingerprint: "state coupon C002", severity: "major" }],
    });
    tracker.addRound({
      issues: [{ fingerprint: "state coupon C002", severity: "major" }],
    });
    expect(tracker.isStalled()).toBe(true);
    expect(tracker.stalledFingerprints()).toContain("state coupon C002");
  });

  it("does not stall when issues change", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({ issues: [{ fingerprint: "A", severity: "major" }] });
    tracker.addRound({ issues: [{ fingerprint: "B", severity: "major" }] });
    tracker.addRound({ issues: [{ fingerprint: "C", severity: "major" }] });
    expect(tracker.isStalled()).toBe(false);
  });

  it("does not stall when issue count decreases", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({
      issues: [
        { fingerprint: "A", severity: "major" },
        { fingerprint: "B", severity: "major" },
      ],
    });
    tracker.addRound({
      issues: [{ fingerprint: "A", severity: "major" }],
    });
    expect(tracker.isStalled()).toBe(false);
  });

  it("does not stall with only 2 rounds when threshold is 3", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({
      issues: [{ fingerprint: "A", severity: "major" }],
    });
    tracker.addRound({
      issues: [{ fingerprint: "A", severity: "major" }],
    });
    expect(tracker.isStalled()).toBe(false);
  });

  it("computes fingerprint from description — same prefix yields same fingerprint", () => {
    const base = "A".repeat(80);
    const fp1 = ConvergenceTracker.fingerprint(base + "extra stuff here");
    const fp2 = ConvergenceTracker.fingerprint(base + "different stuff here");
    // Same first 80 chars → same fingerprint
    expect(fp1).toBe(fp2);
  });

  it("produces different fingerprints for different issues", () => {
    const fp1 = ConvergenceTracker.fingerprint("Missing Payment class in design");
    const fp2 = ConvergenceTracker.fingerprint("State diagram coupon C002 error");
    expect(fp1).not.toBe(fp2);
  });

  it("reports decreasing trend correctly", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({
      issues: [
        { fingerprint: "A", severity: "major" },
        { fingerprint: "B", severity: "major" },
      ],
    });
    tracker.addRound({
      issues: [{ fingerprint: "A", severity: "major" }],
    });
    expect(tracker.trend()).toBe("decreasing");
  });

  it("reports increasing trend correctly", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({
      issues: [{ fingerprint: "A", severity: "major" }],
    });
    tracker.addRound({
      issues: [
        { fingerprint: "A", severity: "major" },
        { fingerprint: "B", severity: "major" },
      ],
    });
    expect(tracker.trend()).toBe("increasing");
  });

  it("reports flat trend correctly", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({
      issues: [{ fingerprint: "A", severity: "major" }],
    });
    tracker.addRound({
      issues: [{ fingerprint: "A", severity: "major" }],
    });
    expect(tracker.trend()).toBe("flat");
  });

  it("handles empty rounds", () => {
    const tracker = new ConvergenceTracker(3);
    expect(tracker.isStalled()).toBe(false);
    expect(tracker.trend()).toBe("unknown");
    expect(tracker.latestMajorCount).toBe(0);
  });

  it("reports latestMajorCount correctly", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({
      issues: [
        { fingerprint: "A", severity: "major" },
        { fingerprint: "B", severity: "minor" },
      ],
    });
    expect(tracker.latestMajorCount).toBe(1);
  });

  it("resets state", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({
      issues: [{ fingerprint: "A", severity: "major" }],
    });
    tracker.reset();
    expect(tracker.roundCount).toBe(0);
    expect(tracker.isStalled()).toBe(false);
  });

  it("should NOT stall when issue count is decreasing despite persistent fingerprints", () => {
    const tracker = new ConvergenceTracker(3);
    // 5 issues
    tracker.addRound({
      issues: [
        { fingerprint: "A", severity: "major" },
        { fingerprint: "B", severity: "major" },
        { fingerprint: "C", severity: "major" },
        { fingerprint: "D", severity: "major" },
        { fingerprint: "E", severity: "major" },
      ],
    });
    // 4 issues — A, B, C persist
    tracker.addRound({
      issues: [
        { fingerprint: "A", severity: "major" },
        { fingerprint: "B", severity: "major" },
        { fingerprint: "C", severity: "major" },
        { fingerprint: "F", severity: "major" },
      ],
    });
    // 3 issues — A, B, C persist
    tracker.addRound({
      issues: [
        { fingerprint: "A", severity: "major" },
        { fingerprint: "B", severity: "major" },
        { fingerprint: "C", severity: "major" },
      ],
    });
    expect(tracker.stalledFingerprints()).toContain("A");
    expect(tracker.stalledFingerprints()).toContain("B");
    expect(tracker.stalledFingerprints()).toContain("C");
    expect(tracker.trend()).toBe("decreasing");
    expect(tracker.isStalled()).toBe(false);
  });

  it("should stall when issue count is flat AND fingerprints persist", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({
      issues: [
        { fingerprint: "A", severity: "major" },
        { fingerprint: "B", severity: "major" },
        { fingerprint: "C", severity: "major" },
      ],
    });
    tracker.addRound({
      issues: [
        { fingerprint: "A", severity: "major" },
        { fingerprint: "B", severity: "major" },
        { fingerprint: "C", severity: "major" },
      ],
    });
    tracker.addRound({
      issues: [
        { fingerprint: "A", severity: "major" },
        { fingerprint: "B", severity: "major" },
        { fingerprint: "C", severity: "major" },
      ],
    });
    expect(tracker.trend()).toBe("flat");
    expect(tracker.isStalled()).toBe(true);
  });

  it("should stall when issue count is increasing", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({
      issues: [{ fingerprint: "A", severity: "major" }],
    });
    tracker.addRound({
      issues: [
        { fingerprint: "A", severity: "major" },
        { fingerprint: "B", severity: "major" },
      ],
    });
    tracker.addRound({
      issues: [
        { fingerprint: "A", severity: "major" },
        { fingerprint: "B", severity: "major" },
        { fingerprint: "C", severity: "major" },
      ],
    });
    expect(tracker.trend()).toBe("increasing");
    expect(tracker.isStalled()).toBe(true);
  });

  it("roundCount returns number of rounds added", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({ issues: [] });
    tracker.addRound({ issues: [] });
    expect(tracker.roundCount).toBe(2);
  });
});
