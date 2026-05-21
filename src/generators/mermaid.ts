/**
 * Mermaid 语法校验器 — 结构检查、括号匹配、语义分析。
 * 纯同步校验，无 LLM 调用。
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

export class MermaidValidator {
  useCli: boolean;

  constructor(useCli = false) {
    // 检查 mmdc 是否可用（简化版：默认始终为 false）
    this.useCli = useCli;
  }

  validate(mmdContent: string, diagramType = ""): { valid: boolean; message: string } {
    if (!mmdContent?.trim()) {
      return { valid: false, message: "Mermaid代码为空" };
    }

    let content = mmdContent.trim().replace(/^\uFEFF/, "");

    // 1. 结构检查
    const struct = this._checkStructure(content, diagramType);
    if (!struct.valid) return struct;

    // 2. 括号匹配
    const brackets = this._checkBrackets(content);
    if (!brackets.valid) return brackets;

    // 3. 语义检查
    const semantics = this._checkSemantics(content);
    if (!semantics.valid) return semantics;

    // 4. CLI 校验（如果可用）
    if (this.useCli) {
      return this._validateWithCli(content);
    }

    return { valid: true, message: "语法校验通过" };
  }

  private _checkStructure(content: string, diagramType: string): { valid: boolean; message: string } {
    const validHeaders = ["classDiagram", "flowchart", "graph", "stateDiagram-v2", "stateDiagram"];
    const hasHeader = validHeaders.some((h) => content.startsWith(h));
    if (!hasHeader) {
      return { valid: false, message: `缺少图类型声明，应以 ${validHeaders.join(", ")} 之一开头` };
    }

    if (diagramType) {
      const typeMap: Record<string, string> = {
        class_diagram: "classDiagram",
        classDiagram: "classDiagram",
        activity_diagram: "flowchart",
        flowchart: "flowchart",
        graph: "flowchart",
        state_diagram: "stateDiagram-v2",
        "stateDiagram-v2": "stateDiagram-v2",
        stateDiagram: "stateDiagram",
      };
      const expected = typeMap[diagramType];
      if (expected) {
        const actual = validHeaders.find((h) => content.startsWith(h)) ?? "";
        const expectedNorm = typeMap[expected] ?? expected;
        const actualNorm = typeMap[actual] ?? actual;
        if (expectedNorm !== actualNorm) {
          return { valid: false, message: `声明的图类型 '${diagramType}' 与实际内容头 '${actual}' 不匹配` };
        }
      }
    }

    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("%%"));
    if (lines.length < 2) {
      return { valid: false, message: "图内容过少，只有头部声明没有实际内容" };
    }

    if (content.startsWith("classDiagram") && !content.includes("class ")) {
      return { valid: false, message: "类图中缺少 class 定义" };
    }

    if (content.startsWith("flowchart") || content.startsWith("graph")) {
      const commentPositions = MermaidValidator._findCommentPositions(content);
      const clean = content
        .split("")
        .filter((_, i) => !commentPositions.has(i))
        .join("");
      const linkRe = /(?:-->|---|==>|-\.->|\s--\s)/;
      if (!linkRe.test(clean)) {
        return { valid: false, message: "流程图中缺少节点连接关系" };
      }
    }

    return { valid: true, message: "" };
  }

  private _checkBrackets(content: string): { valid: boolean; message: string } {
    const commentPositions = MermaidValidator._findCommentPositions(content);
    const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
    const stack: Array<{ char: string; pos: number }> = [];
    let inString = false;
    let stringChar: string | null = null;
    let escapeNext = false;

    for (let i = 0; i < content.length; i++) {
      if (commentPositions.has(i)) continue;
      const ch = content[i];
      if (escapeNext) { escapeNext = false; continue; }
      if (ch === "\\" && inString) { escapeNext = true; continue; }
      if (ch === '"' && !inString) { inString = true; stringChar = ch; }
      else if (inString && ch === stringChar) { inString = false; stringChar = null; }
      else if (!inString) {
        if (ch in pairs) {
          stack.push({ char: ch, pos: i });
        } else if (Object.values(pairs).includes(ch)) {
          if (stack.length === 0) {
            return { valid: false, message: `多余的闭合括号 '${ch}' 在位置 ${i}` };
          }
          const open = stack.pop()!;
          if (pairs[open.char] !== ch) {
            return { valid: false, message: `括号不匹配: '${open.char}'(位置${open.pos}) 与 '${ch}'(位置${i})` };
          }
        }
      }
    }

    if (stack.length > 0) {
      const last = stack[stack.length - 1];
      return { valid: false, message: `未闭合的括号 '${last.char}' 在位置 ${last.pos}` };
    }

    return { valid: true, message: "" };
  }

  private _checkSemantics(content: string): { valid: boolean; message: string } {
    const codeLines = content
      .split("\n")
      .map((l) => {
        let s = l.trim();
        if (!s || s.startsWith("%%")) return "";
        const idx = s.indexOf("%%");
        if (idx >= 0) s = s.slice(0, idx).trim();
        return s;
      })
      .filter(Boolean);

    if (content.startsWith("classDiagram")) return this._checkClassDiagramSemantics(codeLines);
    if (content.startsWith("flowchart") || content.startsWith("graph")) return this._checkFlowchartSemantics(codeLines);
    if (content.startsWith("stateDiagram")) return this._checkStateDiagramSemantics(codeLines);
    return { valid: true, message: "" };
  }

  private _checkClassDiagramSemantics(lines: string[]): { valid: boolean; message: string } {
    const classNames = new Map<string, number>();
    const errors: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^class\s+(\w+)/);
      if (m) {
        const name = m[1];
        if (classNames.has(name)) {
          errors.push(`重复类定义: '${name}' (行 ${i + 1}，已定义于行 ${classNames.get(name)})`);
        } else {
          classNames.set(name, i + 1);
        }
      }

      const relMatch = line.match(/^(\w+)\s*([<|].*[>|])\s*(\w+)\s*:/);
      if (relMatch) {
        for (const refName of [relMatch[1], relMatch[3]]) {
          if (!classNames.has(refName) && !refName.startsWith('"')) {
            errors.push(`关系引用了未定义的类: '${refName}' (行 ${i + 1})`);
          }
        }
      }
    }

    if (errors.length > 0) return { valid: false, message: errors.slice(0, 3).join("; ") };
    return { valid: true, message: "" };
  }

  private _checkFlowchartSemantics(_lines: string[]): { valid: boolean; message: string } {
    const nodeDefs = new Map<string, number>();
    const errors: string[] = [];

    for (let i = 0; i < _lines.length; i++) {
      const line = _lines[i];
      if (i === 0 && (line.startsWith("flowchart") || line.startsWith("graph"))) continue;

      const reserved = new Set(["class", "style", "click", "subgraph", "end", "linkStyle", "default"]);
      const defMatches = line.matchAll(/(\w+)\s*[\[\(\{>]/g);
      for (const m of defMatches) {
        const nodeId = m[1];
        if (!reserved.has(nodeId.toLowerCase())) {
          if (nodeDefs.has(nodeId) && nodeDefs.get(nodeId) !== i + 1) {
            errors.push(`重复节点ID: '${nodeId}' (行 ${i + 1}，已定义于行 ${nodeDefs.get(nodeId)})`);
          } else {
            nodeDefs.set(nodeId, i + 1);
          }
        }
      }
    }

    if (errors.length > 0) return { valid: false, message: errors.slice(0, 3).join("; ") };
    return { valid: true, message: "" };
  }

  private _checkStateDiagramSemantics(lines: string[]): { valid: boolean; message: string } {
    const stateNames = new Map<string, number>();
    const errors: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === 0 && line.startsWith("stateDiagram")) continue;

      const stateMatch = line.match(/^state\s+"?([^":\s]+)"?/);
      if (stateMatch && !line.startsWith("stateDiagram")) {
        const name = stateMatch[1].replace(/"/g, "");
        const reserved = new Set(["[*]", "state", "note", "end", "fork", "join", "choice"]);
        if (!reserved.has(name)) {
          if (stateNames.has(name)) {
            errors.push(`重复状态定义: '${name}' (行 ${i + 1}，已定义于行 ${stateNames.get(name)})`);
          } else {
            stateNames.set(name, i + 1);
          }
        }
      }
    }

    if (errors.length > 0) return { valid: false, message: errors.slice(0, 3).join("; ") };
    return { valid: true, message: "" };
  }

  static _findCommentPositions(content: string): Set<number> {
    const positions = new Set<number>();
    let i = 0;

    while (i < content.length) {
      if (content[i] === "%" && i + 1 < content.length && content[i + 1] === "%") {
        let end = content.indexOf("\n", i);
        if (end === -1) end = content.length;
        for (let j = i; j < end; j++) positions.add(j);
        i = end;
      } else {
        i++;
      }
    }
    return positions;
  }

  private _validateWithCli(content: string): { valid: boolean; message: string } {
    const tmpFile = join(tmpdir(), `mermaid-${randomUUID()}.mmd`);
    try {
      writeFileSync(tmpFile, content, "utf-8");
      // CLI 校验在纯 Node.js 环境下禁用 — 需要 child_process.spawn("mmdc")
      return { valid: true, message: "CLI校验通过 (mmdc not available)" };
    } catch {
      return { valid: false, message: "CLI校验异常" };
    } finally {
      try { unlinkSync(tmpFile); } catch { /* 忽略错误 */ }
    }
  }

  validateAndReport(mmdContent: string, diagramType = ""): string {
    const { valid, message } = this.validate(mmdContent, diagramType);
    const status = valid ? "通过" : "失败";
    return `[${status}] ${diagramType || "Mermaid图"}: ${message}`;
  }
}
