/**
 * DiagramGenerator — 生成 Mermaid 格式的类图/活动图/状态图。
 * 支持通过 Promise.all 并行生成。
 */

import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";
import { minimizeForPrompt } from "../shared/minimizeJsonForPrompt.js";
import { isRelationLine, matchRelationLine } from "../shared/mermaidRelations.js";
import { BaseGenerator } from "./base.js";

export class DiagramGenerator extends BaseGenerator<string> {
  protected prompts: Record<string, string> = {};

  constructor(llm: LLMClient) {
    super(llm);
    this.prompts = this._loadPrompts();
  }

  async generate(input: unknown): Promise<string> {
    const {
      requirementJson = null,
      designText,
      domainModelJson = null,
      diagramType = "class_diagram",
      systemPrompt,
      requirementText = "",
    } = input as {
      requirementJson?: Record<string, unknown> | null;
      designText: string;
      domainModelJson?: Record<string, unknown> | null;
      diagramType?: string;
      systemPrompt?: string;
      requirementText?: string;
    };
    if (diagramType === "activity_diagram") {
      return this.generateActivityDiagram(
        requirementJson,
        designText,
        systemPrompt,
        requirementText,
      );
    }
    if (diagramType === "state_diagram") {
      return this.generateStateDiagram(
        requirementJson,
        designText,
        systemPrompt,
        requirementText,
      );
    }
    return this.generateClassDiagram(
      requirementJson,
      domainModelJson,
      systemPrompt,
      requirementText,
    );
  }

  private _loadPrompts(): Record<string, string> {
    const templates: Record<string, string> = {};
    for (const name of ["class_diagram", "activity_diagram", "state_diagram"]) {
      const fallback = `请生成Mermaid格式的${name}，基于以下需求：\n\n{requirement_json}\n\n{design_text}`;
      templates[name] = loadPrompt(`${name}.md`, fallback);
    }
    return templates;
  }

