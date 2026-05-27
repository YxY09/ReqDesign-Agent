/**
 * Unified ID assignment and cross-reference fixer.
 *
 * Assigns canonical IDs (E001, F001, C001, X001) to merged analysis records
 * sorted by name (entities, functions) or existing id (constraints, exceptions).
 * Then fixes cross-references across the merged result.
 */

import { isRecord } from "../utils/isRecord.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IdMap {
  entityMap: Map<string, string>;
  functionMap: Map<string, string>;
  constraintMap: Map<string, string>;
  exceptionMap: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function arr(
  merged: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const raw = merged[key];
  if (!Array.isArray(raw)) {
    const empty: Array<Record<string, unknown>> = [];
    merged[key] = empty;
    return empty;
  }
  const filtered = raw.filter(
    (item): item is Record<string, unknown> => isRecord(item),
  );
  merged[key] = filtered;
  return filtered;
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Build a 3-digit padded ID like E001, F012, etc. */
function padded(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// assignCanonicalIds
// ---------------------------------------------------------------------------

/**
 * Assign canonical IDs to entities, functions, constraints, and exceptions.
 *
 * - Entities sorted by `name` → E001, E002, …
 * - Functions sorted by `name` → F001, F002, …
 * - Constraints sorted by existing `id` → C001, C002, …
 * - Exceptions sorted by existing `id` → X001, X002, …
 *
 * Returns a **deep copy** with new IDs and an `IdMap` that maps both old IDs
 * and names to the new canonical IDs.
 */
export function assignCanonicalIds(
  merged: Record<string, unknown>,
): { result: Record<string, unknown>; idMap: IdMap } {
  const result = copy(merged);

  const entityMap = new Map<string, string>();
  const functionMap = new Map<string, string>();
  const constraintMap = new Map<string, string>();
  const exceptionMap = new Map<string, string>();

  // --- Entities (sorted by name) ---
  const entities = arr(result, "entities");
  entities.sort((a, b) =>
    String(a.name ?? "").localeCompare(String(b.name ?? "")),
  );
  let idx = 1;
  for (const e of entities) {
    const newId = padded("E", idx);
    const oldId = typeof e.id === "string" ? e.id : "";
    const name = typeof e.name === "string" ? e.name : "";
    if (oldId) entityMap.set(oldId, newId);
    if (name) entityMap.set(name, newId);
    e.id = newId;
    idx++;
  }

  // --- Functions (sorted by name) ---
  const functions = arr(result, "functions");
  functions.sort((a, b) =>
    String(a.name ?? "").localeCompare(String(b.name ?? "")),
  );
  idx = 1;
  for (const f of functions) {
    const newId = padded("F", idx);
    const oldId = typeof f.id === "string" ? f.id : "";
    const name = typeof f.name === "string" ? f.name : "";
    if (oldId) functionMap.set(oldId, newId);
    if (name) functionMap.set(name, newId);
    f.id = newId;
    idx++;
  }

  // --- Constraints (sorted by existing id) ---
  const constraints = arr(result, "constraints");
  constraints.sort((a, b) =>
    String(a.id ?? "").localeCompare(String(b.id ?? "")),
  );
  idx = 1;
  for (const c of constraints) {
    const newId = padded("C", idx);
    const oldId = typeof c.id === "string" ? c.id : "";
    if (oldId) constraintMap.set(oldId, newId);
    c.id = newId;
    idx++;
  }

  // --- Exceptions (sorted by existing id) ---
  const exceptions = arr(result, "exceptions");
  exceptions.sort((a, b) =>
    String(a.id ?? "").localeCompare(String(b.id ?? "")),
  );
  idx = 1;
  for (const ex of exceptions) {
    const newId = padded("X", idx);
    const oldId = typeof ex.id === "string" ? ex.id : "";
    if (oldId) exceptionMap.set(oldId, newId);
    ex.id = newId;
    idx++;
  }

  return {
    result,
    idMap: { entityMap, functionMap, constraintMap, exceptionMap },
  };
}

// ---------------------------------------------------------------------------
// fixCrossReferences
// ---------------------------------------------------------------------------

/**
 * Fix cross-references in a merged analysis **in place** using the given
 * `IdMap`:
 *
 * - `entity.relationships[].target` → entity map
 * - `constraint.related_functions[]` → function map
 * - `constraint.related_entities[]` → entity map
 * - `exception.related_constraints[]` → constraint map
 *
 * Unrecognized references are left unchanged.
 */
export function fixCrossReferences(
  merged: Record<string, unknown>,
  idMap: IdMap,
): void {
  // --- Entity relationship targets ---
  for (const entity of arr(merged, "entities")) {
    const rels = entity.relationships;
    if (!Array.isArray(rels)) continue;
    for (const rel of rels) {
      if (!isRecord(rel)) continue;
      const target = rel.target;
      if (typeof target !== "string") continue;
      const mapped = idMap.entityMap.get(target);
      if (mapped !== undefined) {
        rel.target = mapped;
      }
    }
  }

  // --- Constraint related_functions ---
  for (const c of arr(merged, "constraints")) {
    const rf = c.related_functions;
    if (Array.isArray(rf)) {
      c.related_functions = (rf as string[]).map(
        (ref) => idMap.functionMap.get(ref) ?? ref,
      );
    }

    // --- Constraint related_entities ---
    const re = c.related_entities;
    if (Array.isArray(re)) {
      c.related_entities = (re as string[]).map(
        (ref) => idMap.entityMap.get(ref) ?? ref,
      );
    }
  }

  // --- Exception related_constraints ---
  for (const ex of arr(merged, "exceptions")) {
    const rc = ex.related_constraints;
    if (Array.isArray(rc)) {
      ex.related_constraints = (rc as string[]).map(
        (ref) => idMap.constraintMap.get(ref) ?? ref,
      );
    }
  }
}
