import { parseLatex } from "./latexParser";
import type { PreviewBlock } from "./latexTypes";

declare function acquireVsCodeApi(): {
  postMessage(message: { type: string; line?: number; character?: number; graphics?: Record<string, string> }): void;
};

const vscode = acquireVsCodeApi();
const content = document.getElementById("content");
const stage = document.getElementById("page-stage");
if (!content || !stage) {
  throw new Error("LiveLaTeX preview page container was not found.");
}
const previewRoot: HTMLElement = content;
const pageStage: HTMLElement = stage;

const rendered = new Map<string, { element: HTMLElement; html: string }>();
let sourceLines: string[] = [];
let graphics: Record<string, string> = {};
let previewZoom = 1;

function updatePageScale(): void {
  previewRoot.style.transform = `scale(${previewZoom})`;
  pageStage.style.width = `${previewRoot.offsetWidth * previewZoom}px`;
  pageStage.style.height = `${previewRoot.offsetHeight * previewZoom}px`;
}

window.addEventListener("wheel", (event: WheelEvent) => {
  if (!event.ctrlKey || event.deltaY === 0) {
    return;
  }
  event.preventDefault();

  const nextZoom = Math.max(0.5, Math.min(2.5, previewZoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
  if (nextZoom === previewZoom) {
    return;
  }

  const oldBounds = previewRoot.getBoundingClientRect();
  const localX = (event.clientX - oldBounds.left) / previewZoom;
  const localY = (event.clientY - oldBounds.top) / previewZoom;
  previewZoom = nextZoom;
  updatePageScale();

  requestAnimationFrame(() => {
    const newBounds = previewRoot.getBoundingClientRect();
    window.scrollBy(
      newBounds.left + localX * previewZoom - event.clientX,
      newBounds.top + localY * previewZoom - event.clientY
    );
  });
}, { passive: false });

function fitDisplayMath(): void {
  for (const display of Array.from(previewRoot.querySelectorAll(".katex-display")) as HTMLElement[]) {
    const formula = display.querySelector(".katex") as HTMLElement | null;
    const formulaHtml = formula?.querySelector(".katex-html") as HTMLElement | null;
    if (!formula || !formulaHtml) {
      continue;
    }
    formulaHtml.style.fontSize = "";
    const tag = formulaHtml.querySelector(".katex-tag") as HTMLElement | null;
    if (tag) {
      tag.style.fontSize = "";
    }
    const contentRects = Array.from(formulaHtml.children)
      .filter((child) => !child.classList.contains("katex-tag"))
      .map((child) => child.getBoundingClientRect())
      .filter((rect) => rect.width > 0);
    if (contentRects.length === 0) {
      continue;
    }
    const contentLeft = Math.min(...contentRects.map((rect) => rect.left));
    const contentRight = Math.max(...contentRects.map((rect) => rect.right));
    const width = contentRight - contentLeft;
    const tagWidth = tag?.getBoundingClientRect().width ?? 0;
    const tagGap = tagWidth > 0 ? 64 : 24;
    const available = display.clientWidth;
    const formulaAvailable = available - tagWidth - tagGap;
    if (formulaAvailable > 0 && width > formulaAvailable) {
      const scale = formulaAvailable / width;
      formulaHtml.style.fontSize = `${scale}em`;
      if (tag) {
        tag.style.fontSize = `${1 / scale}em`;
      }
    }
  }
}

function updatePreview(source: string): void {
  sourceLines = source.split(/\r?\n/);
  const scrollY = window.scrollY;
  const blocks: PreviewBlock[] = parseLatex(source, graphics);
  const nextKeys = new Set(blocks.map((block) => block.key));
  const orderedElements: HTMLElement[] = [];

  for (const block of blocks) {
    let entry = rendered.get(block.key);
    if (!entry) {
      const element = document.createElement("section");
      element.className = "block";
      element.title = "Ctrl+click to jump to this location in the editor";
      entry = { element, html: "" };
      rendered.set(block.key, entry);
    }
    entry.element.dataset.sourceLine = String(block.sourceLine);
    entry.element.dataset.sourceType = block.type;
    if (entry.html !== block.html) {
      entry.element.innerHTML = block.html;
      entry.html = block.html;
    }
    orderedElements.push(entry.element);
  }

  for (const [key, entry] of rendered) {
    if (!nextKeys.has(key)) {
      entry.element.remove();
      rendered.delete(key);
    }
  }

  for (let index = 0; index < orderedElements.length; index += 1) {
    const element = orderedElements[index];
    const current = previewRoot.children.item(index);
    if (current !== element) {
      previewRoot.insertBefore(element, current);
    }
  }
  updatePageScale();
  fitDisplayMath();
  void document.fonts.ready.then(fitDisplayMath);
  window.scrollTo(window.scrollX, scrollY);
}

window.addEventListener("resize", fitDisplayMath);

previewRoot.addEventListener("click", (event: MouseEvent) => {
  if (!event.ctrlKey || event.button !== 0) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const block = target.closest<HTMLElement>(".source-anchor, .block");
  const line = Number(block?.dataset.sourceLine);
  if (Number.isInteger(line) && line >= 0) {
    const type = block?.dataset.sourceType ?? "";
    const lineLength = sourceLines[line]?.length ?? 0;
    const bounds = block?.getBoundingClientRect();
    const character = type === "displayMath" || !bounds || bounds.width === 0
      ? 0
      : Math.round(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * lineLength);
    vscode.postMessage({ type: "revealLine", line, character });
  }
});

window.addEventListener("message", (event: MessageEvent<{ type: string; text?: string; graphics?: Record<string, string> }>) => {
  if (event.data.type === "update" && typeof event.data.text === "string") {
    graphics = event.data.graphics ?? {};
    updatePreview(event.data.text);
  }
});

vscode.postMessage({ type: "ready" });
