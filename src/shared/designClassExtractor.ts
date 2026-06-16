/**
 * Shared extractor for Mermaid class-definition blocks parsed from a design
 * document's "核心类/接口设计" (core class) table.
 *
 * Both {@link import("../tools/generation").GenerationTool} (generation-time
 * patching) and {@link import("../tools/repair").RepairTool} (repair-time
 * fix-up) used near-duplicate ~50-line implementations that differed in two
 * silently-divergent ways:
 *   - the generation variant never parsed the "关键方法" column (cells[3]);
 *   - the generation variant always injected a synthetic `-Long id` attribute
 *     when the attribute cell was empty, while the repair variant skipped a
 *     class that had neither attributes nor methods.
 *
 * Centralizing here removes the duplication AND the behavioral divergence:
 * the merged extractor always parses both columns and skips a class that
 * resolves to neither attributes nor methods (mirrors the repair variant,
 * which is the more complete / tested behavior).
 */

/**
 * Parse the design document's core-class table and return a map of
 * className -> full Mermaid `class X { ... }` block string (attributes use
 * `-`, methods use `+`).
 *
 * Expected table columns: `| 类名 | 类型/职责 | 关键属性 | 关键方法 |`.
 * A class with no parseable attribute AND no parseable method is skipped
 * (returns no entry) so callers can fall back to their own resolution.
 *
 * Attribute cell syntax:  `attr1 (Type), attr2 (Type)`  ->  `-Type attr1`
 * Method cell syntax:     `method1(), method2(Param)`   ->  `+method1()`
 */
export function extractDesignClassDefinitions(designText: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!designText) return result;

  const sectionMatch = designText.match(/核心类[^\n]*设计[\s\S]*?(?=\n##\s[^#]|\n##[^#]|$)/);
  if (!sectionMatch) return result;
  const section = sectionMatch[0];

  const rows = section.split("\n");
  for (const row of rows) {
    const trimmed = row.trim();
    if (!trimmed.startsWith("|")) continue;
    if (trimmed.includes("---")) continue; // table separator row
    if (/^\|\s*类名/.test(trimmed)) continue; // header row

    const cells = trimmed.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;

    const className = cells[0];
    if (!/^[A-Z][a-zA-Z0-9]+$/.test(className)) continue;

    // Attributes: "attr1 (Type), attr2 (Type)"  ->  "-Type attr1"
    const attrText = cells[2] || "";
    const attrMatches = [...attrText.matchAll(/(\w+)\s*\((\w+)\)/g)];
    const attrLines = attrMatches.length > 0
      ? attrMatches.map((m) => `        -${m[2]} ${m[1]}`).join("\n")
      : "";

    // Methods: "method1(), method2(Param)"  ->  "+method1()"
    const methodText = cells[3] || "";
    const methodMatches = [...methodText.matchAll(/(\w+\([^)]*\))/g)];
    const methodLines = methodMatches.length > 0
      ? methodMatches.map((m) => `        +${m[1]}`).join("\n")
      : "";

    // Skip a class that resolves to neither attributes nor methods — the
    // caller's own resolution / downstream checks handle it instead of
    // silently synthesizing a fake `-Long id`.
    if (!attrLines && !methodLines) continue;

    const block = `    class ${className} {\n${attrLines}${methodLines ? "\n" + methodLines : ""}\n    }`;
    result.set(className, block);
  }

  return result;
}
