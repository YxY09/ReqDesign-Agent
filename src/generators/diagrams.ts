/**
 * DiagramGenerator — generates Mermaid-format class/activity/state diagrams.
 * Supports parallel generation via Promise.all.
 */

import type { LLMClient } from "../llmClient.js";
import { loadPrompt } from "../promptLoader.js";

export class DiagramGenerator {
  private llm: LLMClient;
  private prompts: Record<string, string>;

  constructor(llm: LLMClient) {
    this.llm = llm;
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

    reqStr = reqStr.replace(/\{design_text\}/g, "");
    const safeDesign = designText.replace(/\{requirement_json\}/g, "").replace(/\{design_text\}/g, "");
    let prompt = template.replace(/\{requirement_json\}/g, reqStr);
    prompt = prompt.replace(/\{design_text\}/g, safeDesign);
    return prompt;
  }

  static _extractMermaid(rawResponse: string): string {
    let text = rawResponse.trim();
    const mermaidKeywords = ["classDiagram", "flowchart", "graph", "stateDiagram-v2", "stateDiagram"];

    // Try ```mermaid code blocks
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

    // Direct mermaid
    if (mermaidKeywords.some((kw) => text.startsWith(kw))) return DiagramGenerator._normalizeMermaid(text);

    // Find keyword start
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
        // Retry empty results once
        if (!val?.trim()) {
          try { val = await tasks[i].fn(); } catch { /* keep empty */ }
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
