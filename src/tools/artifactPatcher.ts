/**
 * ArtifactPatcher — splits artifacts into sections and applies patch operations.
 *
 * Used by RepairTool for targeted patching instead of full artifact rewrites.
 * Pure utility, no LLM calls, no async.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Section {
  key: string;
  content: string;
}

export interface PatchOp {
  op: "replace_section" | "insert_after" | "remove_section";
  section: string;
  content?: string;
}

// ---------------------------------------------------------------------------
// ArtifactPatcher
// ---------------------------------------------------------------------------

export class ArtifactPatcher {
  // ------------------------------------------------------------------
  // Section parsing
  // ------------------------------------------------------------------

  /** Split an artifact into named sections based on its type. */
  static parseSections(content: unknown, taskType: string): Section[] {
    if (taskType === "diagrams") {
      return ArtifactPatcher._parseDiagramSections(content);
    }

    const text =
      typeof content === "string"
        ? content
        : content === null || content === undefined
          ? ""
          : JSON.stringify(content, null, 2);

    if (!text.trim()) {
      return [{ key: "full", content: "" }];
    }

    // Try ## heading split first
    const h2Sections = ArtifactPatcher._splitByHeading(text, /^## /);
    if (h2Sections.length > 1) return h2Sections;

    // Try ### heading split
    const h3Sections = ArtifactPatcher._splitByHeading(text, /^### /);
    if (h3Sections.length > 1) return h3Sections;

    // Single section
    return [{ key: "full", content: text }];
  }

  private static _parseDiagramSections(content: unknown): Section[] {
    if (
      typeof content === "object" &&
      content !== null &&
      !Array.isArray(content)
    ) {
      const dict = content as Record<string, unknown>;
      const diagramKeys = [
        "class_diagram",
        "activity_diagram",
        "state_diagram",
      ];
      const sections: Section[] = [];

      // Standard diagram keys first (preserving order)
      for (const key of diagramKeys) {
        if (key in dict && typeof dict[key] === "string") {
          sections.push({ key, content: dict[key] as string });
        }
      }

      // Include any non-standard keys
      for (const [key, val] of Object.entries(dict)) {
        if (!diagramKeys.includes(key) && typeof val === "string") {
          sections.push({ key, content: val });
        }
      }

      if (sections.length > 0) return sections;
    }

    // Single string diagram
    const text =
      typeof content === "string" ? content : String(content ?? "");
    return [{ key: "diagram", content: text }];
  }

  private static _splitByHeading(
    text: string,
    headingRegex: RegExp,
  ): Section[] {
    const lines = text.split("\n");
    const sections: Section[] = [];
    let currentKey = "";
    let currentLines: string[] = [];

    for (const line of lines) {
      if (headingRegex.test(line.trim())) {
        if (currentKey || currentLines.some((l) => l.trim())) {
          // For the initial section (no heading found yet), try to extract key from # heading
          let pushKey = currentKey;
          if (!pushKey) {
            const h1Match = currentLines[0]?.trim().match(/^#\s+(.+)/);
            if (h1Match) {
              pushKey = h1Match[1].trim();
            }
          }
          sections.push({
            key: pushKey,
            content: currentLines.join("\n"),
          });
        }
        currentKey = line.trim().replace(/^#+\s*/, "").trim();
        currentLines = [line];
      } else {
        currentLines.push(line);
      }
    }

    if (currentKey || currentLines.some((l) => l.trim())) {
      // For the first section, try to extract a key from # heading if key is empty
      if (!currentKey) {
        const h1Match = currentLines[0]?.trim().match(/^#\s+(.+)/);
        if (h1Match) {
          currentKey = h1Match[1].trim();
        }
      }
      sections.push({ key: currentKey, content: currentLines.join("\n") });
    }

    return sections;
  }

  // ------------------------------------------------------------------
  // Patch application
  // ------------------------------------------------------------------

  /** Apply patch operations to parsed sections, return joined content string. */
  static applyPatches(sections: Section[], patches: PatchOp[]): string {
    const result = sections.map((s) => ({ ...s }));

    for (const patch of patches) {
      const idx = result.findIndex(
        (s) =>
          s.key === patch.section ||
          s.key.toLowerCase().includes(patch.section.toLowerCase()),
      );

      switch (patch.op) {
        case "replace_section":
          if (idx >= 0 && patch.content !== undefined) {
            result[idx] = { key: result[idx].key, content: patch.content };
          }
          break;

        case "insert_after":
          if (idx >= 0 && patch.content !== undefined) {
            const newKey = ArtifactPatcher._extractHeading(patch.content);
            result.splice(idx + 1, 0, { key: newKey, content: patch.content });
          }
          break;

        case "remove_section":
          if (idx >= 0) {
            result.splice(idx, 1);
          }
          break;
      }
    }

    return result.map((s) => s.content).join("\n\n");
  }

  private static _extractHeading(content: string): string {
    const match = content.match(/^#{1,3}\s+(.+)/);
    return match ? match[1].trim() : "section";
  }

  // ------------------------------------------------------------------
  // Reconstruction
  // ------------------------------------------------------------------

  /** Reconstruct sections back into the original artifact format. */
  static reconstruct(sections: Section[], taskType: string): unknown {
    if (taskType === "diagrams") {
      const dict: Record<string, string> = {};
      for (const s of sections) {
        dict[s.key] = s.content;
      }
      return dict;
    }

    return sections.map((s) => s.content).join("\n\n");
  }

  // ------------------------------------------------------------------
  // Validation
  // ------------------------------------------------------------------

  /** Check that patched result is not significantly shorter than original. */
  static validateResult(original: string, patched: string): boolean {
    if (!original.trim()) return true;
    return patched.length >= original.length * 0.5;
  }

  /** Get a formatted listing of section keys for prompt inclusion. */
  static sectionListing(sections: Section[]): string {
    return sections
      .map((s, i) => `${i + 1}. "${s.key}" (${s.content.length} chars)`)
      .join("\n");
  }
}
