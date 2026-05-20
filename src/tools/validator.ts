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
   */
  static validate(
    analysis: Record<string, unknown> | undefined | null,
    artifactType: string,
    content: unknown,
  ): unknown | null {
    if (!analysis) return null;

    if (artifactType === "design" && typeof content === "string") {
      return PostGenerationValidator._cleanDesign(content, analysis);
    }
    if (artifactType === "diagrams" && typeof content === "object" && content !== null) {
      return PostGenerationValidator._cleanDiagrams(content as Record<string, unknown>, analysis);
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
  ): Record<string, unknown> | null {
    const classDiagram = String(obj.class_diagram ?? "");
    if (!classDiagram) return null;

    const entities = PostGenerationValidator._getEntityNames(analysis);
    if (entities.length === 0) return null;

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
      // Check each analysis entity to see if className is a rename
      for (const entityName of entities) {
        const entNorm = entityName.toLowerCase().replace(/[_\-\s]/g, "");
        if (classNorm === entNorm) continue;
        if (classNorm.includes(entNorm) && classNorm.length > entNorm.length) {
          // className is a superset of entityName → rename back
          fixed = fixed.split(className).join(entityName);
          existingClasses.delete(className);
          existingClasses.set(entityName, entityName);
          changed = true;
          break;
        }
      }
    }

    // 2. Remove classes NOT in analysis entities
    const analysisSet = new Set(entities);
    for (const [className] of existingClasses) {
      if (!analysisSet.has(className)) {
        // Check if this class is a substring match with any analysis entity
        // This catches cases like "Registry" vs "XmlRegistry" (partial match)
        const isAlias = entities.some(e =>
          e.toLowerCase().includes(className.toLowerCase()) ||
          className.toLowerCase().includes(e.toLowerCase()),
        );
        if (!isAlias) {
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
    return fns.map(f => String(f.id ?? "").trim()).filter(id => /^F\d+$/.test(id));
  }

  private static _getEntityNames(analysis: Record<string, unknown>): string[] {
    const ents = Array.isArray(analysis.entities)
      ? (analysis.entities as Array<Record<string, unknown>>)
      : [];
    return ents
      .map(e => String(e.name ?? "").trim())
      .filter(n => n && !/[\u4e00-\u9fff]/.test(n));
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
