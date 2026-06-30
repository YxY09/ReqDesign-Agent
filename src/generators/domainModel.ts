/**
 * DomainModelGenerator — 从需求分析结果生成领域概念模型。
 *
 * 输入：requirement_json (entities, actors, constraints, etc.)
 * 输出：domain_model.json (concepts, generalizations, associations)
 *
 * 领域概念模型是类图和系统设计的共同上游权威来源。
 */

import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";
import { BaseGenerator } from "./base.js";

const IMPLEMENTATION_NAMES = /(?:Service|Repository|Controller|Manager|Engine|Handler|Gateway|Facade|Factory|Validator|Processor|Strategy|Config|Dao|Adapter|Provider|Worker|Scheduler|Dispatcher|Publisher|Executor|Builder|Recorder|Utils?|Helper|Client|Impl)$/;

export interface DomainConcept {
  id: string;
  name: string;
  kind: "entity" | "enumeration" | "association" | "line_item" | "value_object";
  abstract?: boolean;
  description?: string;
  attributes?: Array<{ name: string; type: string; description?: string }>;
  literals?: string[];
  connects?: string[];
  parentEntity?: string;
  analysisEntityRef?: string;
}

export interface DomainGeneralization {
  parent: string;
  children: string[];
  discriminator?: string;
  parentMultiplicity?: string;
  childMultiplicity?: string;
}

export interface DomainAssociation {
  source: string;
  target: string;
  sourceMultiplicity: string;
  targetMultiplicity: string;
  label?: string;
}

export interface DomainModel {
  concepts: DomainConcept[];
  generalizations: DomainGeneralization[];
  associations: DomainAssociation[];
}

export class DomainModelGenerator extends BaseGenerator<Record<string, unknown>> {
  private promptTemplate: string;

  constructor(llm: LLMClient) {
    super(llm);
    this.promptTemplate = loadPrompt(
      "domain_model.md",
      "请根据需求分析结果生成领域概念模型 JSON。\n\n{requirement_json}\n\n{requirement_text}",
    );
  }

  async generate(input: unknown): Promise<Record<string, unknown>> {
    const {
      requirementJson,
      systemPrompt = "",
      requirementText = "",
    } = input as {
      requirementJson: Record<string, unknown>;
      systemPrompt?: string;
      requirementText?: string;
    };
    return this.generateDomainModel(requirementJson, systemPrompt, requirementText);
  }

  async generateDomainModel(
    requirementJson: Record<string, unknown>,
    systemPrompt: string,
    requirementText = "",
  ): Promise<Record<string, unknown>> {
    const reqStr = JSON.stringify(requirementJson, null, 2);
    const safeReqText = this.sanitizePlaceholder(requirementText || "", "requirement_json");

    let prompt = this.promptTemplate
      .replace(/\{requirement_json\}/g, reqStr)
      .replace(/\{requirement_text\}/g, safeReqText);

    const raw = await this.generateJsonWithRetry(prompt, systemPrompt, 3);
    return DomainModelGenerator.validate(raw);
  }

  static validate(raw: Record<string, unknown>): Record<string, unknown> {
    const concepts = Array.isArray(raw.concepts)
      ? (raw.concepts as Array<Record<string, unknown>>)
      : [];
    const generalizations = Array.isArray(raw.generalizations)
      ? (raw.generalizations as Array<Record<string, unknown>>)
      : [];
    const associations = Array.isArray(raw.associations)
      ? (raw.associations as Array<Record<string, unknown>>)
      : [];

    // Strip any implementation concepts that leaked through
    const cleaned = concepts.filter((c) => {
      const name = String(c.name ?? "");
      return !IMPLEMENTATION_NAMES.test(name);
    });

    // Ensure D-IDs are present and sequential
    for (let i = 0; i < cleaned.length; i++) {
      if (!cleaned[i].id || typeof cleaned[i].id !== "string") {
        cleaned[i].id = `D${String(i + 1).padStart(3, "0")}`;
      }
    }

    return {
      concepts: cleaned,
      generalizations,
      associations,
    };
  }

  /** Extract all concept names from a domain model JSON. */
  static extractConceptNames(domainModel: Record<string, unknown>): string[] {
    const concepts = Array.isArray(domainModel.concepts)
      ? (domainModel.concepts as Array<Record<string, unknown>>)
      : [];
    return concepts
      .map((c) => String(c.name ?? "").trim())
      .filter(Boolean);
  }

