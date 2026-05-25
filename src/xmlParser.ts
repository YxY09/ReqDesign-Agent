import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";

interface ParsedReqDoc {
  req_document: {
    p?: ParsedSection[];
  };
}

interface ParsedSection {
  title?: string;
  text_body?: string;
  p?: ParsedSection[];
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

function flattenSections(
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
    if (typeof p.text_body === "string") {
      body = p.text_body.trim().replace(/\s+/g, " ");
    }

    if (title) {
      result.push({ depth, title, body });
    }

    if (p.p) {
      result.push(...flattenSections(p.p, depth + 1));
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