  private _buildPrompt(
    template: string,
    requirementJson: Record<string, unknown> | null,
    designText: string,
    requirementText = "",
    diagramType = "",
    classNames?: string[],
    domainModelJson?: Record<string, unknown> | null,
  ): string {
    designText = designText || "";
    let reqStr: string;

    if (!requirementJson && requirementText) {
      reqStr = requirementText.slice(0, 6000);
    } else if (!requirementJson) {
      reqStr = "{}";
    } else if (diagramType === "class_diagram") {
      // class_diagram: only entities (name, key attributes, relationships)
      const entities = (Array.isArray(requirementJson["entities"]) ? requirementJson["entities"] as Array<Record<string, unknown>> : []);
      const parts: string[] = [];

      const entityBlocks = entities.map((e: Record<string, unknown>) => {
        const name = String(e["name"] ?? "");
        const desc = String(e["description"] ?? "");
        const attrs = Array.isArray(e["attributes"]) ? e["attributes"] as Array<Record<string, unknown>> : [];
        const rels = Array.isArray(e["relationships"]) ? e["relationships"] as Array<Record<string, unknown>> : [];

        const attrLines = attrs.map((a: Record<string, unknown>) =>
          `  - ${a["name"]}: ${a["type"]}${a["description"] ? " (" + a["description"] + ")" : ""}`
        );
        const relLines = rels.map((r: Record<string, unknown>) =>
          `  ${name} → ${r["target"]} (${r["type"]})${r["description"] ? ": " + r["description"] : ""}`
        );

        let block = `## 实体：${name}`;
        if (desc) block += `\n${desc}`;
        if (attrLines.length > 0) block += `\n关键属性：\n${attrLines.join("\n")}`;
        if (relLines.length > 0) block += `\n关联关系：\n${relLines.join("\n")}`;
        return block;
      });

      if (entityBlocks.length > 0) {
        parts.push(entityBlocks.join("\n\n"));
        // Also inject entity name list for class name forcing (Bug 4)
        const entityNames = entities.map((e: Record<string, unknown>) => String(e["name"] ?? "")).filter(Boolean);
        if (entityNames.length > 0) {
          parts.push(`## 需求实体清单\n${entityNames.join(", ")}`);
        }
      }

      reqStr = parts.length > 0 ? parts.join("\n\n") : "{}";
    } else if (diagramType === "activity_diagram") {
      // activity_diagram: business_processes + functions + exceptions + constraints
      const parts: string[] = [];

      const processes = Array.isArray(requirementJson["business_processes"])
        ? requirementJson["business_processes"] as Array<Record<string, unknown>> : [];
      const functions = Array.isArray(requirementJson["functions"])
        ? requirementJson["functions"] as Array<Record<string, unknown>> : [];
      const exceptions = Array.isArray(requirementJson["exceptions"])
        ? requirementJson["exceptions"] as Array<Record<string, unknown>> : [];
      const constraints = Array.isArray(requirementJson["constraints"])
        ? requirementJson["constraints"] as Array<Record<string, unknown>> : [];

      if (processes.length > 0) {
        const pLines = processes.map((p: Record<string, unknown>) => {
          const steps = Array.isArray(p["steps"]) ? (p["steps"] as string[]).join(" → ") : "";
          const actors = Array.isArray(p["actors"]) ? (p["actors"] as string[]).join(", ") : "";
          let line = `## 业务流程：${p["name"] ?? ""}`;
          if (actors) line += `\n角色：${actors}`;
          if (steps) line += `\n步骤：${steps}`;
          return line;
        });
        parts.push(pLines.join("\n\n"));
      }

      if (functions.length > 0) {
        const fLines = functions.map((f: Record<string, unknown>) => {
          const fId = String(f["displayId"] ?? f["id"] ?? "");
          let line = `## 功能：${fId} ${f["name"] ?? ""}`;
          if (f["description"]) line += `\n${f["description"]}`;
          const subs = Array.isArray(f["sub_capabilities"]) ? (f["sub_capabilities"] as string[]).filter(Boolean) : [];
          if (subs.length > 0) line += `\n子能力：${subs.join(", ")}`;
          return line;
        });
        parts.push(fLines.join("\n\n"));
      }

      if (constraints.length > 0) {
        parts.push(`## 约束条件\n${constraints.map((c: Record<string, unknown>) => `- ${c["displayId"] ?? c["id"]}: ${c["description"]}`).join("\n")}`);
      }

      if (exceptions.length > 0) {
        parts.push(`## 异常流程\n${exceptions.map((e: Record<string, unknown>) => {
          const eId = String(e["displayId"] ?? e["id"] ?? "");
          let line = `- ${eId}: ${e["description"] ?? ""}`;
          if (e["trigger"]) line += ` (触发: ${e["trigger"]})`;
          if (e["handling"]) line += ` → ${e["handling"]}`;
          return line;
        }).join("\n")}`);
      }

      reqStr = parts.length > 0 ? parts.join("\n\n") : "{}";
    } else if (diagramType === "state_diagram") {
      // state_diagram: entity name list + constraints + exceptions
      const parts: string[] = [];

      const entities = Array.isArray(requirementJson["entities"])
        ? requirementJson["entities"] as Array<Record<string, unknown>> : [];
      const exceptions = Array.isArray(requirementJson["exceptions"])
        ? requirementJson["exceptions"] as Array<Record<string, unknown>> : [];
      const constraints = Array.isArray(requirementJson["constraints"])
        ? requirementJson["constraints"] as Array<Record<string, unknown>> : [];

      const entityNames = entities.map((e: Record<string, unknown>) => String(e["name"] ?? "")).filter(Boolean);
      if (entityNames.length > 0) {
        parts.push(`## 核心实体\n${entityNames.join(", ")}`);
      }

      if (constraints.length > 0) {
        parts.push(`## 约束条件\n${constraints.map((c: Record<string, unknown>) => `- ${c["displayId"] ?? c["id"]}: ${c["description"]}`).join("\n")}`);
      }

      if (exceptions.length > 0) {
        parts.push(`## 异常流程\n${exceptions.map((e: Record<string, unknown>) => {
          const eId = String(e["displayId"] ?? e["id"] ?? "");
          let line = `- ${eId}: ${e["description"] ?? ""}`;
          if (e["trigger"]) line += ` (触发: ${e["trigger"]})`;
          if (e["handling"]) line += ` → ${e["handling"]}`;
          return line;
        }).join("\n")}`);
      }

      reqStr = parts.length > 0 ? parts.join("\n\n") : "{}";
    } else {
      // Default (no diagramType): full JSON for backward compatibility
      reqStr = JSON.stringify(minimizeForPrompt(requirementJson), null, 2);
    }

    reqStr = this.sanitizePlaceholder(reqStr, "design_text");
    let safeDesign = this.sanitizePlaceholder(designText, "requirement_json");
    safeDesign = this.sanitizePlaceholder(safeDesign, "design_text");
    let prompt = template.replace(/\{requirement_json\}/g, reqStr);
    prompt = prompt.replace(/\{design_text\}/g, safeDesign);
    // Mirror generateClassDiagram: inject the authoritative domain model so
    // state/activity diagrams describe DOMAIN concepts rather than leaked
    // implementation classes (Service/Repository) from design_text.
    if (domainModelJson) {
      const domainStr = JSON.stringify(domainModelJson, null, 2);
      const safeDomain = this.sanitizePlaceholder(
        this.sanitizePlaceholder(domainStr, "requirement_json"),
        "design_text",
      );
      prompt = prompt.replace(/\{domain_model_json\}/g, safeDomain);
    } else {
      prompt = prompt.replace(/\{domain_model_json\}/g, "{}");
    }

    // Inject entity names as hard constraint for class/state diagrams,
    // or when explicit classNames are provided (e.g. from class diagram extraction)
    if (designText) {
      const shouldExtract = diagramType === "state_diagram";
      const hasExplicit = classNames && classNames.length > 0;

      if (shouldExtract || hasExplicit) {
        let names: string[];
        if (hasExplicit) {
          names = classNames!;
        } else {
          // Allow-list = requirement entities ∪ design-text core classes so
          // legitimate data entities are always part of the forced class set.
          const entityNames = Array.isArray(requirementJson?.["entities"])
            ? (requirementJson!["entities"] as Array<Record<string, unknown>>)
                .map((e) => String(e["name"] ?? "").trim())
                .filter((n) => n && !/[\u4e00-\u9fff]/.test(n))
            : [];
          const designNames = diagramType === "state_diagram"
            ? DiagramGenerator._extractDesignClassNames(designText)
            : [];
          names = [...new Set([...entityNames, ...designNames])];
        }
        if (names.length > 0) {
          const nameList = names.join(", ");
          if (diagramType === "state_diagram") {
            prompt += `

## 核心实体清单（来自设计文档）
设计文档中定义了以下核心类，状态图必须为每个类生成独立状态机：
${nameList}`;
          } else if (hasExplicit) {
            prompt += `

## 核心实体清单（来自类图分析）
系统设计中涉及以下核心实体：
${nameList}`;
          }
        }
      }
    }

    return prompt;
  }