  /** Extract all concept D-IDs (e.g. D001, D002) from a domain model JSON. */
  static extractConceptIds(domainModel: Record<string, unknown>): string[] {
    const concepts = Array.isArray(domainModel.concepts)
      ? (domainModel.concepts as Array<Record<string, unknown>>)
      : [];
    return concepts
      .map((c) => String(c.id ?? "").trim())
      .filter(Boolean);
  }

  /** Build a concept name → D-ID lookup map. */
  static buildConceptIndex(domainModel: Record<string, unknown>): Map<string, string> {
    const concepts = Array.isArray(domainModel.concepts)
      ? (domainModel.concepts as Array<Record<string, unknown>>)
      : [];
    const index = new Map<string, string>();
    for (const c of concepts) {
      const name = String(c.name ?? "").trim();
      const id = String(c.id ?? "").trim();
      if (name && id) index.set(name, id);
    }
    return index;
  }

  /**
   * Validate consistency between domain model and design output.
   * Returns a list of warning strings (empty = all good).
   *
   * Checks:
   * 1. Design covers all domain entity/value_object concepts (via domainRefs or entityRef)
   * 2. No domain-class in design references a non-existent domain concept
   * 3. Class diagram only uses domain model class names (no invented classes)
   * 4. Generalization-parent design class name reconciles with the domain
   *    concept name (no alias divergence — cuts the evaluator rename loop)
   */
  static validateDomainDesignConsistency(
    domainModel: Record<string, unknown>,
    designClasses: Array<Record<string, unknown>>,
    classDiagramMermaid?: string,
  ): string[] {
    const warnings: string[] = [];
    const concepts = Array.isArray(domainModel.concepts)
      ? (domainModel.concepts as Array<Record<string, unknown>>)
      : [];
    if (concepts.length === 0) return warnings;

    const conceptIndex = DomainModelGenerator.buildConceptIndex(domainModel);
    const conceptNames = new Set(conceptIndex.keys());
    const conceptDIds = new Set(conceptIndex.values());

    // Build reverse index: analysisEntityRef → concept D-ID, so we can resolve
    // design entityRef values like "E_TRAJECTORY" back to domain model concepts.
    const analysisRefToConceptDId = new Map<string, string>();
    const analysisRefToConceptName = new Map<string, string>();
    for (const c of concepts) {
      const aRef = String(c.analysisEntityRef ?? "").trim();
      const did = String(c.id ?? "").trim();
      const name = String(c.name ?? "").trim();
      if (aRef && did) analysisRefToConceptDId.set(aRef, did);
      if (aRef && name) analysisRefToConceptName.set(aRef, name);
    }

    // Validator 1: design covers all domain entity/value_object concepts
    const domainConcepts = concepts.filter((c) => {
      const kind = String(c.kind ?? "");
      return kind === "entity" || kind === "value_object";
    });
    const referencedDIds = new Set<string>();
    const referencedEntityRefs = new Set<string>();
    for (const cls of designClasses) {
      const refs = Array.isArray(cls.domainRefs)
        ? (cls.domainRefs as string[])
        : [];
      for (const ref of refs) referencedDIds.add(String(ref).trim());
      const entityRef = String(cls.entityRef ?? "").trim();
      if (entityRef) {
        referencedEntityRefs.add(entityRef);
        // Also resolve analysis entity IDs to D-IDs
        const resolved = analysisRefToConceptDId.get(entityRef);
        if (resolved) referencedDIds.add(resolved);
      }
      // Also match by class name directly
      const className = String(cls.name ?? "").trim();
      if (className) referencedEntityRefs.add(className);
    }
    for (const concept of domainConcepts) {
      const did = String(concept.id ?? "").trim();
      const name = String(concept.name ?? "").trim();
      const isAbstract = concept.abstract === true;
      if (isAbstract) continue;
      if (!referencedDIds.has(did) && !referencedEntityRefs.has(name)) {
        warnings.push(`领域概念 ${name} (${did}) 未被任何设计类引用`);
      }
    }

    // Validator 2: design domainRefs reference valid D-IDs
    for (const cls of designClasses) {
      const refs = Array.isArray(cls.domainRefs)
        ? (cls.domainRefs as string[])
        : [];
      for (const ref of refs) {
        const r = String(ref).trim();
        if (r && !conceptDIds.has(r)) {
          warnings.push(`设计类 ${cls.name} 的 domainRefs 引用了不存在的 D-ID: ${r}`);
        }
      }
    }

    // Validator 3: class diagram only uses domain model class names
    if (classDiagramMermaid) {
      const classDefRe = /class\s+(\w+)/g;
      let match: RegExpExecArray | null;
      const diagramClasses = new Set<string>();
      while ((match = classDefRe.exec(classDiagramMermaid)) !== null) {
        if (match[1]) diagramClasses.add(match[1]);
      }
      for (const name of diagramClasses) {
        if (!conceptNames.has(name)) {
          warnings.push(`类图中的类 ${name} 不在领域概念模型中`);
        }
      }
      for (const name of conceptNames) {
        if (!diagramClasses.has(name)) {
          warnings.push(`领域概念 ${name} 未出现在类图中`);
        }
      }
    }

    // Validator 4: generalization-parent name reconciliation.
    // A design class that represents a generalization PARENT concept (i.e. a
    // kind=domain class whose domainRefs include a parent concept's D-ID) MUST
    // use the SAME name as that domain concept. A divergent name (e.g. an
    // alias the design LLM invented) is what makes the evaluator demand a
    // rename, seeding the repair loop that ultimately draws a dual-parent
    // diagram. Surfacing it here as a consistency warning cuts that loop at
    // its source. Purely structural — matched by D-ID, no hardcoded names.
    //
    // A CHILD design class references its OWN concept D-ID (never the parent
    // D-ID), so it is correctly NOT flagged — the check only fires for the
    // parent concept itself.
    const gens = Array.isArray(domainModel.generalizations)
      ? (domainModel.generalizations as Array<Record<string, unknown>>)
      : [];
    if (gens.length > 0) {
      // Parent concept NAME -> D-ID, then invert to D-ID -> NAME.
      const parentNames = new Set<string>();
      for (const g of gens) {
        const pn = String(g.parent ?? "").trim();
        if (pn) parentNames.add(pn);
      }
      const parentDIdToName = new Map<string, string>();
      for (const c of concepts) {
        const cname = String(c.name ?? "").trim();
        const did = String(c.id ?? "").trim();
        if (cname && did && parentNames.has(cname)) parentDIdToName.set(did, cname);
      }
      if (parentDIdToName.size > 0) {
        for (const cls of designClasses) {
          const kind = String(cls.kind ?? "domain").trim();
          if (kind !== "domain") continue;
          const refs = Array.isArray((cls as Record<string, unknown>).domainRefs)
            ? ((cls as Record<string, unknown>).domainRefs as string[])
            : [];
          const clsName = String(cls.name ?? "").trim();
          for (const ref of refs) {
            const r = String(ref).trim();
            const parentName = parentDIdToName.get(r);
            if (parentName && parentName !== clsName) {
              warnings.push(
                `设计类 ${clsName} 引用了泛化父类概念 ${parentName} (${r}) 但类名不一致，请使用与领域概念一致的名称`,
              );
              break; // one warning per divergent class is enough
            }
          }
        }
      }
    }

    return warnings;
  }

