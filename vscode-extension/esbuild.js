/**
 * Build script for the ReqDesign Agent VSCode extension.
 *
 * Produces two bundles:
 *   1. dist/extension.js  — the extension host code (CommonJS, Node platform).
 *      This bundle imports the ReqDesign-Agent runtime *from the parent
 *      project's TypeScript source* and runs it in-process. The parent source
 *      uses ESM-style ".js" import specifiers that actually point at ".ts"
 *      files, so a small resolve plugin maps ".js" -> ".ts" when a sibling
 *      ".ts" exists. The parent's third-party deps (@anthropic-ai/sdk, openai,
 *      yaml, zod, ...) resolve from the parent's node_modules via the normal
 *      upward node_modules walk.
 *   2. media/main.js      — the webview UI (IIFE, browser platform), bundling
 *      mermaid + marked for diagram and markdown rendering.
 */
const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * Resolve relative ".js" import specifiers to their ".ts" source sibling.
 * Required because the parent project (../src) is authored as ESM TypeScript
 * with explicit ".js" extensions on relative imports.
 */
const tsExtensionResolvePlugin = {
  name: "js-to-ts-resolve",
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === "entry-point") return undefined;
      if (!args.path.startsWith(".")) return undefined; // bare/package import
      const tsCandidate = path.resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      if (fs.existsSync(tsCandidate)) {
        return { path: tsCandidate };
      }
      return undefined; // let esbuild resolve real .js files normally
    });
  },
};

/** Common esbuild options for the Node-side extension bundle. */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: !production,
  minify: production,
  // `vscode` is provided by the extension host at runtime, never bundle it.
  external: ["vscode"],
  logLevel: "info",
  plugins: [tsExtensionResolvePlugin],
  // The parent code uses `import.meta.url` (promptLoader). In a CJS bundle that
  // is invalid; shim it to a file:// URL derived from __filename so the code
  // evaluates without throwing. The actual prompt dir is supplied via the
  // REQDESIGN_PROMPT_DIR env var set by the extension, so this value is unused.
  define: {
    "import.meta.url": "__import_meta_url",
  },
  banner: {
    js: "const __import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
};

/** esbuild options for the browser-side webview bundle. */
const webviewConfig = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "media/main.js",
  platform: "browser",
  format: "iife",
  target: "es2021",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function run() {
  if (watch) {
    const extCtx = await esbuild.context(extensionConfig);
    const webCtx = await esbuild.context(webviewConfig);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log("[esbuild] watching extension + webview...");
    return;
  }
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
  console.log("[esbuild] build complete");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
