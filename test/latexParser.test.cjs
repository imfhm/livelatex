const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText;
  module._compile(output, filename);
};

const { parseLatex } = require(path.join("..", "src", "latexParser.ts"));
const { resolveGraphicFiles } = require(path.join("..", "src", "graphicPaths.ts"));

test("resolves graphics from relative paths outside the document directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "livelatex-graphics-"));
  const documentDirectory = path.join(root, "tex");
  const graphicsDirectory = path.join(root, "images");
  fs.mkdirSync(documentDirectory);
  fs.mkdirSync(graphicsDirectory);
  fs.writeFileSync(path.join(graphicsDirectory, "plot.png"), "");

  try {
    const graphics = await resolveGraphicFiles(
      String.raw`\includegraphics{../images/plot}`,
      documentDirectory
    );

    assert.equal(graphics["../images/plot"], path.join(graphicsDirectory, "plot.png"));

    const graphicsPath = await resolveGraphicFiles(
      String.raw`\graphicspath{{../images/}}\includegraphics{plot}`,
      documentDirectory
    );
    assert.equal(graphicsPath.plot, path.join(graphicsDirectory, "plot.png"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not resolve references or change equation numbering", () => {
  const blocks = parseLatex([
    String.raw`See \ref{eq:first}, \eqref{eq:first}, and $\ref{eq:first}$.`,
    String.raw`\begin{equation}\label{eq:first}a=b\end{equation}`
  ].join("\n\n"));

  assert.ok(blocks[0].html.includes("\\ref{eq:first}"));
  assert.ok(blocks[0].html.includes("\\eqref{eq:first}"));
  assert.doesNotMatch(blocks[0].html, /class="reference"|\?\?/);
  assert.match(blocks[1].html, /\\tag\{1\}/);
  assert.doesNotMatch(blocks[1].html, /\\tag\{2\}/);
});

test("retains supported text features while parsing once", () => {
  const blocks = parseLatex([
    String.raw`\newcommand{\R}{\mathbb{R}}`,
    String.raw`\newtheorem{lemma}{Lemma}`,
    String.raw`\begin{document}`,
    String.raw`The set is $\R$ and \enquote{quoted}. \footnote{A note.}`,
    "",
    String.raw`\begin{lemma}`,
    "A statement.",
    String.raw`\end{lemma}`,
    String.raw`\end{document}`
  ].join("\n"));

  assert.equal(blocks.filter((block) => block.type === "paragraph").length, 1);
  assert.match(blocks[0].html, /&ldquo;quoted&rdquo;/);
  assert.match(blocks[0].html, /class="footnote-ref"/);
  assert.match(blocks.find((block) => block.type === "theorem").html, /Lemma 1/);
  assert.match(blocks.find((block) => block.type === "theorem").html, /theorem-plain/);
  assert.match(blocks.at(-1).html, /A note\./);
});

test("renders book chapter headings and definition-style theorem bodies", () => {
  const blocks = parseLatex([
    String.raw`\documentclass{book}`,
    String.raw`\theoremstyle{definition}`,
    String.raw`\newtheorem{definition}{Definition}`,
    String.raw`\begin{document}`,
    String.raw`\chapter{A chapter}`,
    String.raw`\begin{definition}`,
    "An upright definition.",
    String.raw`\end{definition}`,
    String.raw`\end{document}`
  ].join("\n"));

  assert.match(blocks[0].html, /class="chapter-heading"/);
  assert.match(blocks[0].html, /class="chapter-number">Chapter 1/);
  assert.match(blocks[1].html, /theorem-definition/);
});

test("numbers theorem environments independently unless a shared counter is requested", () => {
  const blocks = parseLatex([
    String.raw`\documentclass{book}`,
    String.raw`\newtheorem{lemma}{Lemma}`,
    String.raw`\begin{document}`,
    String.raw`\chapter{A chapter}`,
    String.raw`\begin{lemma}A lemma.\end{lemma}`,
    String.raw`\end{document}`
  ].join("\n"));

  assert.match(blocks.find((block) => block.type === "theorem").html, /Lemma 1\./);
  assert.doesNotMatch(blocks.find((block) => block.type === "theorem").html, /Lemma 1\.1/);
});

test("does not render TikZ environments", () => {
  const [block] = parseLatex([
    String.raw`\begin{tikzpicture}`,
    String.raw`\draw (0,0) -- (1,1);`,
    String.raw`\end{tikzpicture}`
  ].join("\n"));

  assert.equal(block.type, "paragraph");
  assert.doesNotMatch(block.html, /tikz-picture|<svg/);
  assert.match(block.html, /begin\{tikzpicture\}/);
});

test("preserves numbered figure captions and resolved image resources", () => {
  const [figure] = parseLatex([
    String.raw`\begin{figure}`,
    String.raw`\includegraphics[width=0.5\textwidth]{plot}`,
    String.raw`\caption{A result}\label{fig:result}`,
    String.raw`\end{figure}`
  ].join("\n"), { plot: "webview-resource://plot.png" });

  assert.equal(figure.type, "figure");
  assert.match(figure.html, /<img class="latex-graphic" src="webview-resource:\/\/plot\.png"/);
  assert.match(figure.html, /Figure 1\./);
  assert.match(figure.html, /A result/);
});
