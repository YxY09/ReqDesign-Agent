/**
 * PostGenerationValidator — deterministic cleanup of downstream artifacts.
 *
 * Runs when design/diagrams/tests artifacts are stored, before evaluation.
 * Fixes the most common LLM compliance failures:
 *   1. Ghost function IDs (design/tests reference IDs not in analysis)
 *   2. Extra classes in class diagram (not in analysis entities)
 *   3. Renamed entity names in class diagram
 *
 * All fixes are purely rule-based, zero LLM.
 */

export class PostGenerationValidator {
  /**
   * Validate a generated artifact against the current analysis.
   * Returns cleaned content, or null if no changes needed.
   *
   * `domainModelJson` (optional) is the authoritative domain conceptual model.
   * When present, its concept names are part of the diagram preserve-set so
   * faithful concept classes (entities, association/line-item entities,
   * generalization roles) survive the extra-class stripping. Without it the
   * validator falls back to analysis-entity-only behavior.
   */
  static validate(
    analysis: Record<string, unknown> | undefined | null,
    artifactType: string,
    content: unknown,
    domainModelJson?: Record<string, unknown> | null,
  ): unknown | null {
    if (!analysis) return null;

    if (artifactType === "design" && typeof content === "string") {
      return PostGenerationValidator._cleanDesign(content, analysis);
    }
    if (artifactType === "diagrams" && typeof content === "object" && content !== null) {
      return PostGenerationValidator._cleanDiagrams(content as Record<string, unknown>, analysis, domainModelJson);
    }
    if (artifactType === "tests" && typeof content === "string") {
      return PostGenerationValidator._cleanTests(content, analysis);
    }

    return null;
  }

  // ------------------------------------------------------------------
  // Design: remove ghost function IDs and constraint IDs
  // ------------------------------------------------------------------
  private static _cleanDesign(
    text: string,
    analysis: Record<string, unknown>,
  ): string | null {
    let fixed = text;

    // Remove ghost function IDs not in analysis
    const analysisIds = PostGenerationValidator._getFunctionIds(analysis);
    if (analysisIds.length > 0) {
      const ghostIds = PostGenerationValidator._findGhostIds(text, analysisIds);
      for (const id of ghostIds) {
        // Remove module table rows referencing ghost IDs
        fixed = fixed.replace(
          new RegExp(`\\|[^\\n]*\\b${PostGenerationValidator._escapeRx(id)}\\b[^\\n]*\\|\\n`, "g"),
          "",
        );
        // Remove standalone references
        fixed = fixed.replace(
          new RegExp(`\\b${PostGenerationValidator._escapeRx(id)}\\b`, "g"),
          "",
        );
      }
    }

    return fixed !== text ? fixed : null;
  }

