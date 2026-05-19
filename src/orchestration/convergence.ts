/**
 * ConvergenceTracker — detect when repair loops make no progress.
 *
 * Tracks issue fingerprints across evaluation rounds. If the same issue
 * persists across N consecutive rounds, the system should stop trying
 * to repair it and escalate.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IssueFingerprint {
  fingerprint: string;
  severity: string;
}

export interface EvaluationRound {
  issues: IssueFingerprint[];
}

export type Trend = "decreasing" | "flat" | "increasing" | "unknown";

// ---------------------------------------------------------------------------
// ConvergenceTracker
// ---------------------------------------------------------------------------

export class ConvergenceTracker {
  private readonly rounds: EvaluationRound[] = [];
  private readonly stallThreshold: number;

  constructor(stallThreshold = 3) {
    this.stallThreshold = stallThreshold;
  }

  /** Record a new evaluation round. */
  addRound(round: EvaluationRound): void {
    this.rounds.push(round);
  }

  /** Number of rounds recorded. */
  get roundCount(): number {
    return this.rounds.length;
  }

  /** Generate a stable fingerprint from an issue description. */
  static fingerprint(description: string): string {
    return description.trim().slice(0, 80).toLowerCase();
  }

  /** Check if the system is stalled (same issues not improving). */
  isStalled(): boolean {
    if (this.rounds.length < this.stallThreshold) return false;
    if (this.stalledFingerprints().length === 0) return false;
    if (this.trend() === "decreasing") return false;
    return true;
  }

  /** Get fingerprints that have persisted across all recent threshold rounds. */
  stalledFingerprints(): string[] {
    if (this.rounds.length < this.stallThreshold) return [];

    const recent = this.rounds.slice(-this.stallThreshold);
    const firstSet = new Set(recent[0].issues.map((i) => i.fingerprint));

    const persisted = [...firstSet].filter((fp) =>
      recent.every((round) =>
        round.issues.some((i) => i.fingerprint === fp),
      ),
    );

    return persisted;
  }

  /** Determine the trend of issue counts over the last 3 rounds. */
  trend(): Trend {
    if (this.rounds.length < 2) return "unknown";

    const counts = this.rounds.slice(-3).map((r) => r.issues.length);

    const strictlyDecreasing = counts.every(
      (c, i) => i === 0 || c < counts[i - 1],
    );
    const strictlyIncreasing = counts.every(
      (c, i) => i === 0 || c > counts[i - 1],
    );

    if (strictlyDecreasing) return "decreasing";
    if (strictlyIncreasing) return "increasing";
    return "flat";
  }

  /** Number of major issues in the latest round. */
  get latestMajorCount(): number {
    if (this.rounds.length === 0) return 0;
    return this.rounds[this.rounds.length - 1].issues.filter(
      (i) => i.severity === "major",
    ).length;
  }

  /** Reset tracker state. */
  reset(): void {
    this.rounds.length = 0;
  }
}
