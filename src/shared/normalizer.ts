/**
 * RequirementNormalizer - analyze 结果的确定性后处理。
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
    RequirementNormalizer._ensureFunctionDetailArrays(analysis);
    RequirementNormalizer._dedupConstraints(analysis);
    RequirementNormalizer._dedupExceptions(analysis);
    RequirementNormalizer._splitNestedEntities(analysis);
    RequirementNormalizer._deduplicateSimilarEntityNames(analysis);
    RequirementNormalizer._ensureUserRole(analysis);

    return analysis;
  }

  /**
   * Normalize with access to the original requirement text.
   * This keeps source-sensitive decisions out of the generic normalizer path.
   */
  static normalizeAgainstSource(
    analysis: Record<string, unknown>,
    requirementText: string,
  ): Record<string, unknown> {
    if (!analysis || typeof analysis !== "object") return analysis;
    const source = String(requirementText ?? "");
    RequirementNormalizer._removeUnsupportedRecordEntities(analysis, source);
    RequirementNormalizer._pruneLowEvidenceRequirementItems(analysis, source);
    RequirementNormalizer._promoteAggregationLineItems(analysis, source);
    RequirementNormalizer._promoteReifiedRelationships(analysis, source);
    return analysis;
  }

  // ------------------------------------------------------------------
  // 1. 移除壳实体(仅 id + status),将角色名合并到 User.role
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

      // 检查这是否是壳实体:只有 id + status 字段,无关系
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
      // 存储已移除的角色用于 User.role 合并(在 _ensureUserRole 中完成)
      (analysis as Record<string, unknown>).__removedRoles = removedRoles;
    }
  }

  // ------------------------------------------------------------------
  // 2. 规范化角色名 - 去重同义词(不区分大小写)
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
  // 3. 将缩写规范化为 PascalCase(SKU→Sku、XML→Xml 等)
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
    // 仅转换完全大写的名称(如 SKU、XML、API)。
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
        // 合并 related_functions 以保留覆盖信息
        const existingFns = Array.isArray(existing.related_functions)
          ? existing.related_functions as string[] : [];
        const newFns = Array.isArray(c.related_functions)
          ? c.related_functions as string[] : [];
        const merged = [...new Set([...existingFns, ...newFns])];
        if (merged.length > existingFns.length) {
          existing.related_functions = merged;
        }
      } else {
        seen.set(desc, c);
        kept.push(c);
      }
    }

    if (kept.length < constraints.length) {
      analysis.constraints = kept;
    }
  }

  private static _dedupExceptions(analysis: Record<string, unknown>): void {
    const exceptions = Array.isArray(analysis.exceptions)
      ? analysis.exceptions as Record<string, unknown>[]
      : [];
    if (exceptions.length <= 1) return;

    const seen = new Map<string, Record<string, unknown>>();
    const kept: Record<string, unknown>[] = [];
    for (const e of exceptions) {
      const text = [
        e.description,
        e.trigger,
        e.handling,
      ].map((value) => String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" | ");
      if (!text) { kept.push(e); continue; }

      const existing = seen.get(text);
      if (existing) {
        RequirementNormalizer._mergeArrayField(existing, e, "related_functions");
        RequirementNormalizer._mergeArrayField(existing, e, "related_constraints");
      } else {
        seen.set(text, e);
        kept.push(e);
      }
    }

    if (kept.length < exceptions.length) {
      analysis.exceptions = kept;
    }
  }

  private static _mergeArrayField(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
    field: string,
  ): void {
    const left = Array.isArray(target[field]) ? target[field] as unknown[] : [];
    const right = Array.isArray(source[field]) ? source[field] as unknown[] : [];
    if (right.length === 0) return;
    target[field] = [...new Set([...left, ...right].map((item) => String(item)))];
  }

  // ------------------------------------------------------------------
  // 5. 确保功能细节字段存在
  // ------------------------------------------------------------------
  private static _ensureFunctionDetailArrays(analysis: Record<string, unknown>): void {
    const functions = Array.isArray(analysis.functions)
      ? analysis.functions as Record<string, unknown>[]
      : [];
    for (const fn of functions) {
      if (typeof fn !== "object" || fn === null || Array.isArray(fn)) continue;
      if (!("name" in fn) && !("description" in fn)) continue;
      if (!Array.isArray(fn.sub_capabilities)) fn.sub_capabilities = [];
      if (!Array.isArray(fn.acceptance_criteria)) fn.acceptance_criteria = [];
    }
  }

  // ------------------------------------------------------------------
  // 6. 确保 User 实体有 role 属性
  // ------------------------------------------------------------------
  private static _ensureUserRole(analysis: Record<string, unknown>): void {
    const entities = RequirementNormalizer._getEntities(analysis);
    if (!entities) return;

    const actors = RequirementNormalizer._getActorNames(analysis);
    const removedRoles = (analysis as Record<string, unknown>).__removedRoles as string[] | undefined;

    // 已作为独立实体存活的"角色"不应再被扁平化为 User.role 字段——
    // 它们会作为独立实体进入下游 domain_model，由其识别共享身份并构建泛化层级。
    // 仅对未被保留(纯壳/标签)或仅存在于 actors 列表中的角色注入 role 字段。
    const survivingEntityNames = new Set(
      entities
        .filter((e): e is Record<string, unknown> =>
          typeof e === "object" && e !== null && !Array.isArray(e))
        .map((e) => String(e.name ?? "").trim().toLowerCase())
        .filter(Boolean),
    );
    const allRoles = [...new Set([...actors, ...(removedRoles ?? [])])]
      .filter((name) => !survivingEntityNames.has(name.toLowerCase()));

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
  // 7. 将嵌套的 Object/List 实体拆分为独立实体
  // ------------------------------------------------------------------
  /**
   * 最常见的 LLM 失败模式:将类似实体的属性写为
   * Object 或 List<X> 而不是创建独立实体。
   * 此扫描器检测这些情况并将其提升为顶级实体。
   *
   * 检测到的模式:
   *   type === "Object"       → 新实体(名称派生自属性)
   *   type 为 "List<X>"       → 新实体 X(仅当 X 为 PascalCase 时)
   *   type 为 "String" 但名称看起来像实体引用 → 跳过(误报太多)
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

        // 模式 A:List<X>,其中 X 是 PascalCase 实体名(LLM 直接写出了名称)
        const listMatch = type.match(/^List<([A-Z][a-zA-Z0-9]+)>$/);
        if (listMatch) {
          newEntityName = listMatch[1];
        }

        // 模式 B:纯 Object 类型 → 跳过。属性名→实体名
        // 派生太不可靠(后缀剥离会产生垃圾名称)。
        // LLM 已经创建了大多数实体;我们只修复 List<X> 嵌套情况。
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

  // ------------------------------------------------------------------
  // 8. 按词干去重同概念的多个实体变体
  // 多个 analyze 子任务对同一业务动作各自进行"实体化"，产生近义词
  // 变体（如 BookReturning / BookReturn / BookReturningProcess）。
  // 对含有 `reifies` 字段的实体按去除 Process/ing 词尾后的词干分组，
  // 同组保留属性最多的一个，其余删除并清理悬挂关系。
  // ------------------------------------------------------------------
  private static _deduplicateSimilarEntityNames(analysis: Record<string, unknown>): void {
    const entities = RequirementNormalizer._getEntities(analysis);
    if (!entities || entities.length <= 1) return;

    const entityObjs = entities as Record<string, unknown>[];

    const isReified = (e: Record<string, unknown>): boolean => {
      const reifies = e.reifies;
      return reifies !== null && reifies !== undefined && typeof reifies === "object";
    };

    // Iteratively strip "process" and "ing" suffixes to get a canonical stem.
    const getStem = (name: string): string => {
      let s = name.toLowerCase();
      let prev = "";
      while (s !== prev) {
        prev = s;
        s = s.replace(/(process|ing)$/, "");
      }
      return s;
    };

    // Group reified entities by stem.
    const stemGroups = new Map<string, Record<string, unknown>[]>();
    for (const entity of entityObjs) {
      if (!isReified(entity)) continue;
      const name = String(entity.name ?? "").trim();
      if (!name) continue;
      const stem = getStem(name);
      if (!stemGroups.has(stem)) stemGroups.set(stem, []);
      stemGroups.get(stem)!.push(entity);
    }

    // Mark duplicates for removal; keep the entity with the most attributes.
    const toRemove = new Set<Record<string, unknown>>();
    for (const [, group] of stemGroups) {
      if (group.length <= 1) continue;
      let best = group[0];
      let bestLen = Array.isArray(best.attributes) ? (best.attributes as unknown[]).length : 0;
      for (const entity of group.slice(1)) {
        const len = Array.isArray(entity.attributes) ? (entity.attributes as unknown[]).length : 0;
        if (len > bestLen) { best = entity; bestLen = len; }
      }
      for (const entity of group) {
        if (entity !== best) toRemove.add(entity);
      }
    }

    if (toRemove.size === 0) return;

    analysis.entities = entityObjs.filter((e) => !toRemove.has(e as Record<string, unknown>));
    RequirementNormalizer._dropRelationshipsToMissingEntities(analysis);
  }

  // ------------------------------------------------------------------
  // 9. 基于原文剔除无依据的记录类实体
  // ------------------------------------------------------------------
  private static _removeUnsupportedRecordEntities(
    analysis: Record<string, unknown>,
    requirementText: string,
  ): void {
    const entities = RequirementNormalizer._getEntities(analysis);
    if (!entities || entities.length <= 1) return;

    const hasRecordEvidence = /保存|存储|持久|历史|记录|日志|审计|回溯|流水|备份|查询记录|操作记录/i.test(requirementText);
    if (hasRecordEvidence) return;

    const recordNameRe = /(Record|History|Log|Audit|Trace)$/;
    const kept = entities.filter((entity) => {
      if (typeof entity !== "object" || entity === null) return true;
      const name = String((entity as Record<string, unknown>).name ?? "");
      return !recordNameRe.test(name);
    });

    if (kept.length > 0 && kept.length < entities.length) {
      analysis.entities = kept;
      RequirementNormalizer._dropRelationshipsToMissingEntities(analysis);
    }
  }

  private static _pruneLowEvidenceRequirementItems(
    analysis: Record<string, unknown>,
    requirementText: string,
  ): void {
    if (!requirementText.trim()) return;
    RequirementNormalizer._pruneLowEvidenceList(analysis, "constraints", requirementText, 18);
    RequirementNormalizer._pruneLowEvidenceList(analysis, "exceptions", requirementText, 12);
  }

  private static _pruneLowEvidenceList(
    analysis: Record<string, unknown>,
    key: "constraints" | "exceptions",
    requirementText: string,
    softLimit: number,
  ): void {
    const items = Array.isArray(analysis[key])
      ? analysis[key] as Record<string, unknown>[]
      : [];
    if (items.length <= softLimit) return;

    const sourceNorm = RequirementNormalizer._normalizeEvidenceText(requirementText);
    const scored = items.map((item, index) => ({
      item,
      index,
      score: RequirementNormalizer._requirementEvidenceScore(item, sourceNorm),
    }));

    const highConfidence = scored.filter((entry) => entry.score >= 2);
    if (highConfidence.length >= Math.ceil(softLimit * 0.75)) {
      analysis[key] = highConfidence
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.item);
      return;
    }

    analysis[key] = scored
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, softLimit)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.item);
  }

  private static _requirementEvidenceScore(
    item: Record<string, unknown>,
    normalizedSource: string,
  ): number {
    let score = 0;
    const sourceText = String(item.source_text ?? item.sourceText ?? "").trim();
    const description = String(item.description ?? "").trim();
    const trigger = String(item.trigger ?? "").trim();
    const handling = String(item.handling ?? "").trim();

    if (sourceText && normalizedSource.includes(RequirementNormalizer._normalizeEvidenceText(sourceText))) {
      score += 3;
    }
    for (const text of [description, trigger, handling]) {
      const normalized = RequirementNormalizer._normalizeEvidenceText(text);
      if (normalized.length >= 6 && normalizedSource.includes(normalized)) {
        score += 2;
      }
    }
    if (Array.isArray(item.related_functions) && item.related_functions.length > 0) score += 1;
    if (Array.isArray(item.related_constraints) && item.related_constraints.length > 0) score += 1;
    if (sourceText) score += 1;
    return score;
  }

  private static _normalizeEvidenceText(text: string): string {
    return String(text ?? "")
      .toLowerCase()
      .replace(/[\s`'"“”‘’（）()【】\[\]{}<>:：,，.。;；、|/\\_-]+/g, "");
  }

  // ------------------------------------------------------------------
  // 9. 通用明细行提升器
  // 检测原文中出现"明细/行/条目/子项/记录"等词,且存在两个实体
  // 之间的多对多关系(聚合根 → * 资源实体),自动插入中间明细实体。
  // ------------------------------------------------------------------
  private static _promoteAggregationLineItems(
    analysis: Record<string, unknown>,
    requirementText: string,
  ): void {
    const LINE_ITEM_KEYWORDS =
      /明细|行项|子项|条目|列表项|清单|order\s*item|line\s*item/i;
    if (!LINE_ITEM_KEYWORDS.test(requirementText)) return;

    const entities = RequirementNormalizer._getEntities(analysis);
    if (!entities) return;
    const entityObjs = entities.filter((e): e is Record<string, unknown> =>
      typeof e === "object" && e !== null && !Array.isArray(e),
    );
    const names = new Set(entityObjs.map((e) => String(e.name ?? "")));

    // Scan all entities for many-to-many or one-to-many relationships
    // that look like aggregation-root -> * resource (no line-item in between)
    let promoted = false;
    for (const entity of entityObjs) {
      const rels = Array.isArray(entity.relationships)
        ? entity.relationships as Record<string, unknown>[]
        : [];

      for (const rel of rels) {
        const target = String(rel.target ?? "");
        const relType = String(rel.type ?? "");
        if (!/many-to-many|one-to-many/.test(relType)) continue;
        if (!names.has(target)) continue;

        // Build the line-item name: "RootItem" or "RootTarget"
        const rootName = String(entity.name ?? "");
        const lineItemName = `${rootName}${target === rootName ? "Item" : ""}Item`;

        // Skip if a suitable line-item entity already exists
        if (names.has(lineItemName)) continue;

        // Check if source text mentions this specific aggregation relationship
        const rootKeywords = rootName.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
        const sourceLower = requirementText.toLowerCase();
        const hasSpecificEvidence = (() => {
          const sentences = requirementText.split(/[.\n]+/);
          for (const sentence of sentences) {
            const sentLower = sentence.toLowerCase();
            if (LINE_ITEM_KEYWORDS.test(sentence)) {
              // When entity name appears in source, require it in same sentence
              if (sourceLower.includes(rootKeywords)) {
                if (sentLower.includes(rootKeywords)) return true;
                // entity name elsewhere but not in this sentence — keep looking
              } else {
                // Language mismatch: entity names absent from source,
                // but line-item keywords confirmed by outer guard
                return true;
              }
            }
          }
          return false;
        })();

        if (!hasSpecificEvidence) continue;

        // Derive attributes based on resource entity
        const resourceEntity = entityObjs.find((e) => e.name === target);
        const resourceDesc = resourceEntity
          ? String(resourceEntity.description ?? "").split(/[,,。.]/)[0]
          : target;

        // Create the line-item entity
        entityObjs.push({
          name: lineItemName,
          description: `${rootName}中的${resourceDesc}明细行,记录数量和关联信息`,
          attributes: [
            { name: `${RequirementNormalizer._lowerFirst(lineItemName)}Id`, type: "Long", description: `${lineItemName}唯一标识` },
            { name: `${RequirementNormalizer._lowerFirst(rootName)}Id`, type: "Long", description: `所属${rootName}ID` },
            { name: `${RequirementNormalizer._lowerFirst(target)}Id`, type: "Long", description: `${target}ID` },
            { name: "quantity", type: "Integer", description: "数量" },
          ],
          relationships: [
            { target: rootName, type: "many-to-one", description: `${lineItemName}属于一个${rootName}` },
            { target, type: "many-to-one", description: `${lineItemName}引用一个${target}` },
          ],
        });
        names.add(lineItemName);

        // Patch the root entity: replace the direct many-to-many/one-to-many
        // to the resource with a one-to-many to the line-item
        const idx = rels.indexOf(rel);
        if (idx >= 0) rels.splice(idx, 1);
        rels.push({
          target: lineItemName,
          type: "one-to-many",
          description: `一个${rootName}包含多条${resourceDesc}明细`,
        });
        entity.relationships = rels;

        // Add reverse relationship from resource to line-item
        if (resourceEntity) {
          const resourceRels = Array.isArray(resourceEntity.relationships)
            ? resourceEntity.relationships as Record<string, unknown>[]
            : [];
          if (!resourceRels.some((r) => r.target === lineItemName)) {
            resourceRels.push({ target: lineItemName, type: "one-to-many", description: `一个${target}可出现在多条${lineItemName}中` });
            resourceEntity.relationships = resourceRels;
          }
        }

        promoted = true;
        break; // one promotion per root entity to avoid over-insertion
      }
      if (promoted) break; // process at most one missing line-item per pass
    }

    if (promoted) {
      analysis.entities = entityObjs;
    }
  }

  // ------------------------------------------------------------------
  // 10. 关系实体化
  // 当流程/关系本身有编号、时间、状态、结果、报告、证据等独立数据时，
  // 将其提升为 process_record 实体，而不仅仅保留在 business_processes 中。
  // ------------------------------------------------------------------
  private static _promoteReifiedRelationships(
    analysis: Record<string, unknown>,
    requirementText: string,
  ): void {
    const entities = RequirementNormalizer._getEntities(analysis);
    const processes = Array.isArray(analysis.business_processes)
      ? analysis.business_processes as Record<string, unknown>[]
      : [];
    if (!entities || entities.length === 0 || processes.length === 0) return;

    const entityObjs = entities.filter((e): e is Record<string, unknown> =>
      typeof e === "object" && e !== null && !Array.isArray(e),
    );
    const entityNames = new Set(
      entityObjs.map((e) => String(e.name ?? "").trim()).filter(Boolean),
    );
    const source = RequirementNormalizer._splitSearchableText(requirementText);
    let promoted = false;

    for (const process of processes) {
      const rawName = String(process.name ?? process.id ?? "").trim();
      const entityName = RequirementNormalizer._deriveReifiedEntityName(rawName);
      if (!entityName || entityNames.has(entityName)) continue;
      if (!RequirementNormalizer._looksLikeReifiableProcessName(rawName)) continue;

      const processText = RequirementNormalizer._buildProcessEvidenceText(
        process,
        source,
      );
      const evidence = RequirementNormalizer._collectReificationEvidence(processText);
      if (!RequirementNormalizer._hasEnoughReificationEvidence(rawName, evidence)) {
        continue;
      }

      const endpoints = RequirementNormalizer._inferReifiedEndpoints(
        entityName,
        processText,
        entityObjs,
      );
      const attributes = RequirementNormalizer._buildReifiedAttributes(entityName, evidence);
      const relationships = endpoints.map((target) => ({
        target,
        type: "many-to-one",
        description: `${entityName}关联${target}`,
      }));

      const entity: Record<string, unknown> = {
        name: entityName,
        entityKind: "process_record",
        description: `${rawName}的一次业务执行记录，承载该关系/流程的独立数据和生命周期`,
        attributes,
        relationships,
        reifies: {
          source: "business_process",
          sourceName: rawName,
          endpoints,
          evidence,
        },
      };

      entityObjs.push(entity);
      entityNames.add(entityName);
      for (const endpoint of endpoints) {
        RequirementNormalizer._addRelationship(
          entityObjs,
          endpoint,
          entityName,
          "one-to-many",
          `${endpoint}包含多条${entityName}记录`,
        );
      }
      promoted = true;
    }

    if (promoted) {
      analysis.entities = entityObjs;
    }
  }

  private static _deriveReifiedEntityName(rawName: string): string {
    const cleaned = rawName.replace(/流程|过程|记录/g, "").trim();
    if (/^[A-Z][A-Za-z0-9]*$/.test(cleaned)) return cleaned;
    if (/^[A-Z][A-Za-z0-9]*$/.test(rawName)) return rawName;
    return "";
  }

  private static _looksLikeReifiableProcessName(name: string): boolean {
    return /Registration|Register|Investigation|Investigate|Prosecution|Prosecute|Submission|Submit|Approval|Approve|Enrollment|Enroll|Selection|Reservation|Booking|Borrowing|Borrow|Return|Payment|Refund|Transfer|Visit|Access|Session|Login|Filing|Application|Assignment|Review|Inspection/i.test(name) ||
      /注册|登记|立案|报案|调查|侦查|起诉|提交|审批|选课|选修|预约|借阅|归还|支付|退款|访问|会话|登录|申请|分配|审核|检查/.test(name);
  }

  private static _buildProcessEvidenceText(
    process: Record<string, unknown>,
    sourceSentences: string[],
  ): string {
    const fields: string[] = [];
    for (const key of ["name", "description", "id"]) {
      const value = String(process[key] ?? "").trim();
      if (value) fields.push(value);
    }
    for (const key of ["steps", "actors"]) {
      const value = process[key];
      if (Array.isArray(value)) {
        fields.push(...value.map((item) => String(item)));
      }
    }

    const seed = RequirementNormalizer._spacePascalCase(fields.join(" "));
    const tokens = RequirementNormalizer._domainTokens(seed);
    const relevant = sourceSentences.filter((sentence) => {
      const spacedSentence = RequirementNormalizer._spacePascalCase(sentence).toLowerCase();
      return tokens.some((token) => spacedSentence.includes(token));
    });

    return `${seed}\n${relevant.join("\n")}`;
  }

  private static _splitSearchableText(text: string): string[] {
    return String(text ?? "")
      .split(/(?<=[。！？.!?])|\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private static _domainTokens(text: string): string[] {
    const stopWords = new Set([
      "case", "process", "flow", "record", "the", "and", "with", "for",
      "system", "user", "users", "update", "create",
    ]);
    const tokens = RequirementNormalizer._spacePascalCase(text)
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !stopWords.has(token));
    return [...new Set(tokens)];
  }

  private static _collectReificationEvidence(text: string): string[] {
    const normalized = RequirementNormalizer._spacePascalCase(text);
    const evidence: string[] = [];
    const checks: Array<[string, RegExp]> = [
      ["has_identifier", /编号|号码|单号|流水|唯一标识|\bid\b|identifier|number|token/i],
      ["has_timestamp", /时间|日期|学期|期限|时长|timestamp|date|semester|duration|\bip\b/i],
      ["has_status", /状态|进度|通过|关闭|完成|status|state|passed|closed|resolved|complete/i],
      ["has_result", /结果|成绩|分数|判决|刑期|result|outcome|score|grade|judgment|sentence/i],
      ["has_report_or_evidence", /报告|证据|证据链|结论|材料|庭审|report|evidence|conclusion|charge|court/i],
      ["is_referenced_later", /后续|引用|关联|前提|追踪|follow|referenced|subsequent|prerequisite|track/i],
    ];
    for (const [label, re] of checks) {
      if (re.test(normalized)) evidence.push(label);
    }
    return evidence;
  }

  private static _hasEnoughReificationEvidence(name: string, evidence: string[]): boolean {
    if (evidence.length >= 2) return true;
    if (evidence.length === 0) return false;
    return /Registration|Investigation|Prosecution|Submission|Approval|Enrollment|Reservation|Payment|Visit|Access|Session|Application/i.test(name) ||
      /注册|登记|立案|调查|侦查|起诉|提交|审批|选课|选修|预约|支付|访问|会话|申请/.test(name);
  }

  private static _inferReifiedEndpoints(
    entityName: string,
    processText: string,
    entities: Record<string, unknown>[],
  ): string[] {
    const spacedEntityName = RequirementNormalizer._spacePascalCase(entityName).toLowerCase();
    const spacedText = RequirementNormalizer._spacePascalCase(processText).toLowerCase();
    const endpoints: string[] = [];

    for (const entity of entities) {
      const name = String(entity.name ?? "").trim();
      if (!name || name === entityName) continue;
      const spacedName = RequirementNormalizer._spacePascalCase(name).toLowerCase();
      if (
        spacedEntityName.includes(spacedName) ||
        spacedText.includes(spacedName) ||
        String(entity.description ?? "").trim() && spacedText.includes(String(entity.description).toLowerCase())
      ) {
        endpoints.push(name);
      }
    }

    return [...new Set(endpoints)].slice(0, 4);
  }

  private static _buildReifiedAttributes(
    entityName: string,
    evidence: string[],
  ): Record<string, string>[] {
    const attrs: Record<string, string>[] = [
      {
        name: `${RequirementNormalizer._lowerFirst(entityName)}Id`,
        type: "Long",
        description: `${entityName}唯一标识`,
      },
      {
        name: "createdAt",
        type: "DateTime",
        description: `${entityName}创建时间`,
      },
    ];
    if (evidence.includes("has_identifier")) {
      attrs.push({ name: "businessNo", type: "String", description: "业务编号" });
    }
    if (evidence.includes("has_status")) {
      attrs.push({ name: "status", type: "String", description: "流程状态" });
    }
    if (evidence.includes("has_timestamp")) {
      attrs.push({ name: "occurredAt", type: "DateTime", description: "发生时间或业务日期" });
    }
    if (evidence.includes("has_result")) {
      attrs.push({ name: "result", type: "String", description: "处理结果" });
    }
    if (evidence.includes("has_report_or_evidence")) {
      attrs.push({ name: "summary", type: "String", description: "报告、证据或结论摘要" });
    }
    return attrs;
  }

  private static _addRelationship(
    entities: Record<string, unknown>[],
    sourceName: string,
    targetName: string,
    type: string,
    description: string,
  ): void {
    const source = entities.find((entity) => String(entity.name ?? "") === sourceName);
    if (!source) return;
    const rels = Array.isArray(source.relationships)
      ? source.relationships as Record<string, unknown>[]
      : [];
    const exists = rels.some((rel) =>
      String(rel.target ?? "") === targetName &&
      String(rel.type ?? "") === type
    );
    if (!exists) {
      rels.push({ target: targetName, type, description });
      source.relationships = rels;
    }
  }

  private static _spacePascalCase(text: string): string {
    return String(text ?? "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  }

  private static _dropRelationshipsToMissingEntities(analysis: Record<string, unknown>): void {
    const entities = RequirementNormalizer._getEntities(analysis);
    if (!entities) return;
    const names = new Set(
      entities
        .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null && !Array.isArray(e))
        .map((e) => String(e.name ?? "")),
    );
    for (const entity of entities) {
      if (typeof entity !== "object" || entity === null || Array.isArray(entity)) continue;
      const rec = entity as Record<string, unknown>;
      if (!Array.isArray(rec.relationships)) continue;
      rec.relationships = (rec.relationships as Record<string, unknown>[])
        .filter((rel) => names.has(String(rel.target ?? "")));
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
