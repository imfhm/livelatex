import { parseLatex } from "./latexParser";
import { findClosingBrace } from "./latexUtils";
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
let orderedElements: HTMLElement[] = [];
let sourceLines: string[] = [];
let graphics: Record<string, string> = {};
let previewZoom = 1;
let bookLayout = false;

function updatePageScale(): void {
  previewRoot.style.transform = `scale(${previewZoom})`;
  pageStage.style.width = `${previewRoot.offsetWidth * previewZoom}px`;
  pageStage.style.height = `${previewRoot.offsetHeight * previewZoom}px`;
}

function dimensionInMillimeters(value: string): number | undefined {
  const match = value.trim().match(/^(-?\d*\.?\d+)\s*(mm|cm|in|pt|bp)$/i);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const factor: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, bp: 25.4 / 72 };
  return amount * factor[match[2].toLowerCase()];
}

function updateDocumentLayout(source: string): void {
  const documentClass = source.match(/\\documentclass(?:\[([^\]]*)\])?\s*\{([^}]+)\}/);
  bookLayout = /^(book|report)$/.test(documentClass?.[2] ?? "");
  previewRoot.classList.toggle("book-layout", bookLayout);
  const fontSize = documentClass?.[1]?.match(/(?:^|,)\s*(10|11|12)pt(?:\s*,|$)/)?.[1] ?? "10";
  previewRoot.style.setProperty("--page-font-size", `${fontSize}pt`);

  let left = 25;
  let right = 25;
  let top = 25;
  let bottom = 25;
  const geometryCommand = /\\geometry(?:\s*\[[^\]]*\])?\s*\{/.exec(source);
  if (geometryCommand) {
    const openingBrace = source.indexOf("{", geometryCommand.index);
    const closingBrace = findClosingBrace(source, openingBrace + 1);
    if (closingBrace !== -1) {
      const options = source.slice(openingBrace + 1, closingBrace);
      const option = (name: string) => options.match(new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*([^,\\r\\n]+)`))?.[1]?.trim();
      const margin = option("margin");
      const leftOption = option("left") ?? margin;
      const rightOption = option("right") ?? margin;
      const topOption = option("top") ?? margin;
      const bottomOption = option("bottom") ?? margin;
      left = dimensionInMillimeters(leftOption ?? "") ?? left;
      right = dimensionInMillimeters(rightOption ?? "") ?? right;
      top = dimensionInMillimeters(topOption ?? "") ?? top;
      bottom = dimensionInMillimeters(bottomOption ?? "") ?? bottom;

      const total = options.match(/\btotal\s*=\s*\{\s*([^,}]+)\s*,\s*([^}]+)\s*\}/);
      const width = dimensionInMillimeters(option("width") ?? total?.[1] ?? "");
      const height = dimensionInMillimeters(option("height") ?? total?.[2] ?? "");
      if (width !== undefined && option("right") === undefined && margin === undefined) {
        right = 210 - left - width;
      }
      if (height !== undefined && option("bottom") === undefined && margin === undefined) {
        bottom = 297 - top - height;
      }
    }
  }

  previewRoot.style.setProperty("--page-margin-left", `${left}mm`);
  previewRoot.style.setProperty("--page-margin-right", `${right}mm`);
  previewRoot.style.setProperty("--page-margin-top", `${top}mm`);
  previewRoot.style.setProperty("--page-margin-bottom", `${bottom}mm`);
}

function getRunningTitle(block: HTMLElement): string | undefined {
  const chapter = block.querySelector<HTMLElement>(".chapter-heading");
  if (chapter) {
    const number = chapter.querySelector(".chapter-number")?.textContent?.trim() ?? "";
    const title = chapter.querySelector("h1")?.textContent?.trim() ?? "";
    return `${number}. ${title}`.toLocaleUpperCase();
  }

  const heading = block.querySelector<HTMLElement>("h1, h2, h3");
  if (!heading) {
    return undefined;
  }
  const text = heading.textContent?.trim() ?? "";
  const numbered = text.match(/^(\d+(?:\.\d+)*)\s+(.+)$/);
  return numbered ? `${numbered[1]}. ${numbered[2]}`.toLocaleUpperCase() : text.toLocaleUpperCase();
}

function theoremPaginationUnits(block: HTMLElement): HTMLElement[] {
  const body = block.firstElementChild as HTMLElement | null;
  if (!body || !body.matches(".theorem-body, .proof-body")) {
    return [block];
  }

  const groups: Node[][] = [[]];
  let foundAnchor = false;
  for (const node of Array.from(body.childNodes)) {
    if (node instanceof HTMLElement && node.classList.contains("source-anchor") && foundAnchor) {
      groups.push([]);
    }
    groups[groups.length - 1].push(node.cloneNode(true));
    if (node instanceof HTMLElement && node.classList.contains("source-anchor")) {
      foundAnchor = true;
    }
  }
  if (groups.length < 2) {
    return [block];
  }

  return groups.map((group) => {
    const fragment = document.createElement("section");
    fragment.className = `block theorem-fragment${groups[0] === group ? " first-fragment" : ""}${groups[groups.length - 1] === group ? " last-fragment" : ""}`;
    fragment.dataset.sourceLine = block.dataset.sourceLine ?? "";
    fragment.dataset.sourceType = block.dataset.sourceType ?? "";
    fragment.title = block.title;
    const fragmentBody = document.createElement("div");
    fragmentBody.className = body.className;
    fragment.append(fragmentBody);
    fragmentBody.append(...group);
    return fragment;
  });
}

function paginateBlocks(blocks: HTMLElement[]): void {
  previewRoot.replaceChildren();

  let pageNumber = 0;
  let chapterTitle = "";
  let sectionTitle = "";
  const createPage = (chapterOpening = false): HTMLElement => {
    pageNumber += 1;
    const page = document.createElement("section");
    page.className = "paper-page";
    const pageContent = document.createElement("div");
    pageContent.className = "page-content";
    if (bookLayout && !chapterOpening) {
      const header = document.createElement("header");
      header.className = "paper-header";
      const number = document.createElement("span");
      number.className = "paper-header-number";
      number.textContent = String(pageNumber);
      const title = document.createElement("span");
      title.className = "paper-header-title";
      title.textContent = pageNumber % 2 === 0
        ? chapterTitle || sectionTitle
        : sectionTitle || chapterTitle;
      if (pageNumber % 2 === 0) {
        header.append(number, title);
      } else {
        header.append(title, number);
      }
      page.append(header);
    } else {
      const footer = document.createElement("footer");
      footer.className = "paper-footer";
      footer.textContent = String(pageNumber);
      page.append(footer);
    }
    page.append(pageContent);
    previewRoot.append(page);
    return pageContent;
  };

  let pageContent = createPage(true);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const chapter = Boolean(block.querySelector(".chapter-heading"));
    const nextTitle = getRunningTitle(block);
    if (chapter) {
      chapterTitle = nextTitle ?? chapterTitle;
      sectionTitle = "";
      if (pageContent.childElementCount > 0) {
        pageContent = createPage(true);
      }
    } else if (nextTitle) {
      sectionTitle = nextTitle;
    }

    let groups = theoremPaginationUnits(block).map((unit) => [unit]);
    if (/^heading[1-3]$/.test(block.dataset.sourceType ?? "") && blocks[index + 1] && !chapter) {
      const next = blocks[++index];
      const nextUnits = theoremPaginationUnits(next);
      groups = [[block, nextUnits[0]], ...nextUnits.slice(1).map((unit) => [unit])];
    } else if (chapter && blocks[index + 1]) {
      const next = blocks[++index];
      const nextUnits = theoremPaginationUnits(next);
      groups = [[block, nextUnits[0]], ...nextUnits.slice(1).map((unit) => [unit])];
    }

    for (const group of groups) {
      const previousBlockCount = pageContent.childElementCount;
      pageContent.append(...group);
      const exceedsPage = pageContent.scrollHeight > pageContent.clientHeight
        && group[group.length - 1].getBoundingClientRect().bottom > pageContent.getBoundingClientRect().bottom + 1;
      if (exceedsPage && previousBlockCount > 0) {
        for (const unit of group) {
          unit.remove();
        }
        pageContent = createPage();
        pageContent.append(...group);
      }
    }
  }
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
  updateDocumentLayout(source);
  const blocks: PreviewBlock[] = parseLatex(source, graphics);
  const nextKeys = new Set(blocks.map((block) => block.key));
  orderedElements = [];

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
      rendered.delete(key);
    }
  }

  paginateBlocks(orderedElements);
  updatePageScale();
  fitDisplayMath();
  void document.fonts.ready.then(() => {
    paginateBlocks(orderedElements);
    updatePageScale();
    fitDisplayMath();
  });
  for (const image of Array.from(previewRoot.querySelectorAll("img"))) {
    image.addEventListener("load", () => {
      paginateBlocks(orderedElements);
      updatePageScale();
    }, { once: true });
  }
  window.scrollTo(window.scrollX, scrollY);
}

window.addEventListener("resize", () => {
  paginateBlocks(orderedElements);
  updatePageScale();
  fitDisplayMath();
});

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