  // ------------------------------------------------------------------
  // 确定性结构校验器（FIX1/FIX2/FIX3）
  //
  // 这些方法检测领域模型的 STRUCTURAL 缺陷（不依赖任何具体概念名），
  // 返回自检问题字符串数组（空 = 通过）。它们被接入 GenerationTool
  // 的 domain_model _ruleCheck 分支，从而同时覆盖生成与修复两条路径
  // （修复路径经 sessions.ts 的 _ruleCheck 重入）。
  // ------------------------------------------------------------------

  /**
   * FIX1 — 角色泛化层次校验（通用）。
   *
   * 检测模式：需求分析中存在多个属性/职责互不相同的角色（actor），
   * 但领域模型既没有为这些角色建立独立的实体概念，也没有任何泛化层次，
   * 即多个不同角色被压扁进同一个扁平实体。此时要求建模为泛化层次
   * （抽象父类 + 各角色子类），而非一个实体 + role 字段。
   *
   * 触发条件（全部满足）：
   *   A. 需求 actors 中存在 >=2 个互不相同的角色描述（职责/属性不同）；
   *   B. 模型中没有任何 generalization；
   *   C. 这些不同角色中至少有 2 个未作为独立概念出现（被吸收/压扁）。
   *
   * 纯结构性判定，不依赖任何具体概念名。
   */
  static validateRoleHierarchy(
    domainModel: Record<string, unknown>,
    requirementJson: Record<string, unknown>,
  ): string[] {
    const issues: string[] = [];

    // 已存在泛化层次 → 信任模型，不再强制
    const generalizations = Array.isArray(domainModel.generalizations)
      ? (domainModel.generalizations as Array<Record<string, unknown>>)
      : [];
    if (generalizations.length > 0) return issues;

    // 提取需求中的角色列表
    const actorsRaw = Array.isArray(requirementJson.actors)
      ? (requirementJson.actors as Array<Record<string, unknown>>)
      : [];
    const actors = actorsRaw
      .map((a) => ({
        name: String(a?.name ?? "").trim(),
        description: String(a?.description ?? "").trim(),
      }))
      .filter((a) => a.name.length > 0);
    if (actors.length < 2) return issues;

    // 条件 A：是否存在 >=2 个互不相同的角色描述
    const distinctDescriptions = new Set(
      actors.map((a) => a.description).filter((d) => d.length > 0),
    );
    if (distinctDescriptions.size < 2) return issues;

    // 概念名集合
    const concepts = Array.isArray(domainModel.concepts)
      ? (domainModel.concepts as Array<Record<string, unknown>>)
      : [];
    const conceptNames = new Set(
      concepts.map((c) => String(c?.name ?? "").trim()).filter(Boolean),
    );

    // 条件 C：未被建模为独立概念的不同角色（被吸收/压扁）
    const unmodeled = actors.filter((a) => !conceptNames.has(a.name));
    if (unmodeled.length < 2) return issues;

    const actorNames = unmodeled.map((a) => a.name).join(", ");
    issues.push(
      `存在多个属性/职责不同的角色（${actorNames}）被合并且缺少泛化层次——` +
        `必须建模为泛化层次（抽象父类 + 各角色子类，并在 generalizations 中记录），` +
        `而不能用一个扁平实体表示多个职责不同的角色`,
    );
    return issues;
  }

