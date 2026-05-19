/**
 * Simple XML requirement document parser.
 * Extracts <title> + <text_body> from <req_document>/<p> structure
 * and converts to Markdown text suitable for LLM input.
 */

import { readFileSync } from "node:fs";

export function parseXmlRequirement(xmlPath: string): string {
  const raw = readFileSync(xmlPath, "utf8");

  const tokens = tokenize(raw);
  const sections = buildSections(tokens);
  return sections.map((s) => formatSection(s)).join("\n\n");
}

interface Section {
  depth: number;
  title: string;
  body: string;
}

function tokenize(raw: string): Array<{ type: "p_open" | "p_close" | "title" | "text_body"; content: string }> {
  const tokens: Array<{ type: "p_open" | "p_close" | "title" | "text_body"; content: string }> = [];
  let i = 0;

  while (i < raw.length) {
    // Skip XML declaration and comments
    if (raw.slice(i).startsWith("<?xml") || raw.slice(i).startsWith("<!--")) {
      const end = raw.indexOf(">", i);
      if (end >= 0) { i = end + 1; continue; }
    }

    // <req_document ...> or </req_document>
    if (raw.slice(i).startsWith("<req_document")) {
      const end = raw.indexOf(">", i);
      i = end >= 0 ? end + 1 : i + 1;
      continue;
    }
    if (raw.slice(i).startsWith("</req_document>")) {
      i += "</req_document>".length;
      continue;
    }

    // <title>...</title>
    if (raw.slice(i).startsWith("<title>")) {
      const start = i + "<title>".length;
      const end = raw.indexOf("</title>", start);
      if (end >= 0) {
        tokens.push({ type: "title", content: raw.slice(start, end).trim() });
        i = end + "</title>".length;
        continue;
      }
    }

    // <text_body>...</text_body>
    if (raw.slice(i).startsWith("<text_body>")) {
      const start = i + "<text_body>".length;
      const end = raw.indexOf("</text_body>", start);
      if (end >= 0) {
        tokens.push({ type: "text_body", content: raw.slice(start, end).trim() });
        i = end + "</text_body>".length;
        continue;
      }
    }

    // <p ...>
    if (raw.slice(i).startsWith("<p")) {
      const end = raw.indexOf(">", i);
      if (end >= 0) {
        tokens.push({ type: "p_open", content: raw.slice(i, end + 1) });
        i = end + 1;
        continue;
      }
    }

    // </p>
    if (raw.slice(i).startsWith("</p>")) {
      tokens.push({ type: "p_close", content: "</p>" });
      i += "</p>".length;
      continue;
    }

    // <version>...</version>, <authors> etc. — skip
    if (raw[i] === "<") {
      const end = raw.indexOf(">", i);
      i = end >= 0 ? end + 1 : i + 1;
      continue;
    }

    // Skip whitespace/text between tags
    i++;
  }

  return tokens;
}

function buildSections(tokens: Array<{ type: string; content: string }>): Section[] {
  const sections: Section[] = [];
  let depth = 0;
  let currentTitle = "";
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok.type === "p_open") {
      depth++;
    } else if (tok.type === "p_close") {
      depth = Math.max(0, depth - 1);
    } else if (tok.type === "title") {
      currentTitle = tok.content;
      // Peak ahead for text_body
      let body = "";
      let j = i + 1;
      while (j < tokens.length && tokens[j].type !== "p_close" && tokens[j].type !== "p_open") {
        if (tokens[j].type === "text_body") {
          body = tokens[j].content;
        }
        j++;
      }
      if (currentTitle) {
        sections.push({ depth, title: currentTitle, body });
      }
    }

    i++;
  }

  return sections;
}

function formatSection(s: Section): string {
  const heading = "#".repeat(Math.min(s.depth, 6));
  let text = `${heading} ${s.title}`;
  if (s.body) {
    // Clean up body: normalize whitespace, fix common OCR artifacts
    const clean = s.body
      .replace(/\s+/g, " ")
      .replace(/'\s+asction/g, "'s action")
      .replace(/'\s+hsardware/g, "'s hardware")
      .trim();
    text += `\n\n${clean}`;
  }
  return text;
}
