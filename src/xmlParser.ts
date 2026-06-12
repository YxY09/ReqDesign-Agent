import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// SectionIndex — structured section metadata for slicing
// ---------------------------------------------------------------------------

export interface SectionIndex {
  id: string;
  depth: number;
  title: string;
  body: string;
  charRange: [number, number];
}

interface ParsedReqDoc {
  req_document: {
    p?: ParsedSection[];
  };
}

interface ParsedSection {
  title?: string;
  text_body?: string | Record<string, unknown>;
  p?: ParsedSection[];
  req?: ParsedSection[];
}

export function parseXmlRequirement(xmlPath: string): string {
  const raw = readFileSync(xmlPath, "utf8");
  return parseXmlString(raw);
}

/** Extract a document structure overview from parsed XML sections. */
function extractStructure(sections: Array<{ depth: number; title: string; body: string }>): string {
  const lines: string[] = [];
  for (const s of sections) {
    const indent = "  ".repeat(Math.max(0, s.depth - 1));
    const bullet = s.depth <= 2 ? s.title : `${indent}- ${s.title}`;
    lines.push(bullet);
  }
  if (lines.length === 0) return "";
  const overview = [
    `## 文档结构概览（共${sections.length}个章节）`,
    "",
    "本文档包含以下主要章节，请在分析时确保覆盖所有章节内容：",
    "",
    lines.join("\n"),
    "",
    "---",
    "",
  ];
  return overview.join("\n");
}

export function parseXmlString(xml: string): string {
  const parser = new XMLParser({
    ignoreAttributes: true,
    isArray: (name) => name === "p",
  });

  const doc = parser.parse(xml) as ParsedReqDoc;
  const paragraphs = doc.req_document?.p ?? [];
  const sections = flattenSections(paragraphs, 1);
  const structureOverview = extractStructure(sections);
  const mdContent = sections.map(formatSection).join("\n\n");
  return structureOverview + mdContent;
}

function extractText(textBody: string | Record<string, unknown> | undefined): string {
  if (!textBody) return '';
  if (typeof textBody === 'string') return textBody;
  // 处理对象（含 itemize/enum）- 递归提取所有字符串值
  const parts: string[] = [];
  for (const val of Object.values(textBody)) {
    if (typeof val === 'string') parts.push(val);
    else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string') parts.push(item);
        else if (typeof item === 'object') parts.push(extractText(item as Record<string, unknown>));
      }
    } else if (typeof val === 'object') {
      parts.push(extractText(val as Record<string, unknown>));
    }
  }
  return parts.join('\n');
}

function flattenSections(
  paragraphs: ParsedSection[],
  depth: number,
): Array<{ depth: number; title: string; body: string }> {
  return flattenSectionsRaw(paragraphs, depth);
}

function flattenSectionsRaw(
  paragraphs: ParsedSection[],
  depth: number,
): Array<{ depth: number; title: string; body: string }> {
  const result: Array<{ depth: number; title: string; body: string }> = [];

  for (const p of paragraphs) {
    let title = "";
    let body = "";

    if (typeof p.title === "string") {
      title = p.title.trim();
    }

    // 处理 text_body（可能是对象（含 itemize/enum）或字符串）
    const bodyText = extractText(p.text_body);
    if (bodyText) {
      body = bodyText.trim().replace(/\s+/g, " ");
    }

    if (title) {
      result.push({ depth, title, body });
    }

    // 处理 <req> 子元素
    if (p.req) {
      for (const req of p.req) {
        const reqBody = extractText(req.text_body);
        if (reqBody) {
          result.push({ depth: depth + 1, title: reqBody.trim().replace(/\s+/g, " "), body: "" });
        }
        if (req.p) {
          result.push(...flattenSectionsRaw(req.p, depth + 1));
        }
      }
    }

    if (p.p) {
      result.push(...flattenSectionsRaw(p.p, depth + 1));
    }
  }

  return result;
}

function formatSection(s: { depth: number; title: string; body: string }): string {
  const heading = "#".repeat(Math.min(s.depth, 6));
  let text = `${heading} ${s.title}`;
  if (s.body) {
    text += `\n\n${s.body}`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// extractSectionIndex — build section metadata from raw XML
// ---------------------------------------------------------------------------

export function extractSectionIndex(xml: string): SectionIndex[] {
  const parser = new XMLParser({
    ignoreAttributes: true,
    isArray: (name) => name === "p",
  });

  const doc = parser.parse(xml) as ParsedReqDoc;
  const paragraphs = doc.req_document?.p ?? [];
  const rawSections = flattenSectionsRaw(paragraphs, 1);

  if (rawSections.length === 0) return [];

  // Build the same markdown that parseXmlString returns (with structure overview)
  const structureOverview = extractStructure(rawSections);
  const mdContent = rawSections.map(formatSection).join("\n\n");
  const fullMd = structureOverview + mdContent;

  // Compute char ranges within the full markdown
  let currentPos = structureOverview.length; // skip the overview prefix
  const indices: SectionIndex[] = [];
  const depthCounters: Record<number, number> = {};

  for (let i = 0; i < rawSections.length; i++) {
    const s = rawSections[i];
    const sectionMd = formatSection(s);
    const start = fullMd.indexOf(sectionMd, currentPos);
    const actualStart = start >= 0 ? start : currentPos;
    const end = actualStart + sectionMd.length;
    currentPos = end;

    // Generate stable ID: s{depth}-{counter}
    if (!depthCounters[s.depth]) depthCounters[s.depth] = 0;
    depthCounters[s.depth]++;
    const id = `s${s.depth}-${depthCounters[s.depth]}`;

    indices.push({
      id,
      depth: s.depth,
      title: s.title,
      body: s.body,
      charRange: [actualStart, end],
    });
  }

  return indices;
}

// ---------------------------------------------------------------------------
// sliceBySections — extract specific sections from markdown
// ---------------------------------------------------------------------------

export function sliceBySections(
  markdown: string,
  sections: SectionIndex[],
  sectionIds?: string[],
): string {
  if (!sectionIds || sectionIds.length === 0) {
    return markdown;
  }

  const idSet = new Set(sectionIds);
  const parts: string[] = [];

  for (const section of sections) {
    if (idSet.has(section.id)) {
      const [start, end] = section.charRange;
      parts.push(markdown.slice(start, end));
    }
  }

  return parts.join("\n\n");
}
