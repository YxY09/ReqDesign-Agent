/**
 * Webview UI for the ReqDesign chat sidebar.
 *
 * Renders the transcript (markdown via marked + Mermaid diagrams), handles
 * streaming chunks, collapsible agent-activity cards, a sticky workflow status
 * header, and the composer. Talks to the extension host over postMessage using
 * the shared protocol.
 */
import { marked } from "marked";
import mermaid from "mermaid";
import type { HostToWebview, PanelSnapshot, WebviewMessage, WebviewToHost } from "../protocol.js";

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

marked.setOptions({ gfm: true, breaks: true });

const isDark =
  document.body.classList.contains("vscode-dark") ||
  document.body.classList.contains("vscode-high-contrast");
mermaid.initialize({
  startOnLoad: false,
  theme: isDark ? "dark" : "default",
  securityLevel: "loose",
  themeVariables: { fontFamily: "var(--vscode-editor-font-family)" },
});

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const transcript = byId<HTMLDivElement>("transcript");
const statusBar = byId<HTMLDivElement>("status-bar");
const input = byId<HTMLTextAreaElement>("input");
const sendBtn = byId<HTMLButtonElement>("send");
const stopBtn = byId<HTMLButtonElement>("stop");
const attachBtn = byId<HTMLButtonElement>("attach");

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

// ---------------------------------------------------------------------------
// Message model
// ---------------------------------------------------------------------------
interface RenderedMessage {
  meta: WebviewMessage;
  root: HTMLDivElement;
  body: HTMLDivElement;
}
const messages = new Map<string, RenderedMessage>();
let mermaidSeq = 0;
const dirty = new Set<string>();
let rafScheduled = false;

function scheduleRender(id: string): void {
  dirty.add(id);
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(flush);
}

function flush(): void {
  rafScheduled = false;
  const atBottom = isNearBottom();
  for (const id of dirty) {
    const m = messages.get(id);
    if (m) renderBody(m);
  }
  dirty.clear();
  if (atBottom) scrollToBottom();
}

function renderBody(m: RenderedMessage): void {
  const html = marked.parse(m.meta.content || "") as string;
  m.body.innerHTML = html;
  void renderMermaid(m.body);
}

async function renderMermaid(container: HTMLElement): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>("code.language-mermaid");
  for (const code of Array.from(blocks)) {
    const pre = code.parentElement;
    if (!pre) continue;
    const source = code.textContent ?? "";
    const hash = String(source.length) + ":" + source.slice(0, 24);
    if (pre.dataset.mmdHash === hash && pre.dataset.mmdState === "ok") continue;
    pre.dataset.mmdHash = hash;
    try {
      const { svg } = await mermaid.render(`mmd-${mermaidSeq++}`, source);
      const wrapper = document.createElement("div");
      wrapper.className = "mermaid-svg";
      wrapper.innerHTML = svg;
      pre.replaceWith(wrapper);
    } catch {
      // Incomplete or invalid diagram: leave the code block, retry next flush.
      pre.dataset.mmdState = "pending";
    }
  }
}

// ---------------------------------------------------------------------------
// Transcript operations
// ---------------------------------------------------------------------------
function appendMessage(meta: WebviewMessage): void {
  const root = document.createElement("div");
  root.className = `msg msg-${meta.role} variant-${meta.variant ?? "plain"}`;
  root.dataset.id = meta.id;

  const collapsible = meta.variant === "card" || meta.variant === "event";
  if (collapsible && meta.collapsed) root.classList.add("collapsed");
  if (meta.active) root.classList.add("active");

  if (meta.title || meta.subtitle || collapsible) {
    const head = document.createElement("div");
    head.className = "msg-head";
    if (collapsible) {
      const chevron = document.createElement("span");
      chevron.className = "chevron";
      chevron.textContent = "▸";
      head.appendChild(chevron);
    }
    const title = document.createElement("span");
    title.className = "msg-title";
    title.textContent = meta.title || roleLabel(meta.role);
    head.appendChild(title);
    if (meta.subtitle) {
      const sub = document.createElement("span");
      sub.className = "msg-subtitle";
      sub.textContent = meta.subtitle;
      head.appendChild(sub);
    }
    if (collapsible) {
      head.addEventListener("click", () => root.classList.toggle("collapsed"));
    }
    root.appendChild(head);
  }

  const body = document.createElement("div");
  body.className = "msg-body";
  root.appendChild(body);

  transcript.appendChild(root);
  const rendered: RenderedMessage = { meta, root, body };
  messages.set(meta.id, rendered);
  renderBody(rendered);
  scrollToBottom();
}

