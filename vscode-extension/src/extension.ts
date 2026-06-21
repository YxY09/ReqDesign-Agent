/**
 * Extension entry point. Registers the chat sidebar webview provider and the
 * ReqDesign commands. The runtime itself runs in-process inside ChatController.
 */
import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider.js";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("reqdesign.focusChat", () => {
      void vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand("reqdesign.newSession", () => {
      provider.newSession();
    }),
    vscode.commands.registerCommand("reqdesign.stop", () => {
      provider.stop();
    }),
    vscode.commands.registerCommand("reqdesign.designCurrentFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage("没有打开的编辑器。请先打开一个需求文件。");
        return;
      }
      if (editor.document.isUntitled || editor.document.isDirty) {
        await editor.document.save();
      }
      provider.designFile(editor.document.uri.fsPath);
    }),
  );
}

export function deactivate(): void {
  /* subscriptions are disposed by VSCode; controller is disposed on view dispose */
}
