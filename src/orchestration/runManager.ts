/**
 * Run-state transitions for the orchestration control plane.
 *
 * Ported from reqdesign/orchestration/run_manager.py.
 */

import type { WorkflowState } from "../state.js";

// ---------------------------------------------------------------------------
// RunManager
// ---------------------------------------------------------------------------

export class RunManager {
  /** Mark the run as successfully completed. */
  static markCompleted(state: WorkflowState): void {
    state.runStatus = "completed";
    state.persistStatus = "final_saved";
  }

  /** Mark the run as partially completed with a reason. */
  static markPartial(state: WorkflowState, reason = ""): void {
    if (state.runStatus === "running") {
      state.runStatus = "partial";
    }
    if (
      state.persistStatus === "not_saved" &&
      Object.keys(state.artifacts).length > 0
    ) {
      state.persistStatus = "partial_saved";
    }
    if (reason) {
      state.errors.push(reason);
    }
  }

  /** Mark the run as paused. */
  static markPaused(state: WorkflowState, reason = ""): void {
    state.runStatus = "paused";
    if (reason) {
      state.errors.push(reason);
    }
  }

  /** Mark the run as failed. */
  static markFailed(state: WorkflowState, reason = ""): void {
    state.runStatus = "failed";
    if (reason) {
      state.errors.push(reason);
    }
  }
}
