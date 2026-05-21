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
    return prompt;
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
    const prompt = this._buildPrompt(this.prompts["class_diagram"], requirementJson, designText, requirementText);
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
