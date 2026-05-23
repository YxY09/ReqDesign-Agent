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
    isClassDiagram = false,
  ): string {
    designText = designText || "";
    let reqStr: string;

    if (!requirementJson && requirementText) {
      reqStr = requirementText.slice(0, 6000);
    } else if (!requirementJson) {
      reqStr = "{}";
    } else {
      reqStr = JSON.stringify(requirementJson, null, 2);
    }

    reqStr = this.sanitizePlaceholder(reqStr, "design_text");
    let safeDesign = this.sanitizePlaceholder(designText, "requirement_json");
    safeDesign = this.sanitizePlaceholder(safeDesign, "design_text");
    let prompt = template.replace(/\{requirement_json\}/g, reqStr);
    prompt = prompt.replace(/\{design_text\}/g, safeDesign);

    // For class diagrams, extract class names from design_text and inject as hard constraint
    if (isClassDiagram && designText) {
      const designClassNames = DiagramGenerator._extractDesignClassNames(designText);
      if (designClassNames.length > 0) {
        const nameList = designClassNames.join(", ");
        prompt += `\n\n## 强制类名清单（最高优先级）\n设计文档中定义了以下核心类，类图必须使用这些精确名称，禁止改名或新增：\n${nameList}\n输出前逐一核对上述清单中的每个类名是否在类图中出现且拼写完全一致。`;
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
    const prompt = this._buildPrompt(this.prompts["class_diagram"], requirementJson, designText, requirementText, true);
    const raw = await this.llm.generateText(prompt, systemPrompt ?? "");
    return DiagramGenerator._extractMermaid(raw);
  }

  async generateActivityDiagram(
    requirementJson: Record<string, unknown> | null,
    designText: string,
    systemPrompt?: string,
    requirementText = "",
  ): Promise<string> {
    const prompt = this._buildPrompt(this.prompts["activity_diagram"], requirementJson, designText, requirementText);
    const raw = await this.llm.generateText(prompt, systemPrompt ?? "");
    return DiagramGenerator._extractMermaid(raw);
  }

  async generateStateDiagram(
    requirementJson: Record<string, unknown> | null,
    designText: string,
    systemPrompt?: string,
    requirementText = "",
  ): Promise<string> {
    const prompt = this._buildPrompt(this.prompts["state_diagram"], requirementJson, designText, requirementText);
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

    const tasks: Array<{ name: string; fn: () => Promise<string> }> = [
      { name: "class_diagram", fn: () => this.generateClassDiagram(requirementJson, designText, sp, rt) },
      { name: "activity_diagram", fn: () => this.generateActivityDiagram(requirementJson, designText, sp, rt) },
      { name: "state_diagram", fn: () => this.generateStateDiagram(requirementJson, designText, sp, rt) },
    ];

    const settled = await Promise.allSettled(tasks.map((t) => t.fn()));
    const failed: string[] = [];

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        let val = result.value;
        // 空结果重试一次
        if (!val?.trim()) {
          try { val = await tasks[i].fn(); } catch { /* 保持空值 */ }
        }
        if (!val?.trim()) {
          failed.push(tasks[i].name);
          results[tasks[i].name] = "";
        } else {
          results[tasks[i].name] = val;
        }
      } else {
        failed.push(tasks[i].name);
        results[tasks[i].name] = "";
      }
    }

    return results;
  }
}
