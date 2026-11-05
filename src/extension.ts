import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";

interface PreviewState {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
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

  const panel = vscode.window.createWebviewPanel(
    "livelatex.preview",
    `LiveLaTeX: ${path.basename(document.fileName) || "Untitled"}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "dist"),
        ...(document.uri.scheme === "file" ? [vscode.Uri.file(path.dirname(document.uri.fsPath))] : [])
      ]
    }
  );
  const state: PreviewState = { panel, document, timer: undefined, updateSequence: 0 };
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
  let graphics: Record<string, string>;
  try {
    graphics = await resolveGraphics(text, state.document, state.panel.webview);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not load LaTeX graphics: ${String(error)}`);
    return;
  }
  if (sequence !== state.updateSequence || state.panel.visible === false) {
    return;
  }
  await state.panel.webview.postMessage({
    type: "update",
    text,
    graphics
  });
}

async function resolveGraphics(
  text: string,
  document: vscode.TextDocument,
  webview: vscode.Webview
): Promise<Record<string, string>> {
  if (document.uri.scheme !== "file") {
    return {};
  }

  const baseDirectory = path.dirname(document.uri.fsPath);
  const searchDirectories = [""];
  for (const graphicspath of text.matchAll(/\\graphicspath\s*\{((?:\s*\{[^{}]*\}\s*)+)\}/g)) {
    for (const directory of graphicspath[1].matchAll(/\{([^{}]*)\}/g)) {
      searchDirectories.push(directory[1].trim());
    }
  }

  const supportedExtensions = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp"];
  const resources: Record<string, string> = {};
  const includePattern = /\\includegraphics\*?(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g;
  for (const include of text.matchAll(includePattern)) {
    const filename = include[1].trim();
    const requestedExtension = path.extname(filename);
    for (const directory of searchDirectories) {
      const basePath = path.resolve(baseDirectory, directory, filename);
      const relativePath = path.relative(baseDirectory, basePath);
      if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        continue;
      }
      const candidates = requestedExtension
        ? supportedExtensions.includes(requestedExtension.toLowerCase()) ? [basePath] : []
        : supportedExtensions.map((extension) => `${basePath}${extension}`);
      let found: string | undefined;
      for (const candidate of candidates) {
        try {
          await fs.access(candidate);
          found = candidate;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
            throw error;
          }
        }
      }
      if (found) {
        resources[normalizeGraphicPath(filename)] = webview.asWebviewUri(vscode.Uri.file(found)).toString();
        break;
      }
    }
  }
  return resources;
}

function normalizeGraphicPath(filename: string): string {
  return filename.replace(/\\/g, "/").replace(/^\.\//, "").trim().toLowerCase();
}

function getWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "webview.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "katex.min.css"));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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
    .latex-figure { margin: 1.5em 0; text-align: center; }
    .latex-figure figcaption { margin-top: 0.6em; text-align: center; }
    .graphic-error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div id="page-stage"><main id="content" aria-live="polite"></main></div>
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
  }
  previews.clear();
}