  /** 总额/汇总字段的类型信号（数值/货币类型）。 */
  private static readonly NUMERIC_TYPE_RE =
    /(?:decimal|double|float|number|numeric|long|int|integer|money|currency|bigint|bigdecimal)/i;
  /**
   * 总额/汇总字段的“字段名”信号（精确化）。
   *
   * total/subtotal/grand/sum/aggregate 及中文 总额/合计/总计/小计/总价 作为子串匹配
   * （这些都是强总额语义）；而 amount 仅作为完整字段名匹配（^amount$），避免误命中
   * discountAmount/paidAmount/baseAmount/remainingAmount/subAmount/rebateAmount 等
   * 非总额数值字段。即名为 amount 的字段视为总额，名为 discountAmount 的字段不算。
   */
  private static readonly TOTAL_NAME_SIGNAL_RE =
    /(?:total|subtotal|grand|sum|aggregate|总额|合计|总计|小计|总价|^amount$)/i;
  /**
   * 总额/汇总字段的“描述”信号（较宽松）。
   *
   * 描述文本为自由语言，保留 total/amount/sum/grand/subtotal/aggregate 及中文
   * 总额/合计/金额/总计/小计/总价/款项 的子串匹配。
   */
  private static readonly TOTAL_DESC_SIGNAL_RE =
    /(?:total|amount|sum|grand|subtotal|aggregate|总额|合计|金额|总计|小计|总价|款项)/i;