  // ------------------------------------------------------------------
  // Diagrams: remove extra classes, fix renamed entity names
  // ------------------------------------------------------------------
  private static _cleanDiagrams(
    obj: Record<string, unknown>,
    analysis: Record<string, unknown>,
    domainModelJson?: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    const classDiagram = String(obj.class_diagram ?? "");
    if (!classDiagram) return null;

    const entities = PostGenerationValidator._getEntityNames(analysis);
    // Domain-model concept names are authoritative domain classes (entities,
    // association/line-item entities, value objects, AND enumerations). They
    // must never be stripped as "extra" classes even when they are not (yet)
    // analysis entities — e.g. generalization roles, enumerations, or
    // split-out relationship entities.
    const domainConceptNames = PostGenerationValidator._getDomainConceptNames(domainModelJson);
    const preserve = new Set<string>([...entities, ...domainConceptNames]);
    if (preserve.size === 0) return null;

    // Parse existing classes
    const classRe = /class\s+(\w+)\s*\{/g;
    const existingClasses = new Map<string, string>(); // name -> full match group
    let m: RegExpExecArray | null;
    while ((m = classRe.exec(classDiagram)) !== null) {
      existingClasses.set(m[1], m[0]);
    }

    let fixed = classDiagram;
    let changed = false;

    // 1. Fix renamed entity names (superset match: ShippingAddress contains Address)
    for (const [className] of existingClasses) {
      const classNorm = className.toLowerCase().replace(/[_\-\s]/g, "");
      if (entities.some(e => e.toLowerCase().replace(/[_\-\s]/g, "") === classNorm)) {
        continue; // exact match, correct
      }
      // Authoritative domain concept names must NEVER be renamed, even when
      // they share a substring with an analysis-entity name. A domain concept
      // (e.g. an abstract base entity `BaseUser`) that contains an analysis
      // entity name (`User`) is a distinct, faithful concept — renaming it
      // corrupts the diagram. Only classes outside the preserve-set are rename
      // candidates.
      if (preserve.has(className)) {
        continue;
      }
      // Check each analysis entity to see if className is a rename
      const candidates: string[] = [];
      for (const entityName of entities) {
        const entNorm = entityName.toLowerCase().replace(/[_\-\s]/g, "");
        if (classNorm === entNorm) continue;
        // Superset: ShippingAddress contains Address
        // Subset: Registry is part of XmlRegistry
        if ((classNorm.includes(entNorm) && classNorm.length > entNorm.length) ||
            (entNorm.includes(classNorm) && entNorm.length > classNorm.length)) {
          candidates.push(entityName);
        }
      }
      // Only rename if exactly one unambiguous candidate AND target doesn't exist
      if (candidates.length === 1) {
        const entityName = candidates[0];
        // Don't rename if target already exists in diagram (would create duplicate)
        if (existingClasses.has(entityName)) {
          continue;
        }
        fixed = fixed.split(className).join(entityName);
        existingClasses.delete(className);
        existingClasses.set(entityName, entityName);
        changed = true;
      }
    }

    // 2. Remove classes NOT in the preserve set (analysis entities ∪ domain
    //    concept names). A class that is a faithful domain concept survives;
    //    only genuinely extra classes (implementation helpers, fabrications)
    //    are removed.
    for (const [className] of existingClasses) {
      if (preserve.has(className)) {
        continue;
      }
      // Check if this class is a substring alias for a preserved entity.
      // If the alias target already has a class in the diagram, remove this
      // duplicate. Otherwise keep it (it might be a legitimate rename candidate).
      const aliasMatch = [...preserve].find(e => {
        const en = e.toLowerCase();
        const cn = className.toLowerCase();
        return (en.includes(cn) && en !== cn) || (cn.includes(en) && cn !== en);
      });
      const shouldRemove = !aliasMatch || existingClasses.has(aliasMatch);
      if (shouldRemove) {
        // Remove the class definition block
        const blockRe = new RegExp(
          `\\s*class\\s+${PostGenerationValidator._escapeRx(className)}\\s*\\{` +
          `[\\s\\S]*?\\}`,
          "g",
        );
        fixed = fixed.replace(blockRe, "");
        // Remove any remaining line containing the removed class as a word
        fixed = fixed.replace(
          new RegExp(`^.*\\b${PostGenerationValidator._escapeRx(className)}\\b.*$`, "gm"),
          "",
        );
        changed = true;
      }
    }

    if (changed) {
      return { ...obj, class_diagram: fixed };
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Tests: remove ghost function IDs
  // ------------------------------------------------------------------
  private static _cleanTests(
    text: string,
    analysis: Record<string, unknown>,
  ): string | null {
    const analysisIds = PostGenerationValidator._getFunctionIds(analysis);
    if (analysisIds.length === 0) return null;

    const ghostIds = PostGenerationValidator._findGhostIds(text, analysisIds);
    if (ghostIds.length === 0) return null;

    let fixed = text;
    for (const id of ghostIds) {
      // Remove test case blocks referencing ghost IDs
      fixed = fixed.replace(
        new RegExp(
          `##[^\\n]*\\n(?:-[^\\n]*\\n)*?\\s*-\\s\\*\\*测试对象\\*\\*[^\\n]*\\b${PostGenerationValidator._escapeRx(id)}\\b[^\\n]*\\n(?:-[^\\n]*\\n)*`,
          "g",
        ),
        "",
      );
      // Fallback: simple removal
      fixed = fixed.replace(
        new RegExp(`\\b${PostGenerationValidator._escapeRx(id)}\\b`, "g"),
        "",
      );
    }

    return fixed !== text ? fixed : null;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  private static _getFunctionIds(analysis: Record<string, unknown>): string[] {
    const fns = Array.isArray(analysis.functions)
      ? (analysis.functions as Array<Record<string, unknown>>)
      : [];
    return fns
      .flatMap((f) => [f.displayId, f.id])
      .map((id) => String(id ?? "").trim())
      .filter((id) => /^F\d+$/.test(id));
  }

  private static _getEntityNames(analysis: Record<string, unknown>): string[] {
    const ents = Array.isArray(analysis.entities)
      ? (analysis.entities as Array<Record<string, unknown>>)
      : [];
    // Keep CJK entity names too — stripping them caused faithful CJK-named
    // domain concepts to be removed from the class diagram as "extra" classes.
    return ents
      .map(e => String(e.name ?? "").trim())
      .filter(n => n);
  }

  /**
   * Extract the class-block-worthy concept names from the authoritative
   * domain model. Entities, association/line-item entities, value objects,
   * AND enumerations are all included so faithful concept classes (including
   * `<<enumeration>>` blocks) survive the validator's extra-class stripping.
   */
  private static _getDomainConceptNames(
    domainModelJson: Record<string, unknown> | null | undefined,
  ): string[] {
    if (!domainModelJson) return [];
    const concepts = Array.isArray(domainModelJson.concepts)
      ? (domainModelJson.concepts as Array<Record<string, unknown>>)
      : [];
    const names: string[] = [];
    for (const concept of concepts) {
      // Only PascalCase / word-shaped names are valid Mermaid class names and
      // safe to preserve; mixed CJK identifiers are left to the analysis set.
      const name = String(concept.name ?? "").trim();
      if (name && /^\w+$/.test(name) && !/[\u4e00-\u9fff]/.test(name)) {
        names.push(name);
      }
    }
    return names;
  }

  private static _findGhostIds(text: string, validIds: string[]): string[] {
    const idRe = /\b(F\d{1,4})\b/g;
    const validSet = new Set(validIds);
    const ghosts: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(text)) !== null) {
      if (!validSet.has(m[1])) ghosts.push(m[1]);
    }
    return [...new Set(ghosts)];
  }

  private static _escapeRx(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
