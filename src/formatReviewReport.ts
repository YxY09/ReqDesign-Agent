/**
 * Formats a reviewResult object into a Markdown report string.
 *
 * Input shape (from WorkflowState.addVerdict):
 * ```
 * {
 *   passed: boolean,
 *   issues: Array<{
 *     severity: "blocker" | "major" | "minor",
 *     target?: string,
 *     targetType?: string,
 *     description: string,
 *     suggestion?: string,
 *     scope?: string,
 *   }>,
 * }
 * ```
 */
const SEVERITY_LABELS: Record<string, string> = {
  blocker: "BLOCKER",
  major: "MAJOR",
  minor: "MINOR",
};



export function formatReviewReport(
  reviewResult: Record<string, unknown> | null | undefined,
): string {
  const lines: string[] = [];

  lines.push("# Review Report\n");

  // Summary
  const safe = reviewResult && typeof reviewResult === "object" ? reviewResult : {};
  const issues = Array.isArray(safe["issues"])
    ? (safe["issues"] as Record<string, unknown>[])
    : [];

  const severityCounts: Record<string, number> = {
    blocker: 0,
    major: 0,
    minor: 0,
  };

  for (const issue of issues) {
    if (typeof issue === "object" && issue !== null) {
      const sev = String(issue["severity"] ?? "").trim();
      if (sev in severityCounts) {
        severityCounts[sev]++;
      }
    }
  }

  lines.push("## Summary\n");
  lines.push(`Total issues: ${issues.length}`);
  lines.push(`- Blockers: ${severityCounts["blocker"]}`);
  lines.push(`- Major: ${severityCounts["major"]}`);
  lines.push(`- Minor: ${severityCounts["minor"]}`);
  lines.push("");

  // Issues
  lines.push("## Issues\n");

  for (const issue of issues) {
    if (typeof issue !== "object" || issue === null) continue;

    const sev = String(issue["severity"] ?? "").trim();
    const label = SEVERITY_LABELS[sev] ?? sev.toUpperCase();
    const description = String(issue["description"] ?? "");
    const suggestion = String(issue["suggestion"] ?? "");
    const scope = String(issue["scope"] ?? "");
    const target = String(issue["target"] ?? "");
    const targetType = String(issue["targetType"] ?? "");

    lines.push(`### [${label}] ${description}`);

    if (target && targetType) {
      lines.push(`Target: ${target} (${targetType})`);
    } else if (target) {
      lines.push(`Target: ${target}`);
    }

    if (scope) {
      lines.push(`Scope: ${scope}`);
    }

    if (suggestion) {
      lines.push(`Suggestion: ${suggestion}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}
