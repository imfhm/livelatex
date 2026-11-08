import { spawn } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveGraphicFiles } from "./graphicPaths";

interface PreviewState {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  localResourceRoots: vscode.Uri[];
  graphicWatchers: Map<string, vscode.FileSystemWatcher>;
  graphicVersions: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | undefined;
  updateSequence: number;
}

const previews = new Map<string, PreviewState>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("livelatex.openPreview", () => openPreview(context)),
    vscode.commands.registerCommand("livelatex.compileWithTectonic", compileWithTectonic),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const preview = previews.get(event.document.uri.toString());
      if (preview) {
        scheduleUpdate(preview);
      }
    })
  );
}

function openPreview(context: vscode.ExtensionContext): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("Open a LaTeX document to preview it.");
    return;
  }

  const document = editor.document;
  if (document.languageId !== "latex") {
    void vscode.window.showInformationMessage("Open a LaTeX document to preview it.");
    return;
  }
  const key = document.uri.toString();
  const existing = previews.get(key);
  if (existing) {
    existing.panel.reveal(vscode.ViewColumn.Beside);
    sendUpdate(existing);
    return;
  }

  const localResourceRoots = [
    vscode.Uri.joinPath(context.extensionUri, "dist"),
    ...(document.uri.scheme === "file" ? [vscode.Uri.file(path.dirname(document.uri.fsPath))] : [])
  ];
  const panel = vscode.window.createWebviewPanel(
    "livelatex.preview",
    `LiveLaTeX: ${path.basename(document.fileName) || "Untitled"}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots
    }
  );
  const state: PreviewState = {
    panel,
    document,
    localResourceRoots,
    graphicWatchers: new Map(),
    graphicVersions: new Map(),
    timer: undefined,
    updateSequence: 0
  };
  previews.set(key, state);
  panel.webview.html = getWebviewHtml(context, panel.webview);
  panel.webview.onDidReceiveMessage((message: { type: string; line?: number; character?: number }) => {
    if (message.type === "ready") {
      sendUpdate(state);
    } else if (message.type === "revealLine" && Number.isInteger(message.line)) {
      void revealLine(state, message.line, message.character);
    }
  }, undefined, context.subscriptions);
  panel.onDidDispose(() => {
    if (state.timer) {
      clearTimeout(state.timer);
    }
    disposeGraphicWatchers(state);
    previews.delete(key);
  }, undefined, context.subscriptions);
}

async function revealLine(state: PreviewState, line: number | undefined, character: number | undefined): Promise<void> {
  if (line === undefined || line < 0 || line >= state.document.lineCount) {
    return;
  }
  const existingEditor = vscode.window.visibleTextEditors.find(
    (visibleEditor) => visibleEditor.document.uri.toString() === state.document.uri.toString()
  );
  const editor = await vscode.window.showTextDocument(
    state.document,
    existingEditor?.viewColumn ?? vscode.ViewColumn.One,
    false
  );
  const position = new vscode.Position(line, Math.max(0, Math.min(character ?? 0, state.document.lineAt(line).text.length)));
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function scheduleUpdate(state: PreviewState): void {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  const delay = vscode.workspace.getConfiguration("livelatex.preview").get<number>("debounceMs", 150);
  state.timer = setTimeout(() => sendUpdate(state), delay);
}

async function sendUpdate(state: PreviewState): Promise<void> {
  state.timer = undefined;
  const sequence = ++state.updateSequence;
  const text = state.document.getText();
  let resolvedGraphics: {
    graphics: Record<string, string>;
    graphicFiles: Record<string, string>;
    localResourceRoots: vscode.Uri[];
  };
  try {
    resolvedGraphics = await resolveGraphics(
      text,
      state.document,
      state.panel.webview,
      state.localResourceRoots,
      state.graphicVersions
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not load LaTeX graphics: ${String(error)}`);
    return;
  }
  if (sequence !== state.updateSequence || state.panel.visible === false) {
    return;
  }
  updateGraphicWatchers(state, resolvedGraphics.graphicFiles);
  state.panel.webview.options = {
    ...state.panel.webview.options,
    localResourceRoots: resolvedGraphics.localResourceRoots
  };
  await state.panel.webview.postMessage({
    type: "update",
    text,
    graphics: resolvedGraphics.graphics
  });
}

