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

export function parseXmlString(xml: string): string {
  const parser = new XMLParser({
    ignoreAttributes: true,
    isArray: (name) => name === "p",
  });

  const doc = parser.parse(xml) as ParsedReqDoc;
  const paragraphs = doc.req_document?.p ?? [];
  const sections = flattenSections(paragraphs, 1);
  return sections.map(formatSection).join("\n\n");
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
