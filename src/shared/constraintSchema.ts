/**
 * Constraint schema types, validators, and normalizers.
 *
 * Operates on `Record<string, unknown>` to match the codebase convention
 * (analysis results flow as untyped records).
 */

// ---------------------------------------------------------------------------
// Literal union types
// ---------------------------------------------------------------------------

export type ConstraintCategory =
  | "data_integrity"
  | "access_control"
  | "performance"
  | "business_rule"
  | "usability_compliance";

export type ConstraintSeverity = "high" | "medium" | "low";

const CATEGORIES = new Set<string>([
  "data_integrity",
  "access_control",
  "performance",
  "business_rule",
  "usability_compliance",
]);

const SEVERITIES = new Set<string>(["high", "medium", "low"]);

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function fail(...errors: string[]): ValidationResult {
  return { valid: false, errors };
}

// ---------------------------------------------------------------------------
// Single-record validators
// ---------------------------------------------------------------------------

/**
 * Validate a single constraint record.
 * Requires: id (string), description (≥5 chars).
 * Optional: category (enum), severity (enum).
 */
export function validateConstraint(
  c: Record<string, unknown>,
): ValidationResult {
  const errors: string[] = [];

  if (typeof c.id !== "string" || !c.id.trim()) {
    errors.push("constraint missing required field: id");
  }

  if (typeof c.description !== "string" || c.description.trim().length < 5) {
    errors.push("constraint description must be a string with ≥5 characters");
  }

  if (c.category !== undefined) {
    if (typeof c.category !== "string" || !CATEGORIES.has(c.category)) {
      errors.push(
        `constraint category invalid: "${c.category}". Must be one of: ${[...CATEGORIES].join(", ")}`,
      );
    }
  }

  if (c.severity !== undefined) {
    if (typeof c.severity !== "string" || !SEVERITIES.has(c.severity)) {
      errors.push(
        `constraint severity invalid: "${c.severity}". Must be one of: ${[...SEVERITIES].join(", ")}`,
      );
    }
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

/**
 * Validate a single exception record.
 * Requires: id, description, trigger, handling — all non-empty strings.
 */
export function validateException(
  e: Record<string, unknown>,
): ValidationResult {
  const errors: string[] = [];

  if (typeof e.id !== "string" || !e.id.trim()) {
    errors.push("exception missing required field: id");
  }

  if (typeof e.description !== "string" || !e.description.trim()) {
    errors.push("exception missing required field: description");
  }

  if (typeof e.trigger !== "string" || !e.trigger.trim()) {
    errors.push("exception missing required field: trigger");
  }

  if (typeof e.handling !== "string" || !e.handling.trim()) {
    errors.push("exception missing required field: handling");
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

/**
 * Return a shallow copy of the constraint with default category/severity
 * filled in when absent.
 */
export function normalizeConstraint(
  c: Record<string, unknown>,
): Record<string, unknown> & { category: ConstraintCategory; severity: ConstraintSeverity } {
  return {
    ...c,
    category: (typeof c.category === "string" && CATEGORIES.has(c.category)
      ? c.category
      : "business_rule") as ConstraintCategory,
    severity: (typeof c.severity === "string" && SEVERITIES.has(c.severity)
      ? c.severity
      : "medium") as ConstraintSeverity,
  };
}

// ---------------------------------------------------------------------------
// Batch validators
// ---------------------------------------------------------------------------

/**
 * Validate an array of constraint records. Returns a single result
 * combining all errors (indexed by position).
 */
export function validateConstraintList(
  constraints: Array<Record<string, unknown>>,
): ValidationResult {
  const errors: string[] = [];

  for (let i = 0; i < constraints.length; i++) {
    const r = validateConstraint(constraints[i]);
    for (const e of r.errors) {
      errors.push(`constraints[${i}]: ${e}`);
    }
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

/**
 * Validate an array of exception records.
 */
export function validateExceptionList(
  exceptions: Array<Record<string, unknown>>,
): ValidationResult {
  const errors: string[] = [];

  for (let i = 0; i < exceptions.length; i++) {
    const r = validateException(exceptions[i]);
    for (const e of r.errors) {
      errors.push(`exceptions[${i}]: ${e}`);
    }
  }

  return errors.length === 0 ? ok() : fail(...errors);
}

// ---------------------------------------------------------------------------
// Constraint-analysis-result validator
// ---------------------------------------------------------------------------

/**
 * Validate a constraint task analysis result.
 * At least one of `constraints` / `exceptions` must be non-empty.
 * `actors`, `entities`, `functions` are allowed to be empty/missing.
 * Each individual constraint and exception is also validated.
 */
export function validateConstraintAnalysisResult(
  result: Record<string, unknown>,
): ValidationResult {
  const errors: string[] = [];

  const constraints = Array.isArray(result.constraints)
    ? (result.constraints as Array<Record<string, unknown>>)
    : [];

  const exceptions = Array.isArray(result.exceptions)
    ? (result.exceptions as Array<Record<string, unknown>>)
    : [];

  if (constraints.length === 0 && exceptions.length === 0) {
    errors.push(
      "constraint analysis result must have at least one non-empty array among constraints or exceptions",
    );
  }

  // Validate individual items
  const cResult = validateConstraintList(constraints);
  errors.push(...cResult.errors);

  const eResult = validateExceptionList(exceptions);
  errors.push(...eResult.errors);

  return errors.length === 0 ? ok() : fail(...errors);
}
