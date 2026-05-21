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

/** Factory: create an Error with ToolError extension fields */
export function createToolError(
  code: string,
  message: string,
  options: { recoverable?: boolean; details?: Record<string, unknown> } = {}
): Error & ToolError {
  const error = Object.assign(new Error(message), {
    code,
    recoverable: options.recoverable ?? true,
    details: options.details ?? undefined,
  });
  return error as Error & ToolError;
}

/** Type guard: check if a value is a ToolError */
export function isToolError(error: unknown): error is Error & ToolError {
  return (
    error instanceof Error &&
    typeof (error as Record<string, unknown>).code === "string" &&
    typeof (error as Record<string, unknown>).recoverable === "boolean"
  );
}
