import { renderFigureBody, renderInline, renderMath, renderMathEnvironment } from "./latexRenderers";
import type { DocumentMetadata, ParseContext, PreviewBlock, RawBlock, TheoremDefinition } from "./latexTypes";
import { escapeHtml, findClosingBrace, findUnescaped, skipWhitespace, stripComment } from "./latexUtils";

function extractMacros(source: string): { source: string; macros: Record<string, string> } {
  const uncommented = source.split(/\r?\n/).map(stripComment).join("\n");
  const macros: Record<string, string> = {};
  const definitionPattern = /\\(newcommand|renewcommand|providecommand)\*?\s*(?:\{\\([A-Za-z]+)\}|\\([A-Za-z]+))/g;
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = definitionPattern.exec(uncommented)) !== null) {
    let end = skipWhitespace(uncommented, definitionPattern.lastIndex);
    if (uncommented[end] === "[") {
      const countEnd = uncommented.indexOf("]", end + 1);
      if (countEnd === -1) {
        continue;
      }
      end = skipWhitespace(uncommented, countEnd + 1);
      if (uncommented[end] === "[") {
        let depth = 1;
        end += 1;
        while (end < uncommented.length && depth > 0) {
          if (uncommented[end] === "[") {
            depth += 1;
          } else if (uncommented[end] === "]") {
            depth -= 1;
          }
          end += 1;
        }
        end = skipWhitespace(uncommented, end);
      }
    }

    if (uncommented[end] !== "{") {
      continue;
    }
    const closingBrace = findClosingBrace(uncommented, end + 1);
    if (closingBrace === -1) {
      continue;
    }

    const name = match[2] ?? match[3];
    const command = match[1];
    if (name && (command !== "providecommand" || macros[`\\${name}`] === undefined)) {
      macros[`\\${name}`] = uncommented.slice(end + 1, closingBrace);
    }

    output += uncommented.slice(cursor, match.index);
    output += uncommented.slice(match.index, closingBrace + 1).replace(/[^\r\n]/g, " ");
    cursor = closingBrace + 1;
    definitionPattern.lastIndex = cursor;
  }

  output += uncommented.slice(cursor);
  return { source: output, macros };
}

function extractTheorems(source: string): { source: string; theorems: Map<string, TheoremDefinition> } {
  const theorems = new Map<string, TheoremDefinition>();
  const definitionPattern = /\\newtheorem\*?\s*\{([A-Za-z]+)\}/g;
  const stylePattern = /\\theoremstyle\s*\{(plain|definition|remark)\}/g;
  let styleMatch = stylePattern.exec(source);
  let style: TheoremDefinition["style"] = "plain";
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = definitionPattern.exec(source)) !== null) {
    while (styleMatch && styleMatch.index < match.index) {
      style = styleMatch[1] as TheoremDefinition["style"];
      styleMatch = stylePattern.exec(source);
    }

    let titleStart = skipWhitespace(source, definitionPattern.lastIndex);
    if (source[titleStart] === "[") {
      const optionEnd = source.indexOf("]", titleStart + 1);
      if (optionEnd === -1) {
        continue;
      }
      titleStart = skipWhitespace(source, optionEnd + 1);
    }
    if (source[titleStart] !== "{") {
      continue;
    }
    const titleEnd = findClosingBrace(source, titleStart + 1);
    if (titleEnd === -1) {
      continue;
    }

    theorems.set(match[1], { title: source.slice(titleStart + 1, titleEnd), nextNumber: 1, style });
    output += source.slice(cursor, match.index);
    output += source.slice(match.index, titleEnd + 1).replace(/[^\r\n]/g, " ");
    cursor = titleEnd + 1;
    definitionPattern.lastIndex = cursor;
  }

  output += source.slice(cursor);
  return { source: output, theorems };
}

function extractDocumentMetadata(source: string): { source: string; metadata: DocumentMetadata } {
  const metadata: DocumentMetadata = { title: "", author: "", date: "" };
  let output = "";
  let cursor = 0;
  const commandPattern = /\\(title|author|date)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = commandPattern.exec(source)) !== null) {
    const openingBrace = source.indexOf("{", match.index + match[0].indexOf(match[1]) + match[1].length);
    const closingBrace = findClosingBrace(source, openingBrace + 1);
    if (closingBrace === -1) {
      continue;
    }
    metadata[match[1] as keyof DocumentMetadata] = source.slice(openingBrace + 1, closingBrace).trim();
    output += source.slice(cursor, match.index);
    output += source.slice(match.index, closingBrace + 1).replace(/[^\r\n]/g, " ");
    cursor = closingBrace + 1;
    commandPattern.lastIndex = cursor;
  }
  output += source.slice(cursor);
  return { source: output, metadata };
}

