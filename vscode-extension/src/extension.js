const vscode = require("vscode");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // 命令1: Generate Design
  let generateDesign = vscode.commands.registerCommand(
    "reqdesign.generateDesign",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("请先打开一个需求文档文件");
        return;
      }

      const filePath = editor.document.fileName;
      if (!filePath.endsWith(".md") && !filePath.endsWith(".txt")) {
        vscode.window.showErrorMessage("请打开 .md 或 .txt 格式的需求文档");
        return;
      }

      // 选择输出目录
      const outputUri = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: "选择输出目录",
      });

      if (!outputUri || outputUri.length === 0) {
        return;
      }

      const outputDir = outputUri[0].fsPath;

      // 获取工作区根目录（假设agent.py在工作区根目录）
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("请先打开一个工作区文件夹");
        return;
      }

      const agentPath = path.join(workspaceFolder, "agent", "main.py");
      if (!fs.existsSync(agentPath)) {
        vscode.window.showErrorMessage(`找不到智能体入口文件: ${agentPath}`);
        return;
      }

      vscode.window.showInformationMessage("ReqDesign-Agent: 开始生成设计...");

      const cmd = `python3 -m agent.main --task design --input "${filePath}" --output "${outputDir}"`;

      exec(cmd, { cwd: workspaceFolder }, (error, stdout, stderr) => {
        if (error) {
          vscode.window.showErrorMessage(`执行失败: ${error.message}`);
          return;
        }
        if (stderr) {
          console.warn("stderr:", stderr);
        }
        vscode.window.showInformationMessage(
          `ReqDesign-Agent: 设计生成完成！输出目录: ${outputDir}`
        );
      });
    }
  );

  // 命令2: Open Output Folder
  let openOutput = vscode.commands.registerCommand(
    "reqdesign.openOutput",
    async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("请先打开一个工作区文件夹");
        return;
      }

      const outputDir = path.join(workspaceFolder, "outputs");
      if (!fs.existsSync(outputDir)) {
        vscode.window.showWarningMessage("输出目录不存在，请先运行 Generate Design");
        return;
      }

      vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outputDir));
    }
  );

  // 命令3: Render Mermaid Preview
  let renderMermaid = vscode.commands.registerCommand(
    "reqdesign.renderMermaid",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("请先打开一个 .mmd 文件");
        return;
      }

      const filePath = editor.document.fileName;
      if (!filePath.endsWith(".mmd")) {
        vscode.window.showErrorMessage("请打开 .mmd 格式的Mermaid文件");
        return;
      }

      // 尝试使用mermaid-cli渲染
      const outputPath = filePath.replace(".mmd", ".svg");
      const cmd = `mmdc -i "${filePath}" -o "${outputPath}" -q`;

      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          vscode.window.showWarningMessage(
            `Mermaid CLI渲染失败 (请确保已安装 @mermaid-js/mermaid-cli): ${error.message}`
          );
          return;
        }
        vscode.window.showInformationMessage(`Mermaid图已渲染为: ${outputPath}`);
        // 打开生成的SVG文件
        vscode.commands.executeCommand("vscode.open", vscode.Uri.file(outputPath));
      });
    }
  );

  context.subscriptions.push(generateDesign);
  context.subscriptions.push(openOutput);
  context.subscriptions.push(renderMermaid);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
