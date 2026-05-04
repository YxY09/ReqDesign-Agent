# ReqDesign-Agent VSCode Extension

VSCode插件，提供快捷方式调用ReqDesign-Agent智能体。

## 功能

### 命令

| 命令 | 说明 |
|------|------|
| ReqDesign: Generate Design | 基于当前打开的需求文档生成设计模型 |
| ReqDesign: Open Output Folder | 打开输出目录 |
| ReqDesign: Render Mermaid Preview | 将当前.mmd文件渲染为SVG |

### 使用方法

1. 在VSCode中打开ReqDesign-Agent项目文件夹
2. 打开一个需求文档（.md或.txt格式）
3. 按 `Ctrl+Shift+P` 打开命令面板
4. 输入 `ReqDesign` 选择对应命令

### 前置要求

- Python 3.10+
- ReqDesign-Agent项目依赖已安装
- 可选：安装 `@mermaid-js/mermaid-cli` 用于Mermaid图渲染

### 安装

```bash
# 在VSCode中
# 1. 打开扩展面板
# 2. 从VSIX安装，或直接将vscode-extension目录复制到VSCode扩展目录
```

## 开发

```bash
cd vscode-extension
npm install
# 按F5启动调试
```
