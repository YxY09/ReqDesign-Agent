/**
 * Shared Mermaid class-diagram relationship parsing helpers.
 *
 * Centralizes the endpoint-extraction regex so that generation-time,
 * validation-time, and evaluation-time checks all agree on which
 * relationship lines (associations `-->`, inheritance `<|--`/`--|>`,
 * composition `*--`, aggregation `o--`, dependency `..>`) count as
 * class references that must resolve to a `class X {}` definition.
 *
 * The pattern is based on SystemDesigner's tested design.ts regex, with
 * the `<|--` / `--|>` inheritance arrows added explicitly so that dangling
 * inheritance endpoints are also flagged (the design.ts alternation only
 * has `<?--`, which matches `--` and `<--` but not the literal `<|--`).
 *
 * The `<?--` alternative is the *optional-less-than* form (`<` made optional
 * by the trailing `?`, then `--`), so it matches both `--` and `<--`.
 * Earlier revisions accidentally used the escaped form `<\?--` (literal
 * question mark), which only matched `<?--` and let leftward association
 * arrows like `A <-- B` slip past endpoint validation (see Warning 1).
 *
 * Cardinality labels such as `"1"` and `"*"` are handled by the optional
 * `"[^"]*"\s+` groups on each side, and `class`/`classDiagram` keywords are
 * excluded by requiring `[A-Za-z_]\w*` identifiers that don't start with a
 * keyword token on a class-definition line.
 */

/**
 * Matches a Mermaid class-diagram relationship line and captures both
 * endpoint class names. Global + multiline so it can scan a whole block.
 *
 * Group 1: left endpoint class name
 * Group 2: right endpoint class name
 *
 * Matches:
 *   Patient "1" --> "*" Doctor : visits
 *   Animal <|-- Dog
 *   Dog --|> Animal
 *   A <-- B          (leftward association; the `<?--` alternative)
 *   User --> Book : borrows
 *   Order *-- OrderItem
 *   Car o-- Engine
 *   Service ..> Logger
 *
 * NOTE: This is the single source of truth for the relationship pattern.
 * Do not inline copies elsewhere — import `isRelationLine` /
 * `matchRelationLine` / `extractRelationEndpoints` instead.
 */
export const CLASS_DIAGRAM_RELATION_RE =
  /^\s*([A-Za-z_]\w*)\s+(?:"[^"]*"\s+)?(?:<?--|-->|--|<\|--|--\|>|o--|\*--|\.\.>)\s+(?:"[^"]*"\s+)?([A-Za-z_]\w*)/gm;

/**
 * Extract all class-name endpoints referenced by relationship lines in a
 * class-diagram block. Returns de-duplicated names in first-seen order.
 *
 * Only relationship lines are parsed; `class X {` definitions and the
 * `classDiagram` header are not matched because the alternation requires a
 * relationship arrow between two identifiers.
 */
export function extractRelationEndpoints(mermaidText: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(CLASS_DIAGRAM_RELATION_RE.source, CLASS_DIAGRAM_RELATION_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(mermaidText)) !== null) {
    for (const name of [m[1], m[2]]) {
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * Test whether a single line is a class-diagram relationship line.
 *
 * Builds a fresh non-global RegExp from the canonical source each call, so
 * repeated `.test()` reuse across lines never leaks `lastIndex` state (the
 * classic trap with sharing a global-flag regex).
 */
export function isRelationLine(line: string): boolean {
  const re = new RegExp(CLASS_DIAGRAM_RELATION_RE.source);
  return re.test(line);
}

/**
 * Match a single line against the relationship pattern, returning the
 * captured endpoint names (group 1 = left, group 2 = right) or null.
 *
 * Like {@link isRelationLine} this uses a fresh non-global RegExp, so it is
 * safe to call in a loop over many lines.
 */
export function matchRelationLine(line: string): RegExpExecArray | null {
  const re = new RegExp(CLASS_DIAGRAM_RELATION_RE.source);
  return re.exec(line);
}
