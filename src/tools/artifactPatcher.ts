/**
 * ArtifactPatcher — 将产物拆分为多个章节并应用补丁操作。
 *
 * 供 RepairTool 使用，实现精准修补而非全量重写。
 * 纯工具类，无 LLM 调用，无异步。
 */

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface Section {
  key: string;
  content: string;
}

export interface PatchOp {
  op: "replace_section" | "insert_after" | "remove_section";
  section: string;
  content?: string;
}

export interface JsonPatchOp {
  action: "append" | "replace" | "delete";
  path: string;
  items?: unknown[];
  value?: unknown;
  match?: { field: string; value: string };
}

// ---------------------------------------------------------------------------
// ArtifactPatcher
// ---------------------------------------------------------------------------

export class ArtifactPatcher {
  // --------------------------------------------------------------
  // 章节解析
  // --------------------------------------------------------------

  /** 根据产物类型将产物拆分为命名章节。 */
  static parseSections(content: unknown, taskType: string): Section[] {
    if (taskType === "diagrams") {
      return ArtifactPatcher._parseDiagramSections(content);
    }

    const text =
      typeof content === "string"
        ? content
        : content === null || content === undefined
          ? ""
          : JSON.stringify(content, null, 2);

    if (!text.trim()) {
      return [{ key: "full", content: "" }];
    }

    // 优先尝试 ## 标题拆分
    const h2Sections = ArtifactPatcher._splitByHeading(text, /^## /);
    if (h2Sections.length > 1) return h2Sections;

     // 优先尝试 ### 标题拆分
    const h3Sections = ArtifactPatcher._splitByHeading(text, /^### /);
    if (h3Sections.length > 1) return h3Sections;

    // Single section
    return [{ key: "full", content: text }];
  }

  private static _parseDiagramSections(content: unknown): Section[] {
    if (
      typeof content === "object" &&
      content !== null &&
      !Array.isArray(content)
    ) {
      const dict = content as Record<string, unknown>;
      const diagramKeys = [
        "class_diagram",
        "activity_diagram",
        "state_diagram",
      ];
      const sections: Section[] = [];

      // 优先标准图表键（保持顺序）
      for (const key of diagramKeys) {
        if (key in dict && typeof dict[key] === "string") {
          sections.push({ key, content: dict[key] as string });
        }
      }

      // 包含所有非标准键
      for (const [key, val] of Object.entries(dict)) {
        if (!diagramKeys.includes(key) && typeof val === "string") {
          sections.push({ key, content: val });
        }
      }

      if (sections.length > 0) return sections;
    }

    // 单字符串图表
    const text =
      typeof content === "string" ? content : String(content ?? "");
    return [{ key: "diagram", content: text }];
  }

  private static _splitByHeading(
    text: string,
    headingRegex: RegExp,
  ): Section[] {
    const lines = text.split("\n");
    const sections: Section[] = [];
    let currentKey = "";
    let currentLines: string[] = [];

    for (const line of lines) {
      if (headingRegex.test(line.trim())) {
        if (currentKey || currentLines.some((l) => l.trim())) {
          // 对于初始章节（尚未找到标题），尝试从 # 标题提取键
          let pushKey = currentKey;
          if (!pushKey) {
            const h1Match = currentLines[0]?.trim().match(/^#\s+(.+)/);
            if (h1Match) {
              pushKey = h1Match[1].trim();
            }
          }
          sections.push({
            key: pushKey,
            content: currentLines.join("\n"),
          });
        }
        currentKey = line.trim().replace(/^#+\s*/, "").trim();
        currentLines = [line];
      } else {
        currentLines.push(line);
      }
    }

    if (currentKey || currentLines.some((l) => l.trim())) {
      // 对于第一个章节，如果键为空则尝试从 # 标题提取键
      if (!currentKey) {
        const h1Match = currentLines[0]?.trim().match(/^#\s+(.+)/);
        if (h1Match) {
          currentKey = h1Match[1].trim();
        }
      }
      sections.push({ key: currentKey, content: currentLines.join("\n") });
    }

    return sections;
  }

  // --------------------------------------------------------------
  // 补丁应用
  // --------------------------------------------------------------

  /** 应用补丁操作到解析后的章节，返回拼接后的内容字符串。 */
  static applyPatches(sections: Section[], patches: PatchOp[]): string {
    const result = ArtifactPatcher.applyPatchesDirect(sections, patches);
    return result.map((s) => s.content).join("\n\n");
  }

  /** Apply patches directly on sections, returning modified Section[] (preserves keys). */
  static applyPatchesDirect(sections: Section[], patches: PatchOp[]): Section[] {
    const result = sections.map((s) => ({ ...s }));

    for (const patch of patches) {
      const idx = result.findIndex(
        (s) =>
          s.key === patch.section ||
          s.key.toLowerCase().includes(patch.section.toLowerCase()),
      );

      switch (patch.op) {
        case "replace_section":
          if (idx >= 0 && patch.content !== undefined) {
            result[idx] = { key: result[idx].key, content: patch.content };
          }
          break;

        case "insert_after":
          if (idx >= 0 && patch.content !== undefined) {
            const newKey = ArtifactPatcher._extractHeading(patch.content);
            result.splice(idx + 1, 0, { key: newKey, content: patch.content });
          }
          break;

        case "remove_section":
          if (idx >= 0) {
            result.splice(idx, 1);
          }
          break;
      }
    }

    return result;
  }

  private static _extractHeading(content: string): string {
    const match = content.match(/^#{1,3}\s+(.+)/);
    return match ? match[1].trim() : "section";
  }

  // --------------------------------------------------------------
  // 重建
  // --------------------------------------------------------------

  /** 将章节重新组装为原始产物格式。 */
  static reconstruct(sections: Section[], taskType: string): unknown {
    if (taskType === "diagrams") {
      const dict: Record<string, string> = {};
      for (const s of sections) {
        dict[s.key] = s.content;
      }
      return dict;
    }

    return sections.map((s) => s.content).join("\n\n");
  }

  // --------------------------------------------------------------
  // JSON Patch（ops-based）
  // --------------------------------------------------------------

  /** Apply fine-grained JSON patch operations (append/replace/delete by ID). */
  static applyJsonOps(originalJson: string, ops: JsonPatchOp[]): string {
    const doc = JSON.parse(originalJson);
    for (const op of ops) {
      const arr = doc[op.path];
      if (!Array.isArray(arr)) continue;
      switch (op.action) {
        case "append":
          if (op.items) arr.push(...op.items);
          break;
        case "replace":
          if (op.match) {
            const idx = arr.findIndex(
              (item: unknown) =>
                typeof item === "object" &&
                item !== null &&
                (item as Record<string, unknown>)[op.match!.field] === op.match!.value,
            );
            if (idx >= 0 && op.value !== undefined) arr[idx] = op.value;
          }
          break;
        case "delete":
          if (op.match) {
            const idx = arr.findIndex(
              (item: unknown) =>
                typeof item === "object" &&
                item !== null &&
                (item as Record<string, unknown>)[op.match!.field] === op.match!.value,
            );
            if (idx >= 0) arr.splice(idx, 1);
          }
          break;
      }
    }
    return JSON.stringify(doc, null, 2);
  }

  // --------------------------------------------------------------
  // 验证
  // --------------------------------------------------------------

  /** 检查修补结果是否未显著短于原始内容。 */
  static validateResult(original: string, patched: string): boolean {
    if (!original.trim()) return true;
    return patched.length >= original.length * 0.5;
  }

  /** 获取格式化的章节列表，用于放入 prompt。 */
  static sectionListing(sections: Section[]): string {
    return sections
      .map((s, i) => `${i + 1}. "${s.key}" (${s.content.length} chars)`)
      .join("\n");
  }
}