function streamInto(id: string, chunk: string): void {
  const m = messages.get(id);
  if (!m) return;
  m.meta.content += chunk;
  scheduleRender(id);
}

function patchMessage(id: string, patch: Partial<WebviewMessage>): void {
  const m = messages.get(id);
  if (!m) return;
  Object.assign(m.meta, patch);
  if (patch.active === false) m.root.classList.remove("active");
  if (patch.collapsed === true) m.root.classList.add("collapsed");
  if (patch.collapsed === false) m.root.classList.remove("collapsed");
  if (patch.content !== undefined) scheduleRender(id);
}

function roleLabel(role: WebviewMessage["role"]): string {
  switch (role) {
    case "user":
      return "你";
    case "assistant":
      return "助手";
    case "error":
      return "错误";
    case "system":
      return "系统";
    default:
      return "状态";
  }
}

// ---------------------------------------------------------------------------
// Status header
// ---------------------------------------------------------------------------
function renderPanel(panel: PanelSnapshot | null): void {
  if (!panel || panel.mode === "idle" || panel.mode === "chat") {
    statusBar.classList.add("hidden");
    return;
  }
  statusBar.classList.remove("hidden");
  const dot = panel.runStatus === "running" || panel.llmStatus === "streaming" ? "running" : panel.runStatus;
  const tasks = `${panel.completedTasks}/${panel.plannedTasks}`;
  statusBar.innerHTML = "";
  statusBar.appendChild(chip(`● ${panel.runStatus}`, dot));
  if (panel.currentAgent) statusBar.appendChild(chip(`agent: ${panel.currentAgent}`));
  if (panel.plannedTasks) statusBar.appendChild(chip(`任务 ${tasks}`));
  if (panel.failedTasks) statusBar.appendChild(chip(`失败 ${panel.failedTasks}`, "error"));
  if (panel.totalTokens) statusBar.appendChild(chip(`${panel.totalTokens} tok`));
  if (panel.llmStatus && panel.llmStatus !== "idle") statusBar.appendChild(chip(panel.llmStatus));
}

function chip(text: string, kind = ""): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "chip" + (kind ? ` chip-${kind}` : "");
  el.textContent = text;
  return el;
}

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------
function isNearBottom(): boolean {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
}
function scrollToBottom(): void {
  transcript.scrollTop = transcript.scrollHeight;
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
function autoResize(): void {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}

function submit(): void {
  const text = input.value.trim();
  if (!text) return;
  vscode.postMessage({ type: "submit", text });
  input.value = "";
  autoResize();
}

input.addEventListener("input", autoResize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
sendBtn.addEventListener("click", submit);
stopBtn.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
attachBtn.addEventListener("click", () => vscode.postMessage({ type: "pickFile" }));

// Intercept link clicks: route local-file links to the host, block the rest.
transcript.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest("a");
  if (!target) return;
  e.preventDefault();
  const href = target.getAttribute("href") ?? "";
  if (href.startsWith("reqdesign:open?")) {
    const p = decodeURIComponent(href.slice("reqdesign:open?".length));
    vscode.postMessage({ type: "openPath", path: p });
  }
});

function setBusy(busy: boolean): void {
  sendBtn.classList.toggle("hidden", busy);
  stopBtn.classList.toggle("hidden", !busy);
  sendBtn.disabled = busy;
}

// ---------------------------------------------------------------------------
// Host -> webview message handling
// ---------------------------------------------------------------------------
window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      // Greeting messages arrive separately as append events.
      break;
    case "append":
      appendMessage(msg.message);
      break;
    case "stream":
      streamInto(msg.id, msg.chunk);
      break;
    case "patch":
      patchMessage(msg.id, msg.patch);
      break;
    case "busy":
      setBusy(msg.busy);
      break;
    case "panel":
      renderPanel(msg.panel);
      break;
    case "clear":
      transcript.innerHTML = "";
      messages.clear();
      dirty.clear();
      statusBar.classList.add("hidden");
      break;
    case "notice":
      showNotice(msg.level, msg.text);
      break;
  }
});

let noticeTimer: ReturnType<typeof setTimeout> | null = null;
function showNotice(level: "info" | "error", text: string): void {
  let el = document.getElementById("notice");
  if (!el) {
    el = document.createElement("div");
    el.id = "notice";
    document.body.appendChild(el);
  }
  el.className = `notice notice-${level}`;
  el.textContent = text;
  el.classList.remove("hidden");
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el?.classList.add("hidden"), 3500);
}

autoResize();
vscode.postMessage({ type: "ready" });