function renderTheoremBody(body: string, context: ParseContext, sourceLine: number): string {
  const displayEnvironment = /(\\(?:begin|end)\{(?:equation\*?|align\*?|gather\*?)\})/g;
  const sourceLines: number[] = [];
  const normalizedLines = body.split(/\r?\n/)
    .flatMap((line, index) => line.split(displayEnvironment).map((part) => {
      sourceLines.push(sourceLine + index);
      return part;
    }));
  return parseBlocks(normalizedLines.join("\n"), context, sourceLine, sourceLines).map((block, index) => {
    const anchor = `data-source-line="${block.sourceLine}" data-source-type="${block.type}"`;
    if (index === 0 && block.type === "paragraph" && block.html.startsWith("<p>")) {
      return `<span class="source-anchor theorem-intro" ${anchor}>${block.html.slice(3, -4)}</span>`;
    }
    return `<div class="source-anchor" ${anchor}>${block.html}</div>`;
  }).join("");
}

function parseBlocks(source: string, context: ParseContext, baseLine = 0, sourceLines?: number[]): RawBlock[] {
  let sourceLineOffset = baseLine;
  const documentStart = source.indexOf("\\begin{document}");
  if (documentStart !== -1) {
    sourceLineOffset = (source.slice(0, documentStart).match(/\n/g) ?? []).length;
    source = source.slice(documentStart + "\\begin{document}".length);
  }
  const documentEnd = source.indexOf("\\end{document}");
  if (documentEnd !== -1) {
    source = source.slice(0, documentEnd);
  }

  const lines = source.split(/\r?\n/).map(stripComment);
  const sourceLineAt = (line: number) => sourceLines?.[line] ?? sourceLineOffset + line;
  const blocks: RawBlock[] = [];
  let paragraph: string[] = [];
  let paragraphStartLine = 0;
  let suppressParagraphIndent = false;
  let index = 0;

  const flushParagraph = () => {
    const content = paragraph.join(" ").trim();
    paragraph = [];
    if (content) {
      context.currentSourceLine = sourceLineAt(paragraphStartLine);
      blocks.push({
        type: "paragraph",
        source: content,
        sourceLine: sourceLineAt(paragraphStartLine),
        html: `<p${suppressParagraphIndent ? ' class="no-indent"' : ""}>${renderInline(content, context)}</p>`
      });
      suppressParagraphIndent = false;
    }
  };

  while (index < lines.length) {
    const line = lines[index].trim();
    context.currentSourceLine = sourceLineAt(index);
    if (!line) {
      flushParagraph();
      index += 1;
      continue;
    }

    const heading = line.match(/^\\(chapter|section|subsection|subsubsection)(\*)?\s*\{/);
    if (heading) {
      flushParagraph();
      const openingBrace = line.indexOf("{", heading[0].length - 1);
      const closingBrace = findClosingBrace(line, openingBrace + 1);
      const content = closingBrace === -1
        ? line.slice(openingBrace + 1)
        : line.slice(openingBrace + 1, closingBrace);
      const starred = Boolean(heading[2]);
      const level = heading[1] === "chapter" || heading[1] === "section" ? 1 : heading[1] === "subsection" ? 2 : 3;
      let number = "";
      if (!starred) {
        if (heading[1] === "chapter") {
          context.chapterNumber += 1;
          context.sectionNumber = 0;
          context.subsectionNumber = 0;
          context.equationNumber = 1;
          context.figureNumber = 0;
          number = String(context.chapterNumber);
        } else if (heading[1] === "section") {
          context.sectionNumber += 1;
          context.subsectionNumber = 0;
          number = context.chapterNumber > 0
            ? `${context.chapterNumber}.${context.sectionNumber}`
            : String(context.sectionNumber);
        } else if (heading[1] === "subsection") {
          context.subsectionNumber += 1;
          number = context.chapterNumber > 0
            ? `${context.chapterNumber}.${context.sectionNumber}.${context.subsectionNumber}`
            : `${context.sectionNumber}.${context.subsectionNumber}`;
        }
      }
      const prefix = !number ? "" : heading[1] === "chapter" ? `Chapter ${number}: ` : `${number} `;
      blocks.push({
        type: `heading${level}`,
        source: line,
        sourceLine: sourceLineAt(index),
        html: heading[1] === "chapter"
          ? `<header class="chapter-heading"><div class="chapter-number">Chapter ${escapeHtml(number)}</div><h1>${renderInline(content, context)}</h1></header>`
          : `<h${level}>${escapeHtml(prefix)}${renderInline(content, context)}</h${level}>`
      });
      index += 1;
      continue;
    }

    const displayDelimiter = line.startsWith("$$") ? "$$" : line.startsWith("\\[") ? "\\]" : undefined;
    const mathStart = line.match(/^\\begin\{(equation\*?|align\*?|gather\*?)\}/);
    if (displayDelimiter || mathStart) {
      flushParagraph();
      const rawLines = [line];
      let expression = "";
      let closingLine = index;
      let closed = false;

      if (mathStart) {
        const environment = mathStart[1];
        expression = line.slice(mathStart[0].length);
        const endToken = `\\end{${environment}}`;
        while (true) {
          const endAt = expression.indexOf(endToken);
          if (endAt !== -1) {
            expression = expression.slice(0, endAt);
            closed = true;
            break;
          }
          closingLine += 1;
          if (closingLine >= lines.length) {
            break;
          }
          rawLines.push(lines[closingLine]);
          expression += `\n${lines[closingLine]}`;
        }
      } else {
        const opener = displayDelimiter!;
        const closer = opener === "$$" ? "$$" : "\\]";
        expression = line.slice(opener.length);
        let endAt = findUnescaped(expression, closer, 0);
        if (endAt !== -1) {
          expression = expression.slice(0, endAt);
          closed = true;
        } else {
          while (++closingLine < lines.length) {
            rawLines.push(lines[closingLine]);
            endAt = findUnescaped(lines[closingLine], closer, 0);
            if (endAt !== -1) {
              expression += `\n${lines[closingLine].slice(0, endAt)}`;
              closed = true;
              break;
            }
            expression += `\n${lines[closingLine]}`;
          }
        }
      }

      blocks.push({
        type: "displayMath",
        source: rawLines.join("\n"),
        sourceLine: sourceLineAt(index),
        html: mathStart
          ? renderMathEnvironment(mathStart[1], expression, context)
          : renderMath(expression, true, context)
      });
      suppressParagraphIndent = true;
      index = closed ? closingLine + 1 : lines.length;
      continue;
    }

    const figureStart = line.match(/^\\begin\{figure\*?\}(?:\[[^\]]*\])?/);
    if (figureStart) {
      flushParagraph();
      const rawLines = [line];
      let body = line.slice(figureStart[0].length);
      const endToken = line.includes("figure*") ? "\\end{figure*}" : "\\end{figure}";
      let closingLine = index;
      let closed = false;
      while (true) {
        const endAt = body.indexOf(endToken);
        if (endAt !== -1) {
          body = body.slice(0, endAt);
          closed = true;
          break;
        }
        closingLine += 1;
        if (closingLine >= lines.length) {
          break;
        }
        rawLines.push(lines[closingLine]);
        body += `\n${lines[closingLine]}`;
      }
      blocks.push({
        type: "figure",
        source: rawLines.join("\n"),
        sourceLine: sourceLineAt(index),
        html: renderFigureBody(body, context)
      });
      index = closed ? closingLine + 1 : lines.length;
      continue;
    }

    const theoremStart = line.match(/^\\begin\{([A-Za-z]+)\}(?:\[(.*)\])?/);
    if (theoremStart && (theoremStart[1] === "proof" || context.theorems.has(theoremStart[1]))) {
      flushParagraph();
      const environment = theoremStart[1];
      const rawLines = [line];
      let body = line.slice(theoremStart[0].length);
      const endToken = `\\end{${environment}}`;
      let closingLine = index;
      let closed = false;
      while (true) {
        const endAt = body.indexOf(endToken);
        if (endAt !== -1) {
          body = body.slice(0, endAt);
          closed = true;
          break;
        }
        closingLine += 1;
        if (closingLine >= lines.length) {
          break;
        }
        rawLines.push(lines[closingLine]);
        body += `\n${lines[closingLine]}`;
      }

      const optionalTitle = theoremStart[2]?.trim();
      let heading: string;
      let bodyStyle: string;
      let headingMarkup: string;
      if (environment === "proof") {
        heading = optionalTitle ? `Proof (${renderInline(optionalTitle, context)}).` : "Proof.";
        bodyStyle = "proof-body";
        headingMarkup = `<em>${heading}</em>`;
      } else {
        const theorem = context.theorems.get(environment)!;
        const theoremNumber = theorem.nextNumber++;
        const displayNumber = String(theoremNumber);
        heading = `${escapeHtml(theorem.title)} ${displayNumber}${optionalTitle ? ` (${renderInline(optionalTitle, context)})` : ""}.`;
        bodyStyle = "theorem-body";
        headingMarkup = `<strong>${heading}</strong>`;
      }
      blocks.push({
        type: environment === "proof" ? "proof" : "theorem",
        source: rawLines.join("\n"),
        sourceLine: sourceLineAt(index),
        html: `<div class="${bodyStyle}${environment === "proof" ? "" : ` theorem-${context.theorems.get(environment)!.style}`}">${headingMarkup} ${renderTheoremBody(body, context, sourceLineAt(index))}${environment === "proof" ? '<span class="qed" aria-label="end of proof"></span>' : ""}</div>`
      });
      index = closed ? closingLine + 1 : lines.length;
      continue;
    }

    const listStart = line.match(/^\\begin\{(itemize|enumerate)\}/);
    if (listStart) {
      flushParagraph();
      const listType = listStart[1];
      const items: string[] = [];
      const rawLines = [line];
      let currentItem: string[] = [];
      let closingLine = index;
      const endPattern = new RegExp(`^\\\\end\\{${listType}\\}`);
      for (closingLine = index + 1; closingLine < lines.length; closingLine += 1) {
        const listLine = lines[closingLine].trim();
        rawLines.push(lines[closingLine]);
        if (endPattern.test(listLine)) {
          if (currentItem.length) {
            items.push(currentItem.join(" "));
          }
          break;
        }
        if (listLine.startsWith("\\item")) {
          if (currentItem.length) {
            items.push(currentItem.join(" "));
          }
          currentItem = [listLine.replace(/^\\item(?:\s*\[[^\]]*\])?\s*/, "")];
        } else if (currentItem.length) {
          currentItem.push(listLine);
        }
      }
      if (closingLine >= lines.length) {
        if (currentItem.length) {
          items.push(currentItem.join(" "));
        }
        closingLine = lines.length - 1;
      }
      const tag = listType === "itemize" ? "ul" : "ol";
      blocks.push({
        type: `list-${listType}`,
        source: rawLines.join("\n"),
        sourceLine: sourceLineAt(index),
        html: `<${tag}>${items.map((item) => `<li>${renderInline(item.trim(), context)}</li>`).join("")}</${tag}>`
      });
      index = closingLine + 1;
      continue;
    }

    const standaloneLabel = line.match(/^\\label\s*\{([^{}]*)\}\s*$/);
    if (standaloneLabel) {
      index += 1;
      continue;
    }

    if (/^\\maketitle\b/.test(line)) {
      flushParagraph();
      const title = context.metadata.title ? `<h1 class="document-title">${renderInline(context.metadata.title, context)}</h1>` : "";
      const author = context.metadata.author ? `<div class="document-author">${renderInline(context.metadata.author, context)}</div>` : "";
      const date = context.metadata.date && context.metadata.date !== "\\today"
        ? `<div class="document-date">${renderInline(context.metadata.date, context)}</div>`
        : context.metadata.date === "\\today" ? `<div class="document-date">${new Date().toLocaleDateString()}</div>` : "";
      blocks.push({
        type: "title",
        source: line,
        sourceLine: sourceLineAt(index),
        html: `<header class="document-title-block">${title}${author}${date}</header>`
      });
      index += 1;
      continue;
    }

    if (/^\\(?:begin|end)\{document\}$/.test(line) || /^\\tableofcontents$/.test(line)) {
      flushParagraph();
      index += 1;
      continue;
    }

    if (paragraph.length === 0) {
      paragraphStartLine = index;
    }
    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

export function parseLatex(source: string, graphics: Record<string, string> = {}): PreviewBlock[] {
  const occurrences = new Map<string, number>();
  const macroDocument = extractMacros(source);
  const theoremDocument = extractTheorems(macroDocument.source);
  const document = extractDocumentMetadata(theoremDocument.source);
  const context: ParseContext = {
    macros: macroDocument.macros,
    theorems: new Map([...theoremDocument.theorems].map(([name, theorem]) => [
      name,
      { title: theorem.title, nextNumber: 1, style: theorem.style }
    ])),
    graphics,
    footnotes: [],
    metadata: document.metadata,
    chapterNumber: 0,
    sectionNumber: 0,
    subsectionNumber: 0,
    equationNumber: 1,
    figureNumber: 0,
    currentSourceLine: 0,
    quoteDepth: 0
  };
  const blocks = parseBlocks(document.source, context);
  if (context.footnotes.length > 0) {
    blocks.push({
      type: "footnotes",
      source: "",
      sourceLine: context.footnotes[0].sourceLine,
      html: `<section class="footnotes"><hr><ol>${context.footnotes.map((footnote) =>
        `<li id="footnote-${footnote.number}">${footnote.html}<a class="footnote-backlink" href="#footnote-ref-${footnote.number}" aria-label="Back to footnote reference">&#8617;</a></li>`
      ).join("")}</ol></section>`
    });
  }
  return blocks.map((block) => {
    const baseKey = `${block.type}\0${block.source}`;
    const occurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, occurrence + 1);
    return {
      ...block,
      key: `${baseKey}\0${occurrence}`
    };
  });
}
