/**
 * RequirementNormalizer — deterministic post-processing for analyze results.
 * Zero LLM calls. Runs after single analyze, after merge, and after analyze repair.
 */

export class RequirementNormalizer {
  /** Standard types that should never become entity names. */
  private static readonly _PRIMITIVE_TYPES: Set<string> = new Set([
    "String", "Integer", "Int", "Long", "Double", "Float",
    "Boolean", "Decimal", "BigDecimal", "DateTime", "Date",
    "Object", "List", "Map", "Set", "Array", "UUID",
  ]);
  /**
   * Normalize an analyze result in-place and return it.
   */
  static normalize(analysis: Record<string, unknown>): Record<string, unknown> {
    if (!analysis || typeof analysis !== "object") return analysis;

    RequirementNormalizer._removeShellEntities(analysis);
    RequirementNormalizer._canonicalizeActorNames(analysis);
    RequirementNormalizer._normalizeAcronyms(analysis);
    RequirementNormalizer._dedupConstraints(analysis);
    RequirementNormalizer._splitNestedEntities(analysis);
    RequirementNormalizer._ensureUserRole(analysis);

    return analysis;
  }

  // ------------------------------------------------------------------
  // 1. Remove shell entities (only id + status), merge role names into User.role
  // ------------------------------------------------------------------
  private static _removeShellEntities(analysis: Record<string, unknown>): void {
    const entities = RequirementNormalizer._getEntities(analysis);
    if (!entities) return;

    const actors = RequirementNormalizer._getActorNames(analysis);
    const removedRoles: string[] = [];

    const kept: unknown[] = [];
    for (const ent of entities) {
      if (typeof ent !== "object" || ent === null) { kept.push(ent); continue; }
      const e = ent as Record<string, unknown>;
      const name = String(e.name ?? "").trim();
      const attrs = Array.isArray(e.attributes) ? e.attributes as Record<string, unknown>[] : [];

      // Check if this is a shell entity: only id + status fields, no relationships
      const isShell = actors.some(a => a.toLowerCase() === name.toLowerCase()) &&
        attrs.length <= 2 &&
        attrs.every(a => {
          const n = String(a.name ?? "").toLowerCase();
          return n === "id" || n === "status" || n.endsWith("id");
        }) &&
        (!Array.isArray(e.relationships) || e.relationships.length === 0);

      if (isShell) {
        removedRoles.push(name);
      } else {
        kept.push(ent);
      }
    }

    if (removedRoles.length > 0) {
      analysis.entities = kept;
      // Store removed roles for User.role merging (done in _ensureUserRole)
      (analysis as Record<string, unknown>).__removedRoles = removedRoles;
    }
  }

  // ------------------------------------------------------------------
  // 2. Canonicalize actor names — deduplicate synonyms (case-insensitive)
  // ------------------------------------------------------------------
  private static _canonicalizeActorNames(analysis: Record<string, unknown>): void {
    const actors = Array.isArray(analysis.actors) ? analysis.actors : [];
    if (actors.length <= 1) return;

    // Check if actors are strings or objects
    const isStringArray = typeof actors[0] === "string";

    if (isStringArray) {
      const seen = new Map<string, string>(); // lowercase -> canonical name
      const kept: string[] = [];
      for (const a of actors) {
        const name = String(a).trim();
        if (!name) continue;
        const lower = name.toLowerCase();
        if (!seen.has(lower)) {
          seen.set(lower, name);
          kept.push(name);
        }
      }
      if (kept.length < actors.length) {
        analysis.actors = kept;
      }
      return;
    }

    // Object array
    const actorObjs = actors as Record<string, unknown>[];
    const seen = new Map<string, string>();
    const kept: Record<string, unknown>[] = [];
    const renames = new Map<string, string>();

    for (const actor of actorObjs) {
      const name = String(actor.name ?? "").trim();
      if (!name) continue;
      const lower = name.toLowerCase();
      if (seen.has(lower)) {
        renames.set(name, seen.get(lower)!);
      } else {
        seen.set(lower, name);
        kept.push(actor);
      }
    }

    if (kept.length < actorObjs.length) {
      analysis.actors = kept;
    }

    if (renames.size > 0) {
      const functions = Array.isArray(analysis.functions) ? analysis.functions as Record<string, unknown>[] : [];
      for (const fn of functions) {
        const related = Array.isArray(fn.related_actors) ? fn.related_actors as string[] : [];
        fn.related_actors = related.map(a => renames.get(a) ?? a);
      }
    }
  }