async function resolveGraphics(
  text: string,
  document: vscode.TextDocument,
  webview: vscode.Webview,
  localResourceRoots: vscode.Uri[],
  graphicVersions: Map<string, number>
): Promise<{
  graphics: Record<string, string>;
  graphicFiles: Record<string, string>;
  localResourceRoots: vscode.Uri[];
}> {
  if (document.uri.scheme !== "file") {
    return { graphics: {}, graphicFiles: {}, localResourceRoots };
  }

  const baseDirectory = path.dirname(document.uri.fsPath);
  const graphicFiles = await resolveGraphicFiles(text, baseDirectory);
  const resourceRoots = new Map(
    localResourceRoots.map((uri) => [uri.toString(), uri])
  );
  for (const filename of Object.values(graphicFiles)) {
    const directory = vscode.Uri.file(path.dirname(filename));
    resourceRoots.set(directory.toString(), directory);
  }
  const resources: Record<string, string> = {};
  for (const [filename, filePath] of Object.entries(graphicFiles)) {
    const fileUri = vscode.Uri.file(filePath);
    const webviewUri = webview.asWebviewUri(fileUri);
    const version = graphicVersions.get(fileUri.toString());
    resources[filename] = (version === undefined ? webviewUri : webviewUri.with({ query: `v=${version}` })).toString();
  }
  return {
    graphics: resources,
    graphicFiles,
    localResourceRoots: [...resourceRoots.values()]
  };
}

function updateGraphicWatchers(state: PreviewState, graphicFiles: Record<string, string>): void {
  const files = new Map(
    Object.values(graphicFiles).map((filePath) => [vscode.Uri.file(filePath).toString(), filePath])
  );
  for (const [key, watcher] of state.graphicWatchers) {
    if (!files.has(key)) {
      watcher.dispose();
      state.graphicWatchers.delete(key);
      state.graphicVersions.delete(key);
    }
  }
  for (const [key, filePath] of files) {
    if (state.graphicWatchers.has(key)) {
      continue;
    }
    const pattern = new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath));
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onFileChange = () => {
      state.graphicVersions.set(key, (state.graphicVersions.get(key) ?? 0) + 1);
      scheduleUpdate(state);
    };
    watcher.onDidChange(onFileChange);
    watcher.onDidCreate(onFileChange);
    watcher.onDidDelete(onFileChange);
    state.graphicWatchers.set(key, watcher);
  }
}

function disposeGraphicWatchers(state: PreviewState): void {
  for (const watcher of state.graphicWatchers.values()) {
    watcher.dispose();
  }
  state.graphicWatchers.clear();
  state.graphicVersions.clear();
}

function getWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "webview.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "katex.min.css"));
  const pdfWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "pdf.worker.min.mjs"));
  const pdfAssetsUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "pdfjs"));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; connect-src ${webview.cspSource}; worker-src ${webview.cspSource} blob:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <style>
    body { background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 1rem; margin: 0; }
    #page-stage { width: 210mm; margin: 0 auto; }
    #content { --page-margin-left: 20mm; --page-margin-right: 20mm; --page-margin-top: 20mm; --page-margin-bottom: 20mm; --page-font-size: 10pt; display: flex; flex-direction: column; gap: 6mm; box-sizing: border-box; width: 210mm; margin: 0; color: #000; font-family: "KaTeX_Main", "Latin Modern Roman", "CMU Serif", "Times New Roman", serif; font-size: var(--page-font-size); line-height: 1.2; transform-origin: top left; }
    .paper-page { position: relative; box-sizing: border-box; flex: 0 0 297mm; width: 210mm; height: 297mm; overflow: hidden; color: #000; background: #fff; border: 1px solid #d5d5d5; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35); }
    .page-content { position: absolute; display: flow-root; box-sizing: border-box; left: var(--page-margin-left); right: var(--page-margin-right); top: var(--page-margin-top); height: calc(297mm - var(--page-margin-top) - var(--page-margin-bottom) - 2px); }
    .paper-header { position: absolute; top: 8mm; left: var(--page-margin-left); right: var(--page-margin-right); display: flex; justify-content: space-between; gap: 1em; font-size: 9pt; font-style: italic; line-height: 1; text-transform: uppercase; white-space: nowrap; }
    .paper-header-title { flex: 1; overflow: hidden; text-align: center; text-overflow: clip; }
    .paper-footer { position: absolute; bottom: 8mm; left: 0; right: 0; text-align: center; font-size: 10pt; line-height: 1; }
    h1, h2, h3 { font-weight: bold; line-height: 1.2; }
    h1 { font-size: 12pt; margin: 18pt 0 6pt; }
    h2 { font-size: 12pt; font-style: italic; margin: 16pt 0 6pt; }
    h3 { font-size: 10pt; font-style: italic; margin: 14pt 0 6pt; }
    p { margin: 0; text-indent: 15pt; }
    ul, ol { margin: 0; padding-left: 2.5em; }
    .katex-display { overflow: visible; padding: 0; margin: 0.8em 0; }
    .chapter-heading { display: flow-root; margin: 20mm 0 15mm; }
    .chapter-number { margin-bottom: 8mm; font-size: 18pt; line-height: 1.2; }
    .chapter-heading h1 { font-size: 25pt; line-height: 1.2; margin: 0; }
    .block:has(.chapter-heading) + .block p, .block:has(h1) + .block p, .block:has(h2) + .block p, .block:has(h3) + .block p, p.no-indent { text-indent: 0; }
    .katex .eqn-num::before, .katex .mml-eqn-num::before { content: none; counter-increment: none; }
    .math-error { white-space: pre-wrap; color: var(--vscode-errorForeground); }
    .theorem-body { font-style: italic; margin: 1em 0; }
    .theorem-body.theorem-definition, .theorem-body.theorem-remark { font-style: normal; }
    .theorem-body.theorem-remark > strong { font-style: italic; }
    .theorem-fragment > .theorem-body, .theorem-fragment > .proof-body { margin: 0; }
    .theorem-fragment.first-fragment > .theorem-body, .theorem-fragment.first-fragment > .proof-body { margin-top: 1em; }
    .theorem-fragment.last-fragment > .theorem-body, .theorem-fragment.last-fragment > .proof-body { margin-bottom: 1em; }
    .theorem-body > strong { font-style: normal; }
    .theorem-body > .theorem-intro { display: inline; }
    .proof-body { margin: 1em 0; }
    .qed { float: right; width: 0.65em; height: 0.65em; border: 1px solid currentColor; margin: 0.45em 0 0 0.5em; }
    .document-title-block { text-align: center; margin: 2em 0 3em; }
    .document-title { font-size: 2em; margin: 0 0 0.75em; }
    .document-author, .document-date { margin: 0.35em 0; }
    .footnote-ref { font-size: 0.75em; vertical-align: super; line-height: 0; }
    .footnotes { font-size: 0.85em; margin-top: 2em; }
    .footnotes li { padding-left: 0.2em; }
    .footnote-backlink { margin-left: 0.5em; text-decoration: none; }
    .latex-graphic { display: block; max-width: 100%; height: auto; margin: 1em auto; }
    .latex-svg-graphic { max-width: 100%; }
    .latex-pdf-graphic { display: block; max-width: 100%; max-height: 65vh; height: auto; margin: 1em auto; }
    .pdf-render-error { display: block; padding: 0.5em; border: 1px dashed var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
    .latex-figure { margin: 1.5em 0; text-align: center; }
    .latex-figure figcaption { margin-top: 0.6em; text-align: center; }
    .graphic-error { color: var(--vscode-errorForeground); }
    #content.beamer-layout { width: 127mm; font-family: Arial, Helvetica, sans-serif; font-size: 10pt; line-height: 1.25; color: #23383c; }
    .beamer-page { flex-basis: 95.25mm; width: 127mm; height: 95.25mm; }
    .beamer-page > .block { position: absolute; inset: 0; width: 100%; height: 100%; }
    .beamer-slide { position: relative; box-sizing: border-box; width: 100%; height: 100%; overflow: hidden; background: #fff; }
    .beamer-slide-title { box-sizing: border-box; min-height: 10mm; margin: 0; padding: 2.5mm 3mm; overflow: hidden; background: #203438; color: #fff; font-size: 13pt; line-height: 1.3; white-space: nowrap; }
    .beamer-slide-body { box-sizing: border-box; height: calc(100% - 10mm); overflow: hidden; padding: 5mm 9mm 7mm; container-type: size; }
    .beamer-slide-body p { margin: 0.35em 0; text-indent: 0; }
    .beamer-slide-body ul, .beamer-slide-body ol { padding-left: 1.8em; }
    .beamer-slide-body li { padding: 0.1em 0; }
    .beamer-slide-body .katex-display { margin: 0.65em 0; }
    .beamer-slide-body .theorem-body { margin: 0.6em -1.5mm; padding: 1.2mm 1.5mm 2mm; background: #c1c8c9; font-style: normal; }
    .beamer-slide-body .theorem-body > strong { display: block; margin: -1.2mm -1.5mm 1mm; padding: 1mm 1.5mm; background: #203438; color: #fff; font-size: 10pt; }
    .beamer-slide-body .theorem-intro { display: block; }
    .beamer-slide-body .latex-graphic { max-height: 45mm; margin: 0.5em auto; object-fit: contain; }
    .beamer-slide-body .latex-pdf-graphic { max-height: 45mm; margin: 0.5em auto; }
    .beamer-slide-body .graphic-error { display: block; box-sizing: border-box; max-width: 100%; max-height: 45mm; min-height: 0; margin: 1mm auto; padding: 1mm; overflow: hidden; border: 0.25mm dashed #8b999b; color: #647477; font-size: 7pt; text-align: center; }
    .beamer-page-number { position: absolute; z-index: 1; right: 2.5mm; bottom: 1.5mm; color: #30464a; font-size: 7pt; line-height: 1; }
    .beamer-title-page { padding: 30mm 10mm 8mm; color: #263a3e; }
    .beamer-title-page h1 { margin: 0 0 4mm; padding-bottom: 4mm; border-bottom: 0.35mm solid #e87524; font-size: 16pt; line-height: 1.25; }
    .beamer-title-author { margin: 0 0 2mm; font-size: 11pt; }
    .beamer-title-institute { color: #526469; font-size: 8pt; line-height: 1.35; }
    .beamer-title-date { margin-top: 3mm; font-size: 10pt; }
    .beamer-title-logo { position: absolute; right: 1mm; bottom: 5mm; }
    .beamer-title-logo .latex-graphic { width: 20mm; margin: 0; }
    .beamer-footnote { position: absolute; right: 9mm; bottom: 2.5mm; left: 9mm; padding-top: 1mm; border-top: 0.2mm solid #bfc9ca; font-size: 6pt; line-height: 1.15; }
  </style>
</head>
<body>
  <div id="page-stage"><main id="content" data-pdf-worker="${pdfWorkerUri}" data-pdf-assets="${pdfAssetsUri}" aria-live="polite"></main></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

async function compileWithTectonic(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "latex") {
    void vscode.window.showInformationMessage("Open a LaTeX document to compile with Tectonic.");
    return;
  }
  if (editor.document.isUntitled) {
    void vscode.window.showWarningMessage("Save the LaTeX document before compiling with Tectonic.");
    return;
  }
  if (editor.document.isDirty && !(await editor.document.save())) {
    return;
  }

  const executable = vscode.workspace.getConfiguration("livelatex.tectonic").get<string>("path", "tectonic");
  const sourcePath = editor.document.uri.fsPath;
  const pdfPath = path.join(path.dirname(sourcePath), `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`);
  let result: { code: number | null; stdout: string; stderr: string };
  try {
    result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Compiling LaTeX with Tectonic",
        cancellable: false
      },
      () => runTectonic(executable, sourcePath)
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not start Tectonic: ${String(error)}`);
    return;
  }

  if (result.code !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || `Tectonic exited with code ${result.code}.`;
    void vscode.window.showErrorMessage(`Tectonic compilation failed: ${details}`);
    return;
  }

  try {
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(pdfPath));
  } catch (error) {
    void vscode.window.showErrorMessage(`Tectonic created a PDF, but it could not be opened: ${String(error)}`);
  }
}

function runTectonic(executable: string, sourcePath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const process = spawn(executable, [sourcePath], {
      cwd: path.dirname(sourcePath),
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    process.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    process.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    process.once("error", reject);
    process.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function deactivate(): void {
  for (const preview of previews.values()) {
    if (preview.timer) {
      clearTimeout(preview.timer);
    }
    disposeGraphicWatchers(preview);
  }
  previews.clear();
}
