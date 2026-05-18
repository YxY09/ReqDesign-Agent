import { describe, it, expect } from "vitest";
import {
  ConvergenceTracker,
  type EvaluationRound,
} from "../src/orchestration/convergence.js";

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

  it("reports improving trend correctly", () => {
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
    expect(tracker.trend()).toBe("improving");
  });

  it("reports worsening trend correctly", () => {
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
    expect(tracker.trend()).toBe("worsening");
  });

  it("reports stable trend correctly", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({
      issues: [{ fingerprint: "A", severity: "major" }],
    });
    tracker.addRound({
      issues: [{ fingerprint: "A", severity: "major" }],
    });
    expect(tracker.trend()).toBe("stable");
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

  it("roundCount returns number of rounds added", () => {
    const tracker = new ConvergenceTracker(3);
    tracker.addRound({ issues: [] });
    tracker.addRound({ issues: [] });
    expect(tracker.roundCount).toBe(2);
  });
});
