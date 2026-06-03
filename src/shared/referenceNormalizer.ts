/**
 * Reference Normalizer — resolves entity/actor references to canonical IDs.
 *
 * Used by the merge pipeline to normalize relationship targets before dedup,
 * so that "Suspect" and "E_SUSPECT" (or "嫌疑人") resolve to the same key.
 */

import type { EntityRegistry } from "./types.js";

// ---------------------------------------------------------------------------
// Relation-type normalization
// ---------------------------------------------------------------------------

/** Map of recognized relation-type variants → canonical form. */
const REL_TYPE_MAP: Record<string, string> = {
  // one-to-many
  "one-to-many": "one-to-many",
  "1:n": "one-to-many",
  "1..*": "one-to-many",
  "1..n": "one-to-many",
  "o2m": "one-to-many",
  "onetomany": "one-to-many",
  "one to many": "one-to-many",
  "一对多": "one-to-many",
  // many-to-one
  "many-to-one": "many-to-one",
  "n:1": "many-to-one",
  "*..1": "many-to-one",
  "n..1": "many-to-one",
  "m2o": "many-to-one",
  "manytoone": "many-to-one",
  "many to one": "many-to-one",
  "多对一": "many-to-one",
  // one-to-one
  "one-to-one": "one-to-one",
  "1:1": "one-to-one",
  "1..1": "one-to-one",
  "o2o": "one-to-one",
  "onetoone": "one-to-one",
  "one to one": "one-to-one",
  "一对一": "one-to-one",
  // many-to-many
  "many-to-many": "many-to-many",
  "n:n": "many-to-many",
  "m:n": "many-to-many",
  "*..*": "many-to-many",
  "m2m": "many-to-many",
  "manytomany": "many-to-many",
  "many to many": "many-to-many",
  "多对多": "many-to-many",
};

/**
 * Normalize a relationship type string to a canonical form.
 * E.g. "1:N" → "one-to-many", "o2m" → "one-to-many".
 * Returns the original string if no mapping is found.
 */
export function normalizeRelationType(type: string): string {
  const key = type.trim().toLowerCase();
  return REL_TYPE_MAP[key] ?? type.trim();
}

// ---------------------------------------------------------------------------
// Entity reference resolution
// ---------------------------------------------------------------------------

/**
 * Lazy-built lookup cache for a given registry.
 * Maps lowercase name/alias → canonical id.
 */
interface RegistryLookup {
  /** lowercase name/alias → canonical id */
  nameToId: Map<string, string>;
}

/** Build a lookup map from an EntityRegistry. */
function buildLookup(registry: EntityRegistry): RegistryLookup {
  const nameToId = new Map<string, string>();

  // Entities
  for (const e of registry.entities ?? []) {
    const id = (e.id ?? "").trim();
    if (!id) continue;
    // id itself
    nameToId.set(id.toLowerCase(), id);
    // canonicalName
    const cn = (e.canonicalName ?? "").trim();
    if (cn) nameToId.set(cn.toLowerCase(), id);
    // displayName
    const dn = (e.displayName ?? "").trim();
    if (dn) nameToId.set(dn.toLowerCase(), id);
    // aliases
    for (const alias of e.aliases ?? []) {
      const a = alias.trim();
      if (a) nameToId.set(a.toLowerCase(), id);
    }
  }

  // Actors
  for (const a of registry.actors ?? []) {
    const id = (a.id ?? "").trim();
    if (!id) continue;
    nameToId.set(id.toLowerCase(), id);
    const cn = (a.canonicalName ?? "").trim();
    if (cn) nameToId.set(cn.toLowerCase(), id);
    const dn = (a.displayName ?? "").trim();
    if (dn) nameToId.set(dn.toLowerCase(), id);
    for (const alias of a.aliases ?? []) {
      const al = alias.trim();
      if (al) nameToId.set(al.toLowerCase(), id);
    }
  }

  return { nameToId };
}

/**
 * Resolve an entity reference string to its canonical ID using the registry.
 *
 * Priority:
 * 1. If input already looks like a canonical ID (starts with E_ or A_), return as-is.
 * 2. Look up the input in the registry (case-insensitive) and return the matching id.
 * 3. No match → return the original string (backward-compatible fallback).
 *
 * When `registry` is `undefined`, returns the original string unchanged.
 */
export function resolveEntityRef(
  target: string,
  registry?: EntityRegistry,
): string {
  const trimmed = (target ?? "").trim();
  if (!trimmed) return trimmed;

  // Fast path: already a canonical ID
  if (/^[EA]_/.test(trimmed)) return trimmed;

  if (!registry) return trimmed;

  const lookup = buildLookup(registry);
  const key = trimmed.toLowerCase();
  const match = lookup.nameToId.get(key);
  return match ?? trimmed;
}
