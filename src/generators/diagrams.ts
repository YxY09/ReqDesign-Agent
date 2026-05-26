/**
 * DiagramGenerator — 生成 Mermaid 格式的类图/活动图/状态图。
 * 支持通过 Promise.all 并行生成。
 */

import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";
import { BaseGenerator } from "./base.js";

export class DiagramGenerator extends BaseGenerator<string> {
  protected prompts: Record<string, string> = {};

  constructor(llm: LLMClient) {
    super(llm);
    this.prompts = this._loadPrompts();
  }

  async generate(
    requirementJson: Record<string, unknown> | null,
    designText: string,
    diagramType = "class_diagram",
    systemPrompt?: string,
    requirementText = "",
  ): Promise<string> {
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
      designText,
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
          let line = `## 功能：${f["id"] ?? ""} ${f["name"] ?? ""}`;
          if (f["description"]) line += `\n${f["description"]}`;
          const subs = Array.isArray(f["sub_capabilities"]) ? (f["sub_capabilities"] as string[]).filter(Boolean) : [];
          if (subs.length > 0) line += `\n子能力：${subs.join(", ")}`;
          return line;
        });
        parts.push(fLines.join("\n\n"));
      }

      if (constraints.length > 0) {
        parts.push(`## 约束条件\n${constraints.map((c: Record<string, unknown>) => `- ${c["id"]}: ${c["description"]}`).join("\n")}`);
      }

      if (exceptions.length > 0) {
        parts.push(`## 异常流程\n${exceptions.map((e: Record<string, unknown>) => {
          let line = `- ${e["id"]}: ${e["description"] ?? ""}`;
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
        parts.push(`## 约束条件\n${constraints.map((c: Record<string, unknown>) => `- ${c["id"]}: ${c["description"]}`).join("\n")}`);
      }

      if (exceptions.length > 0) {
        parts.push(`## 异常流程\n${exceptions.map((e: Record<string, unknown>) => {
          let line = `- ${e["id"]}: ${e["description"] ?? ""}`;
          if (e["trigger"]) line += ` (触发: ${e["trigger"]})`;
          if (e["handling"]) line += ` → ${e["handling"]}`;
          return line;
        }).join("\n")}`);
      }

      reqStr = parts.length > 0 ? parts.join("\n\n") : "{}";
    } else {
      // Default (no diagramType): full JSON for backward compatibility
      reqStr = JSON.stringify(requirementJson, null, 2);
    }

    reqStr = this.sanitizePlaceholder(reqStr, "design_text");
    let safeDesign = this.sanitizePlaceholder(designText, "requirement_json");
    safeDesign = this.sanitizePlaceholder(safeDesign, "design_text");
    let prompt = template.replace(/\{requirement_json\}/g, reqStr);
    prompt = prompt.replace(/\{design_text\}/g, safeDesign);

    // Inject entity names as hard constraint for class/state diagrams,
    // or when explicit classNames are provided (e.g. from class diagram extraction)
    if (designText) {
      const shouldExtract = diagramType === "class_diagram" || diagramType === "state_diagram";
      const hasExplicit = classNames && classNames.length > 0;

      if (shouldExtract || hasExplicit) {
        const names = hasExplicit ? classNames! : DiagramGenerator._extractDesignClassNames(designText);
        if (names.length > 0) {
          const nameList = names.join(", ");
          if (diagramType === "class_diagram") {
            prompt += `

## 强制类名清单（最高优先级）
设计文档中定义了以下核心类，类图必须使用这些精确名称，禁止改名或新增：
${nameList}
输出前逐一核对上述清单中的每个类名是否在类图中出现且拼写完全一致。`;
          } else if (diagramType === "state_diagram") {
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

  async generateClassDiagram(
    requirementJson: Record<string, unknown> | null,
    designText: string,
    systemPrompt?: string,
    requirementText = "",
  ): Promise<string> {
    const prompt = this._buildPrompt(this.prompts["class_diagram"], requirementJson, designText, requirementText, "class_diagram");
    const raw = await this.llm.generateText(prompt, systemPrompt ?? "");
    return DiagramGenerator._extractMermaid(raw);
  }

  async generateActivityDiagram(
    requirementJson: Record<string, unknown> | null,
    designText: string,
    systemPrompt?: string,
    requirementText = "",
    classNames?: string[],
  ): Promise<string> {
    const prompt = this._buildPrompt(this.prompts["activity_diagram"], requirementJson, designText, requirementText, "activity_diagram", classNames);
    const raw = await this.llm.generateText(prompt, systemPrompt ?? "");
    return DiagramGenerator._extractMermaid(raw);
  }

  async generateStateDiagram(
    requirementJson: Record<string, unknown> | null,
    designText: string,
    systemPrompt?: string,
    requirementText = "",
    classNames?: string[],
  ): Promise<string> {
    const prompt = this._buildPrompt(this.prompts["state_diagram"], requirementJson, designText, requirementText, "state_diagram", classNames);
    const raw = await this.llm.generateText(prompt, systemPrompt ?? "");
    return DiagramGenerator._extractMermaid(raw);
  }

  async generateAll(
    requirementJson: Record<string, unknown> | null,
    designText: string,
    systemPrompt?: string,
    requirementText = "",
  ): Promise<Record<string, string>> {
    const sp = systemPrompt;
    const rt = requirementText;
    const results: Record<string, string> = {};

    // Phase 1: generate class diagram first (serial) to extract entity names
    let classMermaid = "";
    try {
      classMermaid = await this.generateClassDiagram(requirementJson, designText, sp, rt);
    } catch {
      classMermaid = "";
    }

    if (!classMermaid?.trim()) {
      try { classMermaid = await this.generateClassDiagram(requirementJson, designText, sp, rt); } catch { /* keep empty */ }
    }
    results["class_diagram"] = classMermaid || "";

    // Extract class names from the generated class diagram mermaid
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

    // Phase 2: generate activity and state diagrams in parallel, informed by class names
    const phase2Tasks: Array<{ name: string; fn: () => Promise<string> }> = [
      { name: "activity_diagram", fn: () => this.generateActivityDiagram(requirementJson, designText, sp, rt, extractedClassNames) },
      { name: "state_diagram", fn: () => this.generateStateDiagram(requirementJson, designText, sp, rt, extractedClassNames) },
    ];

    const settled = await Promise.allSettled(phase2Tasks.map((t) => t.fn()));
    const failed: string[] = [];

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        let val = result.value;
        // 空结果重试一次
        if (!val?.trim()) {
          try { val = await phase2Tasks[i].fn(); } catch { /* 保持空值 */ }
        }
        if (!val?.trim()) {
          failed.push(phase2Tasks[i].name);
          results[phase2Tasks[i].name] = "";
        } else {
          results[phase2Tasks[i].name] = val;
        }
      } else {
        failed.push(phase2Tasks[i].name);
        results[phase2Tasks[i].name] = "";
      }
    }

    return results;
  }
}
