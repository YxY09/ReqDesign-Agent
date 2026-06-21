# ReqDesign Agent — VSCode 扩展

把 ReqDesign-Agent 的多 Agent 需求设计能力搬进 VSCode 侧边栏：一个类似 Copilot Chat 的对话面板，直接对话、或对需求文件就地运行完整设计流程（需求分析 → 系统设计 → Mermaid 三图 → 测试用例 → 评审），并实时流式展示各 Agent 的工作。

## 架构

- **进程内调用**：扩展宿主（Node）直接 `import` 父项目的 `MultiAgentRuntime` / `LLMClient` 并运行，无子进程。
- **构建**：`esbuild` 把扩展打成 `dist/extension.js`（CJS，从父项目 `../src` 的 TS 源码打包，第三方依赖从父项目 `node_modules` 解析），webview 打成 `media/main.js`（IIFE，内含 `mermaid` + `marked`）。
- **环境解耦**：运行时不依赖 `process.cwd()`——prompts 通过 `REQDESIGN_PROMPT_DIR`、`.env` 预加载进 `process.env`、config/output/log 全用绝对路径。runtime 图通过动态 `import()` 在环境就绪后才加载，避免 `promptLoader` 在激活时过早解析目录。

## 前置条件

扩展需要一个 **ReqDesign-Agent 项目根目录**（包含 `config.yaml`、`prompts/`、`.env` 或对应的 `*_API_KEY` 环境变量）。

- 默认：自动探测当前工作区中包含 `config.yaml` + `prompts/` 的文件夹。
- 或在设置 `reqdesign.projectRoot` 中显式指定绝对路径。

## 开发 / 调试

```bash
cd vscode-extension
npm install          # 安装 esbuild / @types/vscode / mermaid / marked 等
npm run build        # 构建 dist/extension.js 与 media/main.js
# 或 npm run watch   # 监听增量构建
```

然后在 VSCode 里按 `F5`（用本目录下的 `.vscode/launch.json`，或新建一个 “Run Extension” 配置）启动扩展开发宿主，打开你的 ReqDesign-Agent 项目即可在活动栏看到 ReqDesign 图标。

> 父项目**无需**预先 `tsc` 构建——esbuild 直接从 `../src` 的 TypeScript 源码打包，并用一个 `.js → .ts` 解析插件处理父项目 ESM 风格的 `.js` 导入后缀。

## 用法

- 在侧边栏直接提问，与设计助手对话。
- 输入带需求文件路径 + 设计意图（如「设计 examples/ecommerce_order_system.md」），会自动运行设计流程。
- `/design <文件路径>` 显式触发；`/new` 新建会话；`/help` 帮助。
- 点击输入框左侧 📎 选择需求文件并直接设计。
- 编辑器标题栏（`.md`/`.txt`）有「对当前需求文件运行设计流程」按钮。
- 运行中点标题栏停止按钮可取消。
- 设计完成后，助手消息内联渲染 Mermaid 三图，并提供产物文件的可点击链接。

## 设置

| 设置项 | 说明 |
|--------|------|
| `reqdesign.projectRoot` | 项目根目录绝对路径，留空自动探测 |
| `reqdesign.outputDir` | 产物输出目录，留空用 `<根>/outputs/design` |
| `reqdesign.provider` | 覆盖 config.yaml 的 LLM provider |
| `reqdesign.model` | 覆盖 config.yaml 的模型名 |

## 样式说明

为贴合所选的「类 Copilot Chat」原生体验，配色与字体走 VSCode 主题变量；同时按项目设计规范保留 8px 圆角与 300ms cubic-bezier 动效。如需切换为全套 Gruvbox 配色 + 汇文明朝字体，可调整 `media/main.css`。
