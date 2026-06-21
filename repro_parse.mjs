import fs from "node:fs";

const tracePath = process.argv[2]
  ?? "benchmark/results/compare/v28-ecommerce/ecommerce_order_system/agent/traces/llm_trace.json";
const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
console.log("TRACE:", tracePath);

// ---- copied verbatim from src/llmClient.ts (types stripped) ----
function matchBraces(text) {
  const openChar = text[0];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0, inString = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { if (inString) escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) { depth--; if (depth === 0) return text.slice(0, i + 1); }
  }
  return null;
}
function canParseJsonCandidate(text) {
  try { JSON.parse(text); return true; }
  catch { try { JSON.parse(stripCommentsAndTrailingCommas(text)); return true; } catch { return false; } }
}
function extractJsonText(raw) {
  const trimmed = raw.trim();
  const codeBlockMatches = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)];
  for (const match of codeBlockMatches) { const c = match[1].trim(); if (canParseJsonCandidate(c)) return c; }
  if (codeBlockMatches.length > 0) return codeBlockMatches[0][1].trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const extracted = matchBraces(trimmed);
    if (extracted && canParseJsonCandidate(extracted)) return extracted;
    if (extracted) return extracted;
  }
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== "{" && ch !== "[") continue;
    const extracted = matchBraces(trimmed.slice(i));
    if (extracted && canParseJsonCandidate(extracted)) return extracted;
  }
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace !== -1) { const sub = trimmed.slice(firstBrace); const e = matchBraces(sub); if (e) return e; return sub; }
  return trimmed;
}
function extractJsonCandidates(raw) {
  const trimmed = raw.trim();
  const candidates = []; const seen = new Set();
  const add = (v) => { const c = v?.trim(); if (!c || seen.has(c)) return; seen.add(c); candidates.push(c); };
  for (const m of trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)) add(m[1]);
  for (let i = 0; i < trimmed.length; i++) { const ch = trimmed[i]; if (ch !== "{" && ch !== "[") continue; add(matchBraces(trimmed.slice(i))); }
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace !== -1) add(trimmed.slice(firstBrace));
  add(trimmed);
  return candidates;
}
function stripCommentsAndTrailingCommas(text) {
  let result = ""; let i = 0; let inString = false; let escape = false;
  while (i < text.length) {
    const ch = text[i];
    if (escape) { result += ch; escape = false; i++; continue; }
    if (ch === "\\" && inString) { result += ch; escape = true; i++; continue; }
    if (ch === '"') { inString = !inString; result += ch; i++; continue; }
    if (inString) { result += ch; i++; continue; }
    if (ch === "/" && i + 1 < text.length && text[i + 1] === "/") { i += 2; while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "/" && i + 1 < text.length && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && i + 1 < text.length && text[i + 1] === "/")) i++; i += 2; continue; }
    result += ch; i++;
  }
  result = result.replace(/,\s*([}\]])/g, "$1");
  return result;
}
function tryCompleteJson(text) {
  let result = text.trimEnd().replace(/[,:\s]+$/, "");
  let braceDepth = 0, bracketDepth = 0, inString = false, escape = false;
  for (let i = 0; i < result.length; i++) {
    const ch = result[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") braceDepth++; else if (ch === "}") braceDepth--; else if (ch === "[") bracketDepth++; else if (ch === "]") bracketDepth--;
  }
  if (inString) result += '"';
  result = result.replace(/,\s*$/, "");
  for (let i = 0; i < bracketDepth; i++) result += "]";
  for (let i = 0; i < braceDepth; i++) result += "}";
  return result;
}
function parseJsonResponse(raw) {
  const primary = extractJsonText(raw);
  const candidates = [primary, ...extractJsonCandidates(raw).filter((c) => c !== primary)];
  let lastError = null;
  for (const jsonText of candidates) {
    try { return { value: JSON.parse(jsonText), via: "raw", cand: jsonText }; } catch (e) { lastError = e; }
    const cleaned = stripCommentsAndTrailingCommas(jsonText);
    try { return { value: JSON.parse(cleaned), via: "stripped", cand: jsonText }; } catch (e) { lastError = e; }
    const completed = tryCompleteJson(cleaned);
    try { return { value: JSON.parse(completed), via: "completed", cand: jsonText }; } catch (e) { lastError = e; }
  }
  throw new Error("all candidates failed: " + (lastError?.message ?? "?"));
}

function findParseErrorPos(s) {
  try { JSON.parse(s); return null; } catch (e) {
    const m = /position (\d+)/.exec(e.message);
    const pos = m ? Number(m[1]) : -1;
    let codes = "";
    if (pos >= 0) {
      const win = s.slice(Math.max(0, pos - 3), pos + 3);
      codes = [...win].map((c) => c.charCodeAt(0)).join(",");
    }
    return { msg: e.message, pos, around: pos >= 0 ? JSON.stringify(s.slice(Math.max(0, pos - 45), pos + 45)) : "", codes };
  }
}
// scan for raw control chars (0x00-0x1F except \t\n\r) anywhere in the string
function findControlChars(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const cc = s.charCodeAt(i);
    if (cc < 0x20 && cc !== 9 && cc !== 10 && cc !== 13) {
      out.push({ i, cc });
      if (out.length >= 5) break;
    }
  }
  return out;
}

const designs = trace.entries.filter((e) => String(e.data?.tag ?? "").includes("design:attempt"));
for (const e of designs) {
  const raw = e.data.response_text;
  const tag = e.data.tag.split(" ")[0];
  console.log("\n===== " + tag + " len=" + raw.length);
  const directErr = findParseErrorPos(raw);
  console.log("JSON.parse(raw):", directErr ? "FAIL @" + directErr.pos + " " + directErr.msg : "OK");
  if (directErr && directErr.pos >= 0) { console.log("  around:", directErr.around); console.log("  charcodes:", directErr.codes); }
  const ctrl = findControlChars(raw);
  if (ctrl.length) console.log("  RAW CONTROL CHARS:", ctrl.map((c) => "@" + c.i + "=0x" + c.cc.toString(16)).join(" "));
  const mb = matchBraces(raw.trim());
  console.log("matchBraces len=" + (mb ? mb.length : "null") + " full=" + (mb === raw.trim()));
  const primary = extractJsonText(raw);
  console.log("extractJsonText -> first=[" + primary[0] + "] len=" + primary.length);
  try {
    const res = parseJsonResponse(raw);
    const v = res.value;
    const isArr = Array.isArray(v);
    console.log("parseJsonResponse -> " + (isArr ? "ARRAY(len=" + v.length + ")" : "OBJECT(keys=" + Object.keys(v).join(",") + ")") + " via=" + res.via);
    console.log("  base.ts check -> " + ((typeof v !== "object" || v === null || isArr) ? "GEN_NON_DICT (non-dict type: " + typeof v + ")" : "PASS (dict)"));
  } catch (err) { console.log("parseJsonResponse THREW:", err.message); }
}
