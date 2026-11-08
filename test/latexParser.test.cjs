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
  fs.writeFileSync(path.join(graphicsDirectory, "plot.pdf"), "");
  fs.writeFileSync(path.join(graphicsDirectory, "raster.png"), "");
  fs.writeFileSync(path.join(graphicsDirectory, "diagram.svg"), "");

  try {
    const graphics = await resolveGraphicFiles(
      String.raw`\includegraphics{../images/plot}`,
      documentDirectory
    );

    assert.equal(graphics["../images/plot"], path.join(graphicsDirectory, "plot.pdf"));

    const rasterGraphics = await resolveGraphicFiles(
      String.raw`\includegraphics{../images/raster}`,
      documentDirectory
    );
    assert.equal(rasterGraphics["../images/raster"], path.join(graphicsDirectory, "raster.png"));

    const graphicsPath = await resolveGraphicFiles(
      String.raw`\graphicspath{{../images/}}\includegraphics{plot}`,
      documentDirectory
    );
    assert.equal(graphicsPath.plot, path.join(graphicsDirectory, "plot.pdf"));

    const svgGraphics = await resolveGraphicFiles(
      String.raw`\includesvg[width=\textwidth]{../images/diagram.svg}`,
      documentDirectory
    );
    assert.equal(svgGraphics["../images/diagram.svg"], path.join(graphicsDirectory, "diagram.svg"));

    const extensionlessSvg = await resolveGraphicFiles(
      String.raw`\includesvg{../images/diagram}`,
      documentDirectory
    );
    assert.equal(extensionlessSvg["../images/diagram"], path.join(graphicsDirectory, "diagram.svg"));

    const pdfGraphics = await resolveGraphicFiles(
      String.raw`\includegraphics[page=2]{../images/plot.pdf}`,
      documentDirectory
    );
    assert.equal(pdfGraphics["../images/plot.pdf"], path.join(graphicsDirectory, "plot.pdf"));

    const extensionlessPdf = await resolveGraphicFiles(
      String.raw`\includegraphics{../images/plot}`,
      documentDirectory
    );
    assert.equal(extensionlessPdf["../images/plot"], path.join(graphicsDirectory, "plot.pdf"));
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

test("renders SVG and PDF graphics in regular LaTeX documents", () => {
  const [svg, pdf] = parseLatex([
    String.raw`\includegraphics[width=0.5\textwidth]{diagram.svg}`,
    String.raw`\includegraphics[page=2,width=0.75\textwidth]{figures.pdf}`
  ].join("\n\n"), {
    "diagram.svg": "webview-resource://diagram.svg",
    "figures.pdf": "webview-resource://figures.pdf"
  });

  assert.match(svg.html, /<img class="latex-graphic latex-svg-graphic" src="webview-resource:\/\/diagram\.svg"/);
  assert.match(svg.html, /width:50%/);
  assert.match(pdf.html, /<canvas class="latex-pdf-graphic" data-pdf-src="webview-resource:\/\/figures\.pdf" data-pdf-page="2"/);
  assert.match(pdf.html, /width:75%/);
});

test("renders Beamer frames as slides and expands numbered overlays", () => {
  const slides = parseLatex([
    String.raw`\documentclass{beamer}`,
    String.raw`\title{A presentation}`,
    String.raw`\author{A presenter}`,
    String.raw`\institute{An institute}`,
    String.raw`\begin{document}`,
    String.raw`\frame{\titlepage}`,
    String.raw`\begin{frame}{Problem statement}`,
    String.raw`\onslide<1->{First overlay.}`,
    String.raw`\onslide<2->{Second overlay.}`,
    String.raw`\end{frame}`,
    String.raw`\end{document}`
  ].join("\n"));

  assert.equal(slides.length, 3);
  assert.match(slides[0].html, /beamer-title-page/);
  assert.match(slides[0].html, /A presentation/);
  assert.match(slides[1].html, /Problem statement/);
  assert.match(slides[1].html, /First overlay/);
  assert.doesNotMatch(slides[1].html, /Second overlay/);
  assert.match(slides[2].html, /Second overlay/);
  assert.doesNotMatch(slides.map((slide) => slide.html).join(""), /\\begin\{frame\}|\\end\{frame\}/);
});

test("shows Beamer list items only on their declared overlay", () => {
  const slides = parseLatex([
    String.raw`\documentclass{beamer}`,
    String.raw`\begin{document}`,
    String.raw`\begin{frame}`,
    String.raw`\frametitle{Incremental list}`,
    String.raw`\begin{itemize}`,
    String.raw`\item<1-> First`,
    String.raw`\item<2-> Second`,
    String.raw`\end{itemize}`,
    String.raw`\end{frame}`,
    String.raw`\end{document}`
  ].join("\n"));

  assert.equal(slides.length, 2);
  assert.match(slides[0].html, /Incremental list/);
  assert.match(slides[0].html, /First/);
  assert.doesNotMatch(slides[0].html, /Second/);
  assert.match(slides[1].html, /First/);
  assert.match(slides[1].html, /Second/);
});

test("renders display equations and footnote citations inside Beamer frames", () => {
  const [slide] = parseLatex([
    String.raw`\documentclass{beamer}`,
    String.raw`\newtheorem{theorem}{Theorem}`,
    String.raw`\begin{document}`,
    String.raw`\begin{frame}{Equations and citation}`,
    String.raw`\begin{theorem}`,
    String.raw`A result`,
    String.raw`\[a=b\]`,
    String.raw`\begin{align*}x&=1\\y&=2\end{align*}`,
    String.raw`\end{theorem}`,
    String.raw`\blfootnote{An author citation (2026).}`,
    String.raw`\end{frame}`,
    String.raw`\end{document}`
  ].join("\n"));

  assert.equal((slide.html.match(/katex-display/g) ?? []).length, 2);
  assert.match(slide.html, /class="beamer-footnote">An author citation \(2026\)\./);
  assert.match(slide.html, /katex-mathml/);
});

test("keeps the provided Beamer example's equations, footnotes, and images in its slides", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "example", "main_beamer.tex"), "utf8");
  const slides = parseLatex(source);

  assert.equal(slides.length, 30);
  assert.match(slides[2].html, /katex-display/);
  assert.match(slides[16].html, /katex-display/);
  assert.doesNotMatch(slides[16].html, /katex-error|math-error/);
  assert.match(slides[20].html, /beamer-footnote/);
  assert.match(slides[20].html, /Celledoni/);
  assert.match(slides[20].html, /graphic-error/);
});