  // ------------------------------------------------------------------
  // 3. Normalize acronyms to PascalCase (SKU→Sku, XML→Xml, etc.)
  // ------------------------------------------------------------------
  private static _normalizeAcronyms(analysis: Record<string, unknown>): void {
    const targets: Array<{ arr: unknown[] | undefined; field: string }> = [
      { arr: RequirementNormalizer._getEntities(analysis), field: "name" },
      { arr: Array.isArray(analysis.actors) ? analysis.actors as unknown[] : undefined, field: "name" },
    ];

    for (const { arr, field } of targets) {
      if (!arr) continue;
      for (const item of arr) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        const val = String(rec[field] ?? "");
        const normalized = RequirementNormalizer._toPascalCase(val);
        if (normalized !== val) {
          rec[field] = normalized;
        }
      }
    }

    // Also normalize entity names referenced in relationships and functions
    const entities = RequirementNormalizer._getEntities(analysis);
    if (entities) {
      for (const ent of entities) {
        if (typeof ent !== "object" || ent === null) continue;
        const e = ent as Record<string, unknown>;
        const rels = Array.isArray(e.relationships) ? e.relationships as Record<string, unknown>[] : [];
        for (const rel of rels) {
          const target = String(rel.target ?? "");
          const normalized = RequirementNormalizer._toPascalCase(target);
          if (normalized !== target) rel.target = normalized;
        }
      }
    }
  }

  /**
   * Convert ALL_CAPS acronyms within a PascalCase name to title case.
   * E.g. "SKU" → "Sku", "XMLTag" → "XmlTag", "XMLRegistry" → "XmlRegistry"
   * Preserves names that are already PascalCase.
   */
  private static _toPascalCase(name: string): string {
    // Only transform names that are ENTIRELY uppercase (e.g. SKU, XML, API).
    // Mixed-case like XmlTag, XMLTag, ApiResponse are already valid PascalCase.
    if (/^[A-Z]{2,}$/.test(name)) {
      return name.charAt(0) + name.slice(1).toLowerCase();
    }
    return name;
  }

  // ------------------------------------------------------------------
  // 4. Deduplicate constraints by description
  // ------------------------------------------------------------------
  private static _dedupConstraints(analysis: Record<string, unknown>): void {
    const constraints = Array.isArray(analysis.constraints)
      ? analysis.constraints as Record<string, unknown>[]
      : [];
    if (constraints.length <= 1) return;

    const seen = new Map<string, Record<string, unknown>>(); // normalized desc → constraint
    const kept: Record<string, unknown>[] = [];

    for (const c of constraints) {
      const desc = String(c.description ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      if (!desc) { kept.push(c); continue; }

      const existing = seen.get(desc);
      if (existing) {
        // Merge: keep the one with more info or earlier ID
        // If IDs differ, keep the earlier one
      } else {
        seen.set(desc, c);
        kept.push(c);
      }
    }

    if (kept.length < constraints.length) {
      analysis.constraints = kept;
    }
  }

  // ------------------------------------------------------------------
  // 5. Ensure User entity has a role attribute
  // ------------------------------------------------------------------
  private static _ensureUserRole(analysis: Record<string, unknown>): void {
    const entities = RequirementNormalizer._getEntities(analysis);
    if (!entities) return;

    const actors = RequirementNormalizer._getActorNames(analysis);
    const removedRoles = (analysis as Record<string, unknown>).__removedRoles as string[] | undefined;
    const allRoles = [...new Set([...actors, ...(removedRoles ?? [])])];

    // Clean up internal field
    delete (analysis as Record<string, unknown>).__removedRoles;

    if (allRoles.length === 0) return;

    // Find User entity (case-insensitive)
    let userEntity: Record<string, unknown> | undefined;
    for (const ent of entities) {
      if (typeof ent !== "object" || ent === null) continue;
      const name = String((ent as Record<string, unknown>).name ?? "").toLowerCase();
      if (name === "user" || name === "useraccount") {
        userEntity = ent as Record<string, unknown>;
        break;
      }
    }

    if (!userEntity) return;

    const attrs = Array.isArray(userEntity.attributes)
      ? userEntity.attributes as Record<string, unknown>[]
      : [];

    // Check if role attribute already exists
    const hasRole = attrs.some(a => String(a.name ?? "").toLowerCase() === "role");
    if (!hasRole) {
      attrs.push({
        name: "role",
        type: "String",
        description: `角色: ${allRoles.join("、")}`,
      });
      userEntity.attributes = attrs;
    } else {
      // Update description to include all roles
      const roleAttr = attrs.find(a => String(a.name ?? "").toLowerCase() === "role");
      if (roleAttr && !String(roleAttr.description ?? "").includes(allRoles[0])) {
        roleAttr.description = `角色: ${allRoles.join("、")}`;
      }
    }
  }

  // ------------------------------------------------------------------
  // 6. Split nested Object/List entities into independent entities
  // ------------------------------------------------------------------
  /**
   * The most common LLM failure mode: writing entity-like attributes as
   * Object or List<X> instead of creating independent entities.
   * This scanner detects those and promotes them to top-level entities.
   *
   * Patterns detected:
   *   type === "Object"       → new entity (name derived from attribute)
   *   type is "List<X>"       → new entity X (only if X is PascalCase)
   *   type is "String" but name looks like entity ref → skip (too many false positives)
   */
  private static _splitNestedEntities(analysis: Record<string, unknown>): void {
    const entities = RequirementNormalizer._getEntities(analysis);
    if (!entities || entities.length === 0) return;

    const entityObjs = entities as Record<string, unknown>[];
    const entityNames = new Set(entityObjs.map(e => String(e.name ?? "").trim()).filter(Boolean));
    const newEntities: Record<string, unknown>[] = [];

    for (const entity of entityObjs) {
      const attrs = Array.isArray(entity.attributes)
        ? (entity.attributes as Record<string, unknown>[])
        : [];
      if (attrs.length === 0) continue;

      const replacements: Array<{ attr: Record<string, unknown>; newEntityName: string }> = [];

      for (const attr of attrs) {
        const type = String(attr.type ?? "").trim();
        const name = String(attr.name ?? "").trim();
        if (!name) continue;

        let newEntityName = "";

        // Pattern A: List<X> where X is a PascalCase entity name (LLM literally wrote the name)
        const listMatch = type.match(/^List<([A-Z][a-zA-Z0-9]+)>$/);
        if (listMatch) {
          newEntityName = listMatch[1];
        }

        // Pattern B: Plain Object type → skip. Attribute name→entity name
        // derivation is too unreliable (suffix stripping creates garbage names).
        // The LLM already creates most entities; we only fix the List<X> nesting case.
        // If (type === "Object") { ... }

        if (!newEntityName || entityNames.has(newEntityName)) continue;
        if (RequirementNormalizer._PRIMITIVE_TYPES.has(newEntityName)) continue;
        if (newEntities.some(e => e.name === newEntityName)) continue;

        replacements.push({ attr, newEntityName });
        entityNames.add(newEntityName);
      }

      // Apply replacements and create new entities
      for (const { attr, newEntityName } of replacements) {
        const type = String(attr.type ?? "").trim();
        const isList = type.startsWith("List<");

        // Change attribute type to Long reference
        attr.type = isList ? "List<Long>" : "Long";
        attr.description = String(attr.description ?? "") + ` → 关联实体 ${newEntityName}`;

        // Create stub entity
        const parentName = String(entity.name ?? "");
        newEntities.push({
          name: newEntityName,
          description: `${parentName}的${newEntityName}`,
          attributes: [
            { name: "id", type: "Long", description: `${newEntityName}唯一标识` },
            { name: `${RequirementNormalizer._lowerFirst(parentName)}Id`, type: "Long", description: `所属${parentName}ID` },
          ],
          relationships: [
            { target: parentName, type: "many-to-one", description: `${newEntityName}属于${parentName}` },
          ],
        });

        // Add relationship from parent to new entity
        const rels = Array.isArray(entity.relationships)
          ? (entity.relationships as Record<string, unknown>[])
          : [];
        rels.push({
          target: newEntityName,
          type: isList ? "one-to-many" : "one-to-one",
          description: `${parentName}拥有${newEntityName}`,
        });
        entity.relationships = rels;
      }
    }

    if (newEntities.length > 0) {
      entityObjs.push(...newEntities);
      analysis.entities = entityObjs;
    }
  }

  private static _lowerFirst(s: string): string {
    if (s.length === 0) return s;
    return s.charAt(0).toLowerCase() + s.slice(1);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  private static _getEntities(analysis: Record<string, unknown>): unknown[] | undefined {
    const entities = analysis.entities;
    return Array.isArray(entities) ? entities : undefined;
  }

  private static _getActorNames(analysis: Record<string, unknown>): string[] {
    const actors = Array.isArray(analysis.actors) ? analysis.actors : [];
    return actors.map(a => {
      if (typeof a === "string") return a.trim();
      if (typeof a === "object" && a !== null) return String((a as Record<string, unknown>).name ?? "").trim();
      return "";
    }).filter(Boolean);
  }
}
