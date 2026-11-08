const esbuild = require("esbuild");
const fs = require("node:fs/promises");
const path = require("node:path");

const watch = process.argv.includes("--watch");
const katexDirectory = path.dirname(require.resolve("katex/package.json"));
const pdfjsDirectory = path.dirname(require.resolve("pdfjs-dist/package.json"));

async function copyAssets() {
  await fs.mkdir("dist/fonts", { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(katexDirectory, "dist", "katex.min.css"), "dist/katex.min.css"),
    fs.cp(path.join(katexDirectory, "dist", "fonts"), "dist/fonts", { recursive: true }),
    fs.copyFile(path.join(pdfjsDirectory, "build", "pdf.worker.min.mjs"), "dist/pdf.worker.min.mjs"),
    fs.copyFile(path.join(pdfjsDirectory, "image_decoders", "pdf.image_decoders.min.mjs"), "dist/pdf.image_decoders.mjs"),
    fs.cp(path.join(pdfjsDirectory, "cmaps"), "dist/pdfjs/cmaps", { recursive: true }),
    fs.cp(path.join(pdfjsDirectory, "standard_fonts"), "dist/pdfjs/standard_fonts", { recursive: true })
  ]);
}

async function build() {
  const common = {
    bundle: true,
    sourcemap: true,
    logLevel: "info"
  };

  if (watch) {
    const extension = await esbuild.context({
      ...common,
      entryPoints: ["src/extension.ts"],
      outfile: "dist/extension.js",
      platform: "node",
      format: "cjs",
      external: ["vscode"]
    });
    const webview = await esbuild.context({
      ...common,
      entryPoints: ["src/webview.ts"],
      outfile: "dist/webview.js",
      platform: "browser",
      format: "iife"
    });
    await Promise.all([copyAssets(), extension.watch(), webview.watch()]);
    console.log("Watching LiveLaTeX sources.");
    return;
  }

  await Promise.all([
    esbuild.build({
      ...common,
      entryPoints: ["src/extension.ts"],
      outfile: "dist/extension.js",
      platform: "node",
      format: "cjs",
      external: ["vscode"]
    }),
    esbuild.build({
      ...common,
      entryPoints: ["src/webview.ts"],
      outfile: "dist/webview.js",
      platform: "browser",
      format: "iife"
    }),
    copyAssets()
  ]);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
