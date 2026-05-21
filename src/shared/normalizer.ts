/**
 * RequirementNormalizer — analyze 结果的确定性后处理。
 * 零 LLM 调用。在单次 analyze、合并后、以及 analyze repair 后运行。
 */

export class RequirementNormalizer {
  /** 不应成为实体名的标准类型。 */
  private static readonly _PRIMITIVE_TYPES: Set<string> = new Set([
    "String", "Integer", "Int", "Long", "Double", "Float",
    "Boolean", "Decimal", "BigDecimal", "DateTime", "Date",
    "Object", "List", "Map", "Set", "Array", "UUID",
  ]);
  /**
   * 原地规范化 analyze 结果并返回。
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
  // 1. 移除壳实体（仅 id + status），将角色名合并到 User.role
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

      // 检查这是否是壳实体：只有 id + status 字段，无关系
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
      // 存储已移除的角色用于 User.role 合并（在 _ensureUserRole 中完成）
      (analysis as Record<string, unknown>).__removedRoles = removedRoles;
    }
  }

  // ------------------------------------------------------------------
  // 2. 规范化角色名 — 去重同义词（不区分大小写）
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
  // 3. 将缩写规范化为 PascalCase（SKU→Sku、XML→Xml 等）
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
   * 将 PascalCase 名称中的全大写缩写转换为标题大小写。
   * 例如 "SKU" → "Sku"、"XMLTag" → "XmlTag"、"XMLRegistry" → "XmlRegistry"
   * 保留已经是 PascalCase 的名称。
   */
  private static _toPascalCase(name: string): string {
    // 仅转换完全大写的名称（如 SKU、XML、API）。
    // 混合大小写如 XmlTag、XMLTag、ApiResponse 已经是有效的 PascalCase。
    if (/^[A-Z]{2,}$/.test(name)) {
      return name.charAt(0) + name.slice(1).toLowerCase();
    }
    return name;
  }

  // ------------------------------------------------------------------
  // 4. 按描述去重约束
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
        // 合并：保留信息更多的或 ID 更早的
        // 如果 ID 不同，保留更早的那个
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
  // 5. 确保 User 实体有 role 属性
  // ------------------------------------------------------------------
  private static _ensureUserRole(analysis: Record<string, unknown>): void {
    const entities = RequirementNormalizer._getEntities(analysis);
    if (!entities) return;

    const actors = RequirementNormalizer._getActorNames(analysis);
    const removedRoles = (analysis as Record<string, unknown>).__removedRoles as string[] | undefined;
    const allRoles = [...new Set([...actors, ...(removedRoles ?? [])])];

    // 清理内部字段
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

    // 检查 role 属性是否已存在
    const hasRole = attrs.some(a => String(a.name ?? "").toLowerCase() === "role");
    if (!hasRole) {
      attrs.push({
        name: "role",
        type: "String",
        description: `角色: ${allRoles.join("、")}`,
      });
      userEntity.attributes = attrs;
    } else {
      // 更新描述以包含所有角色
      const roleAttr = attrs.find(a => String(a.name ?? "").toLowerCase() === "role");
      if (roleAttr && !String(roleAttr.description ?? "").includes(allRoles[0])) {
        roleAttr.description = `角色: ${allRoles.join("、")}`;
      }
    }
  }

  // ------------------------------------------------------------------
  // 6. 将嵌套的 Object/List 实体拆分为独立实体
  // ------------------------------------------------------------------
  /**
   * 最常见的 LLM 失败模式：将类似实体的属性写为
   * Object 或 List<X> 而不是创建独立实体。
   * 此扫描器检测这些情况并将其提升为顶级实体。
   *
   * 检测到的模式：
   *   type === "Object"       → 新实体（名称派生自属性）
   *   type 为 "List<X>"       → 新实体 X（仅当 X 为 PascalCase 时）
   *   type 为 "String" 但名称看起来像实体引用 → 跳过（误报太多）
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

        // 模式 A：List<X>，其中 X 是 PascalCase 实体名（LLM 直接写出了名称）
        const listMatch = type.match(/^List<([A-Z][a-zA-Z0-9]+)>$/);
        if (listMatch) {
          newEntityName = listMatch[1];
        }

        // 模式 B：纯 Object 类型 → 跳过。属性名→实体名
        // 派生太不可靠（后缀剥离会产生垃圾名称）。
        // LLM 已经创建了大多数实体；我们只修复 List<X> 嵌套情况。
        // If (type === "Object") { ... }

        if (!newEntityName || entityNames.has(newEntityName)) continue;
        if (RequirementNormalizer._PRIMITIVE_TYPES.has(newEntityName)) continue;
        if (newEntities.some(e => e.name === newEntityName)) continue;

        replacements.push({ attr, newEntityName });
        entityNames.add(newEntityName);
      }

      // 应用替换并创建新实体
      for (const { attr, newEntityName } of replacements) {
        const type = String(attr.type ?? "").trim();
        const isList = type.startsWith("List<");

        // 将属性类型更改为 Long 引用
        attr.type = isList ? "List<Long>" : "Long";
        attr.description = String(attr.description ?? "") + ` → 关联实体 ${newEntityName}`;

        // 创建存根实体
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

        // 添加从父实体到新实体的关系
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
