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
    <button id="attach" class="icon-btn" title="选择需求文件并设计">📎</button>
    <textarea id="input" rows="1" placeholder="输入消息，或带上需求文件路径让我做设计…（Enter 发送，Shift+Enter 换行）"></textarea>
    <button id="send" class="icon-btn primary" title="发送">↑</button>
    <button id="stop" class="icon-btn danger hidden" title="停止">■</button>
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