  /** Extract class names from design_text's "核心类/接口设计" section */
  static _extractDesignClassNames(designText: string): string[] {
    const names: string[] = [];
    // Find the "核心类" section
    const sectionMatch = designText.match(/核心类[^\n]*设计[\s\S]*?(?=\n##\s|\n##[^#]|$)/);
    if (!sectionMatch) return names;
    const section = sectionMatch[0];

    // Source 1: markdown table rows | ClassName | ... |
    const rows = section.split("\n");
    for (const row of rows) {
      const trimmed = row.trim();
      if (!trimmed.startsWith("|")) continue;
      if (trimmed.includes("---")) continue;
      if (trimmed.match(/^\|\s*类名/) || trimmed.match(/^\|\s*-+/)) continue;
      const cells = trimmed.split("|").map(c => c.trim()).filter(Boolean);
      if (cells.length >= 1) {
        const name = cells[0];
        if (/^[A-Z][a-zA-Z0-9]+$/.test(name) && !names.includes(name)) {
          names.push(name);
        }
      }
    }

    // Source 2: sub-headings like "### 1. 核心领域类：ClassName" or "### N. xxx类：ClassName"
    const headingMatches = section.matchAll(/#{2,4}\s+\d*[.\s]*[^：]*[：:]\s*([A-Z][a-zA-Z0-9]+)/g);
    for (const m of headingMatches) {
      if (m[1] && !names.includes(m[1])) {
        names.push(m[1]);
      }
    }

    // Source 3: "关联实体" column — detect header index, then extract PascalCase names
    let relatedColumnIndex = -1;
    for (const row of rows) {
      const trimmed = row.trim();
      if (!trimmed.startsWith("|")) continue;
      const cells = trimmed.split("|").map(c => c.trim()).filter(Boolean);
      const headerIdx = cells.findIndex(c => c.includes("关联实体") || c === "关联");
      if (headerIdx >= 0) {
        relatedColumnIndex = headerIdx;
        break;
      }
    }

    if (relatedColumnIndex >= 0) {
      for (const row of rows) {
        const trimmed = row.trim();
        if (!trimmed.startsWith("|")) continue;
        if (trimmed.includes("---")) continue;
        if (trimmed.match(/^\|\s*类名/) || trimmed.match(/^\|\s*-+/)) continue;
        const cells = trimmed.split("|").map(c => c.trim()).filter(Boolean);
        if (cells.length > relatedColumnIndex) {
          const relatedRaw = cells[relatedColumnIndex];
          const parts = relatedRaw.split(/[,;，、]/);
          for (const part of parts) {
            const name = part.trim();
            if (/^[A-Z][a-zA-Z0-9]+$/.test(name) && !names.includes(name)) {
              names.push(name);
            }
          }
        }
      }
    }

    return names;
  }

  static _extractMermaid(rawResponse: string): string {
    let text = rawResponse.trim();
    const mermaidKeywords = ["classDiagram", "flowchart", "graph", "stateDiagram-v2", "stateDiagram"];

    // 尝试 ```mermaid 代码块
    const blockRe = /```mermaid\s*\n([\s\S]*?)(?:\n```|```|$)/g;
    const blocks: string[] = [];
    let match;
    while ((match = blockRe.exec(text)) !== null) {
      blocks.push(match[1].trim());
    }
    if (blocks.length === 0) {
      const genericRe = /```\s*\n([\s\S]*?)(?:\n```|```|$)/g;
      while ((match = genericRe.exec(text)) !== null) {
        blocks.push(match[1].trim());
      }
    }
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (mermaidKeywords.some((kw) => blocks[i].startsWith(kw))) {
        return DiagramGenerator._normalizeMermaid(blocks[i]);
      }
    }

    // 直接以 Mermaid 开始
    if (mermaidKeywords.some((kw) => text.startsWith(kw))) return DiagramGenerator._normalizeMermaid(text);

    // 查找关键字起始位置
    for (const kw of mermaidKeywords) {
      const idx = text.indexOf(kw);
      if (idx >= 0) return DiagramGenerator._normalizeMermaid(text.slice(idx).trim());
    }

    return DiagramGenerator._normalizeMermaid(text);
  }

  static _normalizeMermaid(text: string): string {
    return text
      .replace(/<br\s*\/?>/gi, " / ")
      .replace(/\s+$/gm, "")
      .trim();
  }

  /**
   * Deterministic fidelity guarantee for class diagrams.
   *
   * Ensures the diagram is a faithful SUPERSET of the authoritative domain
   * model by injecting whatever the LLM omitted — without duplicating what's
   * already correct. Robust to minor JSON shape variance.
   *
   *   (a) every concept of kind entity/line_item/association/value_object
   *       becomes a `class X {}` block, and every enumeration concept becomes
   *       a `class X { <<enumeration>> <literals> }` block. An enumeration may
   *       ALSO appear as the type of an attribute — both usages are allowed;
   *   (b) every generalization becomes a `Parent <|-- Child` line;
   *   (c) every association (with multiplicity) becomes a relationship line;
   *   (d) association concepts (via `connects`) and line_item concepts (via
   *       `parentEntity`) become relationship lines too.
   *
   * Only the `classDiagram` body is considered; non-classDiagram input is
   * returned untouched so state/flowchart generation is never affected.
   */
  static _enforceConceptFidelity(
    mermaid: string,
    domainModelJson: Record<string, unknown>,
  ): string {
    if (!mermaid || !mermaid.includes("classDiagram")) return mermaid;

    const concepts = Array.isArray(domainModelJson.concepts)
      ? (domainModelJson.concepts as Array<Record<string, unknown>>)
      : [];
    const generalizations = Array.isArray(domainModelJson.generalizations)
      ? (domainModelJson.generalizations as Array<Record<string, unknown>>)
      : [];
    const associations = Array.isArray(domainModelJson.associations)
      ? (domainModelJson.associations as Array<Record<string, unknown>>)
      : [];
    if (concepts.length === 0 && generalizations.length === 0 && associations.length === 0) {
      return mermaid;
    }

    // --- Collect what is already present (dedup class injection by name) ---
    const definedClasses = new Set<string>();
    const classDefRe = /class\s+(\w+)\s*\{/g;
    let cm: RegExpExecArray | null;
    while ((cm = classDefRe.exec(mermaid)) !== null) definedClasses.add(cm[1]);
    // Also count bare `class X` definitions (no body) just in case.
    const bareClassRe = /(?:^|\n)\s*class\s+(\w+)\s*(?!\{)/g;
    while ((cm = bareClassRe.exec(mermaid)) !== null) definedClasses.add(cm[1]);

    // Snapshot the classes present in the ORIGINAL diagram (before any
    // injection) so the flattened-entity pruning step can tell a leftover
    // LLM entity (present originally) apart from a freshly injected parent.
    const originalClasses = new Set(definedClasses);

    // `workingText` is the mutable text that all scanners read from and that
    // in-place edits (generalization-parent migration in step b) mutate. It
    // starts as the original `mermaid` and is threaded through the prune pass
    // into the final assembly so every scanner sees the migrated state.
    let workingText = mermaid;

    const hasGeneralizationLine = (parent: string, child: string): boolean => {
      // Match `Parent <|-- Child` or `Child --|> Parent` (with optional cardinality).
      const p = parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const c = child.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re1 = new RegExp(`${p}\\s+(?:\"[^\"]*\"\\s+)?<\\|--;?\\s+(?:\"[^\"]*\"\\s+)?${c}`, "i");
      const re2 = new RegExp(`${c}\\s+(?:\"[^\"]*\"\\s+)?--\\|>\\s+(?:\"[^\"]*\"\\s+)?${p}`, "i");
      return re1.test(workingText) || re2.test(workingText);
    };
    const hasAssociationLine = (source: string, target: string): boolean => {
      const s = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const t = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Directional or undirected; tolerate cardinality/labels between/after.
      const core = `(?:<?--|-->|--|o--|\\*--|\\.\\.>)`;
      const re = new RegExp(
        `${s}\\s+(?:\"[^\"]*\"\\s+)?${core}\\s+(?:\"[^\"]*\"\\s+)?${t}`,
        "i",
      );
      return re.test(workingText);
    };

    // Return the class that `child` currently inherits from (its generalization
    // parent), scanning `workingText` for `<|-- child` or `child --|>` lines.
    // Returns null when the child has no parent yet. Purely structural.
    const findChildGeneralizationParent = (child: string): string | null => {
      const c = child.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const id = "([A-Za-z_]\\w*)";
      const mult = '(?:"[^"]*"\\s+)?';
      // `Parent <|-- Child`  → parent captured on the left.
      const reLeftParent = new RegExp(`^\\s*${id}\\s+${mult}<\\|--;?\\s+${mult}${c}\\b`, "im");
      // `Child --|> Parent`  → parent captured on the right.
      const reRightParent = new RegExp(`^\\s*${c}\\b\\s+${mult}--\\|>;?\\s+${mult}${id}`, "im");
      const m1 = reLeftParent.exec(workingText);
      if (m1) return m1[1];
      const m2 = reRightParent.exec(workingText);
      if (m2) return m2[1];
      return null;
    };
    // True when `child` already inherits from a parent OTHER than
    // `intendedParent` — i.e. injecting `intendedParent <|-- child` would
    // create a dual-parent. Structural (no hardcoded names).
    const childHasAlternateParent = (child: string, intendedParent: string): boolean => {
      const p = findChildGeneralizationParent(child);
      return p !== null && p !== intendedParent;
    };
    // Migrate `child`'s generalization parent to `keepParent`: drop every
    // `<|-- child` / `child --|>` line whose parent is NOT `keepParent`, so the
    // child ends up with exactly the authoritative domain-model parent. The
    // parent class BLOCK is never touched — only relationship lines. Full-line
    // matching (via matchRelationLine) avoids substring collisions.
    const migrateChildToParent = (child: string, keepParent: string): void => {
      const out: string[] = [];
      for (const line of workingText.split("\n")) {
        const rel = matchRelationLine(line);
        if (rel) {
          const left = rel[1];
          const right = rel[2];
          const t = line.trim();
          // `<|--` form: left is the parent, right is the child.
          const dropLeftForm = t.includes("<|--") && right === child && left !== keepParent;
          // `--|>` form: right is the parent, left is the child.
          const dropRightForm = t.includes("--|>") && left === child && right !== keepParent;
          if (dropLeftForm || dropRightForm) continue;
        }
        out.push(line);
      }
      workingText = out.join("\n");
    };

    const injected: string[] = [];

    // (a) Inject missing concept class blocks.
    //
    // Owner decision: enumeration concepts ARE rendered as standalone
    // `class X { <<enumeration>> <literals> }` blocks (matching reference
    // conceptual modeling), AND may also appear as the type of attributes.
    // Domain ENTITIES, association/line-item entities, value objects, and
    // enumerations are all injected as class blocks when missing.
    for (const concept of concepts) {
      const name = String(concept.name ?? "").trim();
      if (!name) continue;
      if (definedClasses.has(name)) continue;
      const kind = String(concept.kind ?? "entity").trim();
      if (kind === "enumeration") {
        // Enumeration: render as a `class X { <<enumeration>>\n<literals> }`
        // block, listing the enum's literal values.
        const literals = Array.isArray(concept.literals)
          ? (concept.literals as unknown[])
              .map((lit) => String(lit).trim())
              .filter(Boolean)
              .map((lit) => `        ${lit}`)
          : [];
        const litBody = literals.length > 0 ? "    <<enumeration>>\n" + literals.join("\n") : "    <<enumeration>>";
        injected.push(`    class ${name} {\n${litBody}\n    }`);
        definedClasses.add(name);
        continue;
      }

      const attrs = Array.isArray(concept.attributes)
        ? (concept.attributes as Array<Record<string, unknown>>)
            .slice(0, 5)
            .map((a) => `        -${String(a.type ?? "String")} ${String(a.name ?? "field")}`)
        : [];
      const abstractMarker = concept.abstract === true ? "    <<abstract>>\n" : "";
      const body = attrs.length > 0 ? abstractMarker + attrs.join("\n") : (abstractMarker ? abstractMarker.trimEnd() : "");
      injected.push(`    class ${name} {\n${body}\n    }`);
      definedClasses.add(name);
    }

    // (b) Inject missing generalization lines.
    //
    // The domain model is the single source of truth for generalization, so
    // each child must end up with EXACTLY the domain-model parent. If the LLM
    // already drew the child under a DIFFERENT parent (e.g. driven by an
    // evaluator rename request), injecting the domain parent on top would
    // create a dual-parent. Instead we MIGRATE: drop the alternate-parent line
    // and inject the authoritative one. The common clean case (child has no
    // parent yet) and the idempotent case (child already under the intended
    // parent) are preserved.
    for (const gen of generalizations) {
      const parent = String(gen.parent ?? "").trim();
      const children = Array.isArray(gen.children)
        ? (gen.children as unknown[]).map((c) => String(c).trim()).filter(Boolean)
        : [];
      if (!parent) continue;
      for (const child of children) {
        // Idempotent: child already inherits from the intended parent.
        if (hasGeneralizationLine(parent, child)) continue;
        // Dual-parent prevention: if the child already has a DIFFERENT parent,
        // migrate it to the authoritative domain-model parent (drop the
        // alternate-parent line) instead of adding a second parent.
        if (childHasAlternateParent(child, parent)) {
          migrateChildToParent(child, parent);
        }
        injected.push(`    ${parent} <|-- ${child}`);
      }
    }

    // (c) Inject missing association lines (with multiplicity).
    for (const assoc of associations) {
      const source = String(assoc.source ?? "").trim();
      const target = String(assoc.target ?? "").trim();
      if (!source || !target) continue;
      if (hasAssociationLine(source, target)) continue;
      const srcMult = String(assoc.sourceMultiplicity ?? "").trim();
      const tgtMult = String(assoc.targetMultiplicity ?? "").trim();
      const label = String(assoc.label ?? "").trim();
      const src = srcMult ? `"${srcMult}" ` : "";
      const tgt = tgtMult ? ` "${tgtMult}"` : "";
      const tail = label ? ` : ${label}` : "";
      injected.push(`    ${source} ${src}-->${tgt}${tail}`);
    }

    // (d) Inject relationship lines for association/line-item CONCEPTS.
    // The authoritative model also encodes connections inline on the concept:
    //   - an association concept carries `connects: [A, B]` (the endpoints it
    //     links), and
    //   - a line_item concept carries `parentEntity` (its owning aggregate).
    // These are first-class structural relationships and must be rendered as
    // relationship lines, not only as class blocks — otherwise the diagram
    // drops the very links the domain model defines.
    for (const concept of concepts) {
      const name = String(concept.name ?? "").trim();
      if (!name) continue;
      const kind = String(concept.kind ?? "entity").trim();

      if (kind === "association" && Array.isArray(concept.connects)) {
        const endpoints = (concept.connects as unknown[])
          .map((c) => String(c).trim())
          .filter(Boolean);
        // Link the association class to each endpoint, and the endpoints to
        // each other, so the connecting relationship is never dropped.
        for (const ep of endpoints) {
          if (ep && definedClasses.has(ep) && !hasAssociationLine(name, ep)) {
            injected.push(`    ${name} --> ${ep}`);
          }
        }
        if (endpoints.length >= 2) {
          const [a, b] = [endpoints[0], endpoints[1]];
          if (!hasAssociationLine(a, b)) {
            injected.push(`    ${a} --> ${b}`);
          }
        }
        continue;
      }

      if (kind === "line_item" && concept.parentEntity) {
        const parent = String(concept.parentEntity).trim();
        if (parent && definedClasses.has(parent) && !hasAssociationLine(parent, name)) {
          injected.push(`    ${parent} "1" --> "*" ${name}`);
        }
      }
    }

    // (e) Prune a LEFTOVER FLATTENED role-tag entity superseded by an
    // injected generalization. When a repair LLM collapsed a hierarchy into
    // a single entity carrying a role/kind/type discriminator, the restored
    // `Parent <|-- Child` hierarchy supersedes it; leaving BOTH the restored
    // hierarchy AND the flattened entity re-triggers the evaluator's
    // extra-class / naming-inconsistency complaint -> repair loop. The
    // pattern is detected GENERALLY (no hardcoded names): a class block that
    // (i) is NOT the generalization parent and NOT one of the children,
    // (ii) was present in the ORIGINAL diagram while the parent was NOT
    //    (i.e. the hierarchy was flattened away and is being restored),
    // (iii) carries a discriminative role/tag field (role/kind/type/角色 /
    //      ...Role/...Type/...Kind), and
    // (iv) whose NON-discriminator attributes are a subset of the parent
    //      concept's attributes (so it is the flattened form of the SAME
    //      hierarchy, not an unrelated business class).
    // A matching block is removed along with any relationship line that
    // referenced it (which would otherwise dangle).
    let prunedText = workingText;
    if (generalizations.length > 0) {
      // Map concept name -> lowercased attribute names for the subset check.
      const conceptAttrs = new Map<string, Set<string>>();
      for (const concept of concepts) {
        const cname = String(concept.name ?? "").trim();
        if (!cname) continue;
        const set = new Set<string>();
        if (Array.isArray(concept.attributes)) {
          for (const a of concept.attributes as Array<Record<string, unknown>>) {
            const an = String(a.name ?? "").trim().toLowerCase();
            if (an) set.add(an);
          }
        }
        conceptAttrs.set(cname, set);
      }
      const isDiscriminatorField = (attrName: string): boolean => {
        const n = attrName.toLowerCase();
        if (n === "role" || n === "kind" || n === "type" || n === "角色") return true;
        return n.endsWith("role") || n.endsWith("type") || n.endsWith("kind");
      };
      const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Remove a class block (and relationship lines referencing it) from text.
      const removeClassBlock = (text: string, blockName: string): string => {
        const startRe = new RegExp(`^\\s*class\\s+${escapeRe(blockName)}\\s*\\{`);
        const out: string[] = [];
        let skipping = false;
        for (const line of text.split("\n")) {
          if (skipping) {
            if (/^\s*\}/.test(line)) skipping = false;
            continue;
          }
          if (startRe.test(line)) {
            skipping = true;
            continue;
          }
          // Drop any relationship line that references the removed class so
          // it does not dangle (the block it pointed at is gone).
          const rel = matchRelationLine(line);
          if (rel && (rel[1] === blockName || rel[2] === blockName)) continue;
          out.push(line);
        }
        return out.join("\n");
      };
      // Parse every `class X { ... }` block -> its attribute-name set.
      const parseClassAttrs = (text: string): Map<string, Set<string>> => {
        const blocks = new Map<string, Set<string>>();
        const ls = text.split("\n");
        for (let i = 0; i < ls.length; i++) {
          const sm = ls[i].match(/^\s*class\s+(\w+)\s*\{/);
          if (!sm) continue;
          const attrs = new Set<string>();
          for (let j = i + 1; j < ls.length; j++) {
            if (/^\s*\}/.test(ls[j])) break;
            const t = ls[j].trim();
            if (!t || t.startsWith("<<")) continue;
            const body = t.replace(/^[-+~#]\s*/, "");
            let attrName: string | null = null;
            const colonM = body.match(/^(\w+)\s*:/);
            if (colonM) {
              attrName = colonM[1];
            } else {
              const parts = body.split(/\s+/);
              if (parts.length >= 2) attrName = parts[parts.length - 1];
              else if (parts.length === 1 && /^[-+~#]/.test(t)) attrName = parts[0];
            }
            if (attrName && /^\w+$/.test(attrName)) attrs.add(attrName);
          }
          blocks.set(sm[1], attrs);
        }
        return blocks;
      };

      for (const gen of generalizations) {
        const parent = String(gen.parent ?? "").trim();
        const children = Array.isArray(gen.children)
          ? (gen.children as unknown[]).map((c) => String(c).trim()).filter(Boolean)
          : [];
        if (!parent) continue;
        // Only act when the hierarchy was flattened away: the parent is NOT
        // in the original diagram (it is being injected/restored now).
        if (originalClasses.has(parent)) continue;
        const childSet = new Set(children);
        const parentAttrSet = conceptAttrs.get(parent) ?? new Set<string>();
        for (const [xName, xAttrs] of parseClassAttrs(prunedText)) {
          // (i) not part of the hierarchy, and present in the original diagram.
          if (xName === parent || childSet.has(xName)) continue;
          if (!originalClasses.has(xName)) continue;
          // (iii) carries a discriminative role/tag field.
          const hasDisc = [...xAttrs].some((a) => isDiscriminatorField(a));
          if (!hasDisc) continue;
          // (iv) NON-discriminator attributes are a subset of the parent's.
          const nonDisc = [...xAttrs].filter((a) => !isDiscriminatorField(a));
          const subsetOk = nonDisc.every((a) => parentAttrSet.has(a.toLowerCase()));
          if (!subsetOk) continue;
          prunedText = removeClassBlock(prunedText, xName);
        }
      }
    }
    // `workingText` may already differ from `mermaid` if step (b) migrated an
    // alternate parent line; `prunedText` may differ from `workingText` if the
    // prune pass removed a leftover flattened entity. Either change is real.
    const didMigrate = workingText !== mermaid;
    const didPrune = prunedText !== workingText;

    if (injected.length === 0 && !didPrune && !didMigrate) return mermaid;

    // Insert injected lines right before the first relationship line, so the
    // new `class {}` blocks precede the relations that may reference them; if
    // there is no relationship line yet, append at the end.
    const base = prunedText;
    if (injected.length === 0) return base;
    const lines = base.split("\n");
    const firstRelIdx = lines.findIndex((l) => isRelationLine(l));
    if (firstRelIdx === -1) {
      return base.replace(/\s+$/, "") + "\n" + injected.join("\n");
    }
    lines.splice(firstRelIdx, 0, ...injected);
    return lines.join("\n");
  }

  async generateClassDiagram(
    requirementJson: Record<string, unknown> | null,
    domainModelJson: Record<string, unknown> | null,
    systemPrompt?: string,
    _requirementText = "",
  ): Promise<string> {
    const template = this.prompts["class_diagram"];
    const domainStr = domainModelJson ? JSON.stringify(domainModelJson, null, 2) : "{}";
    const reqStr = requirementJson
      ? this._buildClassDiagramReqStr(requirementJson)
      : "{}";
    let prompt = template
      .replace(/\{domain_model_json\}/g, this.sanitizePlaceholder(domainStr, "requirement_json"))
      .replace(/\{requirement_json\}/g, this.sanitizePlaceholder(reqStr, "domain_model_json"));
    const raw = await this.llm.generateText(prompt, systemPrompt ?? "");
    const extracted = DiagramGenerator._extractMermaid(raw);
    // Deterministic fidelity guarantee: ensure the class diagram is a faithful
    // superset of the authoritative domain model (no dropped enums / line
    // items / associations / generalizations). See _enforceConceptFidelity.
    if (domainModelJson && Object.keys(domainModelJson).length > 0) {
      return DiagramGenerator._enforceConceptFidelity(extracted, domainModelJson);
    }
    return extracted;
  }

  private _buildClassDiagramReqStr(requirementJson: Record<string, unknown>): string {
    const entities = Array.isArray(requirementJson["entities"])
      ? requirementJson["entities"] as Array<Record<string, unknown>>
      : [];
    if (entities.length === 0) return "{}";
    const blocks = entities.map((e: Record<string, unknown>) => {
      const name = String(e["name"] ?? "");
      const attrs = Array.isArray(e["attributes"]) ? e["attributes"] as Array<Record<string, unknown>> : [];
      const attrLines = attrs.map((a: Record<string, unknown>) =>
        `  - ${a["name"]}: ${a["type"]}${a["description"] ? " (" + a["description"] + ")" : ""}`
      );
      let block = `${name}`;
      if (attrLines.length > 0) block += `\n${attrLines.join("\n")}`;
      return block;
    });
    return blocks.join("\n\n");
  }

  async generateActivityDiagram(
    requirementJson: Record<string, unknown> | null,
    designText: string,
    systemPrompt?: string,
    requirementText = "",
    classNames?: string[],
    domainModelJson?: Record<string, unknown> | null,
  ): Promise<string> {
    const prompt = this._buildPrompt(this.prompts["activity_diagram"], requirementJson, designText, requirementText, "activity_diagram", classNames, domainModelJson);
    const raw = await this.llm.generateText(prompt, systemPrompt ?? "");
    return DiagramGenerator._extractMermaid(raw);
  }

  async generateStateDiagram(
    requirementJson: Record<string, unknown> | null,
    designText: string,
    systemPrompt?: string,
    requirementText = "",
    classNames?: string[],
    domainModelJson?: Record<string, unknown> | null,
  ): Promise<string> {
    const prompt = this._buildPrompt(this.prompts["state_diagram"], requirementJson, designText, requirementText, "state_diagram", classNames, domainModelJson);
    const raw = await this.llm.generateText(prompt, systemPrompt ?? "");
    return DiagramGenerator._extractMermaid(raw);
  }

  async generateAll(
    requirementJson: Record<string, unknown> | null,
    designText: string,
    systemPrompt?: string,
    requirementText = "",
    domainModelJson?: Record<string, unknown> | null,
  ): Promise<Record<string, string>> {
    const sp = systemPrompt;
    const rt = requirementText;
    const results: Record<string, string> = {};

    // Phase 1: class diagram from domain model (not design text)
    let classMermaid = "";
    try {
      classMermaid = await this.generateClassDiagram(requirementJson, domainModelJson ?? null, sp, rt);
    } catch (e) {
      console.warn("[DiagramGenerator] 图表生成失败:", e);
      classMermaid = "";
    }

    if (!classMermaid?.trim()) {
      try { classMermaid = await this.generateClassDiagram(requirementJson, domainModelJson ?? null, sp, rt); } catch (e) { console.warn("[DiagramGenerator] 图表生成失败:", e); }
    }
    results["class_diagram"] = classMermaid || "";

    // Extract class names from generated class diagram for activity/state diagrams
    const extractedClassNames: string[] = [];
    if (classMermaid?.trim()) {
      const classRegex = /class\s+(\w+)/g;
      let match: RegExpExecArray | null;
      while ((match = classRegex.exec(classMermaid)) !== null) {
        if (match[1] && !extractedClassNames.includes(match[1])) {
          extractedClassNames.push(match[1]);
        }
      }
    }

    // Phase 2: activity and state diagrams still use designText
    const phase2Tasks: Array<{ name: string; fn: () => Promise<string> }> = [
      { name: "activity_diagram", fn: () => this.generateActivityDiagram(requirementJson, designText, sp, rt, extractedClassNames, domainModelJson ?? null) },
      { name: "state_diagram", fn: () => this.generateStateDiagram(requirementJson, designText, sp, rt, extractedClassNames, domainModelJson ?? null) },
    ];

    const settled = await Promise.allSettled(phase2Tasks.map((t) => t.fn()));

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        let val = result.value;
        if (!val?.trim()) {
          try { val = await phase2Tasks[i].fn(); } catch (e) { console.warn("[DiagramGenerator] 图表生成失败:", e); }
        }
        results[phase2Tasks[i].name] = val?.trim() ? val : "";
      } else {
        results[phase2Tasks[i].name] = "";
      }
    }

    return results;
  }
}
