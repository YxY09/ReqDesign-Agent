/**
 * Document Normalizer — converts XML requirement documents into
 * anchored sentence-level structures with stable spanIds.
 *
 * Each sentence gets a unique sentenceId (e.g. "SEC_HELP_MODULE_001"),
 * and a SpanEvidence entry is created in the spanMap for traceability.
 */

import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SpanEvidence {
  sentenceId: string;
  sectionId: string;
  sourceText: string;
}

export interface DocumentSection {
  sectionId: string;
  title: string;
  paragraphs: DocumentParagraph[];
}

export interface DocumentParagraph {
  paragraphId: string;
  sentences: Array<{ sentenceId: string; text: string }>;
}

// ---------------------------------------------------------------------------
// Internal parser types (mirrors xmlParser.ts structural assumptions)
// ---------------------------------------------------------------------------

interface ParsedSection {
  title?: string;
  text_body?: string | Record<string, unknown>;
  p?: ParsedSection[];
  req?: ParsedSection[];
}

interface ParsedReqDoc {
  req_document: {
    p?: ParsedSection[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Title → "SEC_TITLE_SLUG", untitled → "SEC_NNN" */
function titleToSectionId(title: string | undefined, counter: number): string {
  if (title && title.trim().length > 0) {
    const slug = title
      .trim()
      .replace(/[^\p{L}\p{N}\s]/gu, "")   // strip punctuation
      .replace(/\s+/g, "_")
      .toUpperCase();
    if (slug.length > 0) return `SEC_${slug}`;
  }
  return `SEC_${String(counter).padStart(3, "0")}`;
}

/** Extract plain text from text_body which may be string or object (itemize/enum). */
function extractText(textBody: string | Record<string, unknown> | undefined): string {
  if (!textBody) return "";
  if (typeof textBody === "string") return textBody;
  const parts: string[] = [];
  for (const val of Object.values(textBody)) {
    if (typeof val === "string") {
      parts.push(val);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") parts.push(item);
        else if (typeof item === "object") parts.push(extractText(item as Record<string, unknown>));
      }
    } else if (typeof val === "object") {
      parts.push(extractText(val as Record<string, unknown>));
    }
  }
  return parts.join("\n");
}

/**
 * Split text into sentences.
 *
 * Strategy:
 * 1. Split on sentence-terminating punctuation (. ! ?。！？) followed by space/end
 * 2. If no sentences found, fall back to splitting on newlines
 * 3. Strip extra whitespace and punctuation from each sentence
 * 4. Filter out empty strings
 */
function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Try period-based splitting first
  const periodSplit = trimmed
    .split(/(?<=[.!?。！？])\s*/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (periodSplit.length > 1) {
    return periodSplit;
  }

  // Fallback: split on newlines
  const lineSplit = trimmed
    .split(/\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  return lineSplit;
}

/** Strip leading/trailing punctuation marks and whitespace from sentence text. */
function cleanSentence(text: string): string {
  return text
    .replace(/^[.!?。！？，,、；;：:\s]+/, "")
    .replace(/[.!?。！？，,、；;：:\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Recursive section walker
// ---------------------------------------------------------------------------

interface FlattenedSection {
  sectionId: string;
  title: string;
  paragraphs: Array<{ text: string }>;
}

function flattenSections(
  paragraphs: ParsedSection[],
  sectionCounter: { value: number },
): FlattenedSection[] {
  const result: FlattenedSection[] = [];

  for (const p of paragraphs) {
    const title = typeof p.title === "string" ? p.title.trim() : "";

    // Collect paragraphs for this section
    const sectionParagraphs: Array<{ text: string }> = [];

    // Direct text_body on this <p>
    const bodyText = extractText(p.text_body);
    if (bodyText.trim()) {
      // Trim outer whitespace but preserve internal newlines for CJK splitting
      sectionParagraphs.push({ text: bodyText.trim().replace(/[ \t]+/g, " ") });
    }

    if (title) {
      const sectionId = titleToSectionId(title, sectionCounter.value);
      sectionCounter.value++;

      result.push({
        sectionId,
        title,
        paragraphs: [...sectionParagraphs],
      });
    } else if (sectionParagraphs.length > 0) {
      // Untitled section with content
      const sectionId = titleToSectionId(undefined, sectionCounter.value);
      sectionCounter.value++;
      result.push({
        sectionId,
        title: "",
        paragraphs: sectionParagraphs,
      });
    }

    // Process <req> children as paragraphs belonging to the most recent section
    if (p.req) {
      for (const req of p.req) {
        const reqBody = extractText(req.text_body);
        if (reqBody.trim()) {
          const paraText = reqBody.trim().replace(/[ \t]+/g, " ");
          if (result.length > 0) {
            result[result.length - 1].paragraphs.push({ text: paraText });
          } else {
            // Orphan <req> — create a bare section
            const sectionId = titleToSectionId(undefined, sectionCounter.value);
            sectionCounter.value++;
            result.push({
              sectionId,
              title: "",
              paragraphs: [{ text: paraText }],
            });
          }
        }
        // Recurse into <req> sub-sections
        if (req.p) {
          result.push(...flattenSections(req.p, sectionCounter));
        }
      }
    }

    // Recurse into nested <p>
    if (p.p) {
      result.push(...flattenSections(p.p, sectionCounter));
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an XML requirement document and produce anchored sentence structure.
 *
 * @param xmlText - Raw XML string (the req_document format).
 * @returns sections array and a spanMap from sentenceId → SpanEvidence.
 */
export function normalizeDocument(xmlText: string): {
  sections: DocumentSection[];
  spanMap: Map<string, SpanEvidence>;
} {
  const parser = new XMLParser({
    ignoreAttributes: true,
    isArray: (name) => name === "p",
  });

  const doc = parser.parse(xmlText) as ParsedReqDoc;
  const paragraphs = doc.req_document?.p ?? [];

  const sectionCounter = { value: 1 };
  const rawSections = flattenSections(paragraphs, sectionCounter);

  const sections: DocumentSection[] = [];
  const spanMap = new Map<string, SpanEvidence>();

  for (const raw of rawSections) {
    const paragraphs: DocumentParagraph[] = [];
    let sentCounter = 1;

    for (let pi = 0; pi < raw.paragraphs.length; pi++) {
      const paraText = raw.paragraphs[pi].text;
      const rawSentences = splitSentences(paraText);

      const sentences: Array<{ sentenceId: string; text: string }> = [];
      for (const rawSent of rawSentences) {
        const clean = cleanSentence(rawSent);
        if (!clean) continue;

        const sentenceId = `${raw.sectionId}_${String(sentCounter++).padStart(3, "0")}`;
        sentences.push({ sentenceId, text: clean });
        spanMap.set(sentenceId, {
          sentenceId,
          sectionId: raw.sectionId,
          sourceText: clean,
        });
      }

      paragraphs.push({
        paragraphId: `${raw.sectionId}_P${String(pi + 1).padStart(3, "0")}`,
        sentences,
      });
    }

    sections.push({
      sectionId: raw.sectionId,
      title: raw.title,
      paragraphs,
    });
  }

  return { sections, spanMap };
}
