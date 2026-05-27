/**
 * buildRegistrySummary — formats an EntityRegistry into a concise text summary
 * for injection into prompts.
 */

import type { EntityRegistry } from "./types.js";

export function buildRegistrySummary(registry: EntityRegistry): string {
  if (!registry || (registry.entities.length === 0 && registry.functions.length === 0)) {
    return "";
  }

  const lines: string[] = [];

  if (registry.entities.length > 0) {
    lines.push("### 实体");
    for (const e of registry.entities) {
      const aliasStr = e.aliases.length > 0 ? ` (别名: ${e.aliases.join(", ")})` : "";
      lines.push(`- ${e.id} | ${e.canonicalName} | ${e.displayName}${aliasStr}`);
    }
  }

  if (registry.functions.length > 0) {
    lines.push("### 功能");
    for (const f of registry.functions) {
      const aliasStr = f.aliases.length > 0 ? ` (别名: ${f.aliases.join(", ")})` : "";
      lines.push(`- ${f.id} | ${f.canonicalName}${aliasStr}`);
    }
  }

  return lines.join("\n");
}