  /**
   * FIX2 — 明细行分解校验（通用）。
   *
   * 检测模式：一个聚合实体（aggregate）同时满足：
   *   (a) 持有一个“总额/汇总”字段（数值/货币类型 + total/amount/sum 语义）；
   *   (b) 经由一条一对多关联指向明细/记录类概念；
   *   (c) 但没有任何 line_item 概念对其分解。
   * 此时要求添加一个明细行概念（kind: line_item, parentEntity 指向该聚合）。
   *
   * 三个条件合取以保证精度，纯结构性判定，不依赖任何具体概念名。
   */
  static validateLineItemDecomposition(
    domainModel: Record<string, unknown>,
  ): string[] {
    const issues: string[] = [];

    const concepts = Array.isArray(domainModel.concepts)
      ? (domainModel.concepts as Array<Record<string, unknown>>)
      : [];
    const associations = Array.isArray(domainModel.associations)
      ? (domainModel.associations as Array<Record<string, unknown>>)
      : [];
    if (concepts.length === 0) return issues;

    // 已有的 line_item 子概念：parentEntity -> exists
    const lineItemParents = new Set<string>();
    for (const c of concepts) {
      if (String(c?.kind ?? "") === "line_item") {
        const parent = String(c?.parentEntity ?? "").trim();
        if (parent) lineItemParents.add(parent);
      }
    }

    for (const c of concepts) {
      const kind = String(c?.kind ?? "");
      if (kind !== "entity" && kind !== "value_object") continue;
      const name = String(c?.name ?? "").trim();
      if (!name) continue;

      // (a) 是否持有总额字段
      const attrs = Array.isArray(c.attributes)
        ? (c.attributes as Array<Record<string, unknown>>)
        : [];
      const hasTotalField = attrs.some((a) => {
        const type = String(a?.type ?? "");
        const fName = String(a?.name ?? "");
        const desc = String(a?.description ?? "");
        const typeMatch = DomainModelGenerator.NUMERIC_TYPE_RE.test(type);
        // 字段名用精确化规则（amount 仅整名匹配），描述用宽松规则
        const signalMatch =
          DomainModelGenerator.TOTAL_NAME_SIGNAL_RE.test(fName) ||
          DomainModelGenerator.TOTAL_DESC_SIGNAL_RE.test(desc);
        return typeMatch && signalMatch;
      });
      if (!hasTotalField) continue;

      // (b) 是否存在从该聚合出发的一对多关联
      const hasOneToMany = associations.some((rel) => {
        const src = String(rel?.source ?? "").trim();
        const mult = String(rel?.targetMultiplicity ?? "").trim();
        return src === name && mult.includes("*");
      });
      if (!hasOneToMany) continue;

      // (c) 是否已有 line_item 分解
      if (lineItemParents.has(name)) continue;

      issues.push(
        `聚合实体 ${name} 持有总额字段并经由一对多关联指向明细记录，` +
          `但缺少 line_item 明细行概念对其分解——必须添加一个明细行概念` +
          `（kind: line_item, parentEntity: ${name}），而非用单一总额字段压扁`,
      );
    }
    return issues;
  }

  /**
   * FIX3 — 关联端点完整性校验（通用）。
   *
   * 检测模式：任何关联端点引用（associations 的 source/target、
   * association 概念的 connects、line_item 概念的 parentEntity）
   * 必须指向模型中真实存在的概念；引用不存在的概念（幻觉名）即报错。
   *
   * 纯结构性判定，不依赖任何具体概念名。
   */
  static validateEndpointIntegrity(
    domainModel: Record<string, unknown>,
  ): string[] {
    const issues: string[] = [];

    const concepts = Array.isArray(domainModel.concepts)
      ? (domainModel.concepts as Array<Record<string, unknown>>)
      : [];
    const conceptNames = new Set(
      concepts.map((c) => String(c?.name ?? "").trim()).filter(Boolean),
    );
    if (conceptNames.size === 0) return issues;

    const associations = Array.isArray(domainModel.associations)
      ? (domainModel.associations as Array<Record<string, unknown>>)
      : [];

    // associations 数组的 source/target
    for (const rel of associations) {
      for (const key of ["source", "target"] as const) {
        const endpoint = String(rel?.[key] ?? "").trim();
        if (endpoint && !conceptNames.has(endpoint)) {
          issues.push(
            `关联引用了未定义的概念 ${endpoint}（${key} 端点在 concepts 中不存在）`,
          );
        }
      }
    }

    // association 概念的 connects / line_item 概念的 parentEntity
    for (const c of concepts) {
      const kind = String(c?.kind ?? "");
      const owner = String(c?.name ?? "").trim() || "<匿名>";
      if (kind === "association") {
        const connects = Array.isArray(c.connects)
          ? (c.connects as Array<unknown>)
          : [];
        for (const ep of connects) {
          const endpoint = String(ep ?? "").trim();
          if (endpoint && !conceptNames.has(endpoint)) {
            issues.push(
              `关联引用了未定义的概念 ${endpoint}（概念 ${owner} 的 connects 端点在 concepts 中不存在）`,
            );
          }
        }
      } else if (kind === "line_item") {
        const parent = String(c?.parentEntity ?? "").trim();
        if (parent && !conceptNames.has(parent)) {
          issues.push(
            `关联引用了未定义的概念 ${parent}（概念 ${owner} 的 parentEntity 在 concepts 中不存在）`,
          );
        }
      }
    }
    return issues;
  }
}
