/**
 * Standardized tool types — shared across tools layer.
 */

/** Standardized error result for tools */
export interface ToolError {
  code: string;
  message: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}

/** Capabilities a tool can declare */
export interface ToolCapabilities {
  readonly requiresLlm: boolean;
  readonly supportedTaskTypes: string[];
}
