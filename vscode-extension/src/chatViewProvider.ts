/**
 * WebviewViewProvider for the ReqDesign chat sidebar.
 *
 * Owns the webview lifecycle, wires the ChatController's `emit` to
 * webview.postMessage, routes inbound webview messages, and exposes proxy
 * methods (newSession / stop / designFile) for editor commands. Actions
 * requested before the view is resolved are queued and flushed once the
 * webview reports `ready`.
 */
import { existsSync, statSync } from "node:fs";
import * as vscode from "vscode";
import { ChatController } from "./chatController.js";
import type { HostToWebview, WebviewToHost } from "./protocol.js";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "reqdesign.chatView";

  private view?: vscode.WebviewView;
  private controller?: ChatController;
  private pending: Array<(c: ChatController) => void> = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webview.html = this.buildHtml(webview);

    const controller = new ChatController({
      emit: (msg: HostToWebview) => {
        void webview.postMessage(msg);
      },
      pickFile: async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "选择需求文件",
          filters: { 需求文档: ["md", "txt", "markdown"], 全部文件: ["*"] },
        });
        return picked?.[0]?.fsPath ?? null;
      },
    });
    this.controller = controller;

    webview.onDidReceiveMessage((raw: WebviewToHost) => {
      void this.onMessage(controller, raw);
    });

    webviewView.onDidDispose(() => {
      controller.dispose();
      if (this.controller === controller) this.controller = undefined;
      if (this.view === webviewView) this.view = undefined;
    });
  }

  // -------------------------------------------------------------------------
  // Command proxies (used by extension.ts)
  // -------------------------------------------------------------------------

  newSession(): void {
    this.run((c) => c.newSession());
  }

  stop(): void {
    this.run((c) => c.cancel());
  }

  designFile(filePath: string): void {
    this.run((c) => void c.runDesignForFile(filePath));
  }

  pickAndDesign(): void {
    this.run((c) => void c.pickAndDesign());
  }

  /** Run an action against the controller, revealing the view if needed. */
  private run(fn: (c: ChatController) => void): void {
    if (this.controller && this.view) {
      this.view.show?.(true);
      fn(this.controller);
      return;
    }
    this.pending.push(fn);
    void vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
  }

  // -------------------------------------------------------------------------
  // Inbound message routing
  // -------------------------------------------------------------------------

  private async onMessage(controller: ChatController, msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case "ready":
        await controller.sendInit();
        for (const fn of this.pending.splice(0)) fn(controller);
        return;
      case "submit":
        await controller.submit(msg.text);
        return;
      case "cancel":
        controller.cancel();
        return;
      case "newSession":
        controller.newSession();
        return;
      case "pickFile":
        await controller.pickAndDesign();
        return;
      case "openPath":
        await this.openPath(msg.path);
        return;
    }
  }

  private async openPath(target: string): Promise<void> {
    if (!target || !existsSync(target)) {
      void vscode.window.showWarningMessage(`路径不存在：${target}`);
      return;
    }
    const uri = vscode.Uri.file(target);
    try {
      if (statSync(target).isDirectory()) {
        await vscode.commands.executeCommand("revealInExplorer", uri);
      } else {
        await vscode.window.showTextDocument(uri, { preview: true });
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`无法打开：${target}（${String(error)}）`);
    }
  }

  // -------------------------------------------------------------------------
  // HTML
  // -------------------------------------------------------------------------

  private buildHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.css"));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: https:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      // Mermaid renders to inline SVG and may use Function internally; allow
      // eval for this local, self-rendered content only.
      `script-src 'nonce-${nonce}' 'unsafe-eval'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>ReqDesign Agent</title>
</head>
<body>
  <div id="status-bar" class="status-bar hidden"></div>
  <div id="transcript" class="transcript"></div>
  <div id="composer" class="composer">
    <div class="input-wrap">
      <textarea id="input" rows="1" placeholder="发消息，或贴上需求文件路径让我设计…"></textarea>
      <div class="composer-toolbar">
        <button id="attach" class="tool-btn" title="选择需求文件并设计" aria-label="选择需求文件">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <span class="toolbar-spacer"></span>
        <span class="composer-hint">Enter 发送 · Shift+Enter 换行</span>
        <button id="send" class="send-btn" title="发送 (Enter)" aria-label="发送" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
        </button>
        <button id="stop" class="send-btn stop hidden" title="停止" aria-label="停止">
          <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>
        </button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