test("renders display equations inside Beamer list items", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "example", "main_beamer.tex"), "utf8");
  const slides = parseLatex(source);

  assert.equal((slides[3].html.match(/katex-display/g) ?? []).length, 1);
  assert.doesNotMatch(slides[3].html, /&lt;|\\\\\[|\\\\\]/);
  assert.match(slides[26].html, /katex-display/);
  assert.doesNotMatch(slides[26].html, /class="katex-error"/);
});

test("sizes Beamer graphics and placeholders from text dimensions", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "example", "main_beamer.tex"), "utf8");
  const [slide] = parseLatex(source).slice(27, 28);
  const placeholders = [...slide.html.matchAll(/<span class="graphic-error" style="([^"]*)">/g)];

  assert.equal(placeholders.length, 2);
  assert.match(placeholders[0][1], /height:30cqh/);
  assert.match(placeholders[1][1], /height:40cqh/);

  const [regularSlide] = parseLatex(
    String.raw`\includegraphics[height=.3\textheight]{plot}`,
    { plot: "webview-resource://plot.svg" }
  );
  assert.match(regularSlide.html, /height:30%/);

  const [fullWidthSlide] = parseLatex([
    String.raw`\documentclass{beamer}`,
    String.raw`\begin{document}`,
    String.raw`\begin{frame}{Full width image}`,
    String.raw`\includegraphics[width=\textwidth]{plot}`,
    String.raw`\end{frame}`,
    String.raw`\end{document}`
  ].join("\n"), { plot: "webview-resource://plot.svg" });
  assert.match(fullWidthSlide.html, /style="width:100%"/);
});
