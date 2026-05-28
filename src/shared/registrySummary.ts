/**
 * buildRegistrySummary — formats an EntityRegistry into a concise text summary
 * for injection into prompts.
 */

import type { EntityRegistry } from "./types.js";

export function buildRegistrySummary(registry: EntityRegistry): string {
  const hasActors = registry.actors && registry.actors.length > 0;
  const hasConstraints = registry.constraints && registry.constraints.length > 0;
  const hasExceptions = registry.exceptions && registry.exceptions.length > 0;
  if (!registry || (registry.entities.length === 0 && registry.functions.length === 0 && !hasActors && !hasConstraints && !hasExceptions)) {
    return "";
  }

  const lines: string[] = [];

  if (hasActors) {
    lines.push("### 角色");
    for (const a of registry.actors!) {
      const aliasStr = a.aliases.length > 0 ? ` (别名: ${a.aliases.join(", ")})` : "";
      lines.push(`- ${a.id} | ${a.canonicalName} | ${a.displayName}${aliasStr}`);
    }
  }

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

  if (hasConstraints) {
    lines.push("### 约束");
    for (const c of registry.constraints!) {
      const aliasStr = c.aliases.length > 0 ? ` (别名: ${c.aliases.join(", ")})` : "";
      lines.push(`- ${c.id} | ${c.canonicalName} | ${c.displayName}${aliasStr}`);
    }
  }

  if (hasExceptions) {
    lines.push("### 异常");
    for (const x of registry.exceptions!) {
      const aliasStr = x.aliases.length > 0 ? ` (别名: ${x.aliases.join(", ")})` : "";
      lines.push(`- ${x.id} | ${x.canonicalName} | ${x.displayName}${aliasStr}`);
    }
  }

  return lines.join("\n");
}
