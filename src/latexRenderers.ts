import katex from "katex";
import { normalizeGraphicPath } from "./graphicPathUtils";
import type { ParseContext } from "./latexTypes";
import { escapeHtml, findUnescaped, isSafeCssColor, readGroup, skipWhitespace } from "./latexUtils";

export function renderMath(expression: string, displayMode: boolean, context: ParseContext): string {
  try {
    const cleanExpression = expression.replace(/\\(?:nonumber|notag)\b/g, "");
    return katex.renderToString(cleanExpression, {
      displayMode,
      output: "htmlAndMathml",
      throwOnError: false,
      strict: "ignore",
      trust: false,
      macros: context.macros
    });
  } catch {
    return `<code class="math-error">${escapeHtml(expression)}</code>`;
  }
}

function graphicStyles(options: string): string {
  const properties = new Map<string, string>();
  const optionPattern = /(?:^|,)\s*([A-Za-z]+)\s*=\s*([^,]+)/g;
  let match: RegExpExecArray | null;
  while ((match = optionPattern.exec(options)) !== null) {
    properties.set(match[1].toLowerCase(), match[2].trim());
  }
  const styles: string[] = [];
  const width = properties.get("width");
  const height = properties.get("height");
  const scale = Number(properties.get("scale") ?? "1");
  if (width) {
    const widthStyle = graphicDimension(width);
    if (widthStyle) {
      styles.push(`width:${widthStyle}`);
    }
  }
  if (height) {
    const heightStyle = graphicDimension(height);
    if (heightStyle) {
      styles.push(`height:${heightStyle}`);
    }
  }
  if (!width && !height && Number.isFinite(scale) && scale > 0) {
    styles.push(`width:${Math.min(scale * 100, 500)}%`);
  }
  const angle = Number(properties.get("angle") ?? "0");
  if (Number.isFinite(angle) && angle !== 0) {
    styles.push(`transform:rotate(${angle}deg)`);
  }
  if (options.split(",").some((option) => option.trim() === "draft")) {
    styles.push("visibility:hidden");
  }
  return styles.join(";");
}

function graphicDimension(dimension: string): string | undefined {
  const normalized = dimension.trim().toLowerCase();
  const textWidth = normalized.match(/^([\d.]+)\s*\\(?:textwidth|linewidth)$/);
  if (textWidth) {
    return `${Number(textWidth[1]) * 100}%`;
  }
  if (/^\d*\.?\d+\\(?:textwidth|linewidth)$/.test(normalized)) {
    return `${Number.parseFloat(normalized) * 100}%`;
  }
  if (/^\d*\.?\d+(?:px|em|rem|ex|pt|pc|mm|cm|in|%)$/.test(normalized)) {
    return normalized;
  }
  return undefined;
}

export function renderInline(source: string, context: ParseContext): string {
  let output = "";
  let cursor = 0;
  const tokenPattern = /\\includegraphics\*?(?:\s*\[[^\]]*\])?\s*\{|\\(?:textbf|textit|emph|texttt|textcolor|label|enquote|footnote)\s*\{|\\\(|\$(?!\$)/g;

  while (cursor < source.length) {
    tokenPattern.lastIndex = cursor;
    const match = tokenPattern.exec(source);
    if (!match) {
      output += escapeHtml(source.slice(cursor));
      break;
    }

    output += escapeHtml(source.slice(cursor, match.index));
    const token = match[0];
    if (token === "\\(" || token === "$") {
      const delimiter = token === "\\(" ? "\\)" : "$";
      const bodyStart = match.index + token.length;
      const end = findUnescaped(source, delimiter, bodyStart);
      if (end === -1) {
        output += escapeHtml(source.slice(match.index));
        break;
      }
      output += renderMath(source.slice(bodyStart, end), false, context);
      cursor = end + delimiter.length;
      continue;
    }

    if (token.startsWith("\\includegraphics")) {
      const optionStart = token.indexOf("[");
      const options = optionStart === -1
        ? ""
        : token.slice(optionStart + 1, token.lastIndexOf("]"));
      const argument = readGroup(source, match.index + token.length - 1);
      if (!argument) {
        output += escapeHtml(token);
        cursor = match.index + token.length;
        continue;
      }

      const filename = argument.content.trim();
      const uri = context.graphics[normalizeGraphicPath(filename)];
      if (!uri) {
        output += `<span class="graphic-error">Image not found: ${escapeHtml(filename)}</span>`;
        cursor = argument.end;
        continue;
      }

      const styles = graphicStyles(options);
      output += `<img class="latex-graphic" src="${escapeHtml(uri)}" alt="${escapeHtml(filename)}"${styles ? ` style="${escapeHtml(styles)}"` : ""}>`;
      cursor = argument.end;
      continue;
    }

    let openBrace = match.index + token.length - 1;
    while (/\s/.test(source[openBrace + 1] ?? "") && openBrace + 1 < source.length) {
      openBrace += 1;
    }
    const firstArgument = readGroup(source, openBrace);
    if (!firstArgument) {
      output += escapeHtml(source.slice(match.index));
      break;
    }

    const command = token.match(/\\(textbf|textit|emph|texttt|textcolor|label|enquote|footnote)/)?.[1];
    if (command === "label") {
      cursor = firstArgument.end;
      continue;
    }

    if (command === "enquote") {
      const depth = context.quoteDepth;
      context.quoteDepth += 1;
      const inner = renderInline(firstArgument.content, context);
      context.quoteDepth -= 1;
      const openingQuote = depth % 2 === 0 ? "&ldquo;" : "&lsquo;";
      const closingQuote = depth % 2 === 0 ? "&rdquo;" : "&rsquo;";
      output += `${openingQuote}${inner}${closingQuote}`;
      cursor = firstArgument.end;
      continue;
    }

    if (command === "footnote") {
      const number = context.footnotes.length + 1;
      const footnote = { number, html: "", sourceLine: context.currentSourceLine };
      context.footnotes.push(footnote);
      footnote.html = renderInline(firstArgument.content, context);
      output += `<sup class="footnote-ref"><a href="#footnote-${number}" id="footnote-ref-${number}">${number}</a></sup>`;
      cursor = firstArgument.end;
      continue;
    }

    if (command === "textcolor") {
      const colorStart = skipWhitespace(source, firstArgument.end);
      const secondArgument = readGroup(source, colorStart);
      if (!secondArgument) {
        output += escapeHtml(source.slice(match.index));
        break;
      }
      const inner = renderInline(secondArgument.content, context);
      const color = firstArgument.content.trim();
      output += isSafeCssColor(color)
        ? `<span style="color:${escapeHtml(color)}">${inner}</span>`
        : inner;
      cursor = secondArgument.end;
      continue;
    }

    if (!command) {
      output += escapeHtml(token);
      cursor = match.index + token.length;
      continue;
    }
    const inner = renderInline(firstArgument.content, context);
    const tag = command === "textbf" ? "strong" : command === "texttt" ? "code" : "em";
    output += `<${tag}>${inner}</${tag}>`;
    cursor = firstArgument.end;
  }

  return output;
}



function splitAlignmentRows(expression: string): string[] {
  const rows: string[] = [];
  let rowStart = 0;
  let environmentDepth = 0;
  let braceDepth = 0;

  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] === "\\") {
      const environment = expression.slice(index).match(/^\\(begin|end)\{[^{}]+\}/);
      if (environment) {
        environmentDepth += environment[1] === "begin" ? 1 : -1;
        index += environment[0].length - 1;
        continue;
      }
      if (expression[index + 1] === "\\" && environmentDepth === 0 && braceDepth === 0) {
        rows.push(expression.slice(rowStart, index));
        let nextRowStart = index + 2;
        if (expression[nextRowStart] === "[") {
          const optionEnd = expression.indexOf("]", nextRowStart + 1);
          if (optionEnd !== -1) {
            nextRowStart = optionEnd + 1;
          }
        }
        rowStart = nextRowStart;
        index = nextRowStart - 1;
        continue;
      }
      index += 1;
      continue;
    }

    if (expression[index] === "{" && expression[index - 1] !== "\\") {
      braceDepth += 1;
    } else if (expression[index] === "}" && expression[index - 1] !== "\\") {
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  rows.push(expression.slice(rowStart));
  return rows;
}

export function renderMathEnvironment(environment: string, expression: string, context: ParseContext): string {
  const starred = environment.endsWith("*");
  const baseEnvironment = starred ? environment.slice(0, -1) : environment;
  const cleanExpression = expression;
  const numberedEnvironment = !starred && ["equation", "align", "gather"].includes(baseEnvironment);

  if (baseEnvironment === "align" || baseEnvironment === "gather") {
    const rows = splitAlignmentRows(cleanExpression);
    while (rows.length > 1 && !rows[rows.length - 1].trim()) {
      rows.pop();
    }
    const taggedRows = rows.map((row) => {
      const suppressNumber = /\\(?:notag|nonumber)\b/.test(row);
      let cleanRow = row.replace(/\\label\s*\{[^{}]*\}/g, "").replace(/\\(?:notag|nonumber)\b/g, "");
      if (!numberedEnvironment || suppressNumber || !cleanRow.trim()) {
        return cleanRow;
      }

      const generatedNumber = nextEquationLabel(context);
      const number = cleanRow.match(/\\tag\*?\s*\{([^{}]*)\}/)?.[1] ?? generatedNumber;
      return /\\tag\*?\s*\{/.test(cleanRow) ? cleanRow : `${cleanRow}\\tag{${number}}`;
    });
    return renderMath(`\\begin{${environment}}${taggedRows.join("\\\\")}\\end{${environment}}`, true, context);
  }

  const suppressNumber = /\\(?:notag|nonumber)\b/.test(cleanExpression);
  let cleanEquation = cleanExpression.replace(/\\label\s*\{[^{}]*\}/g, "").replace(/\\(?:notag|nonumber)\b/g, "");
  if (numberedEnvironment && !suppressNumber) {
    const tag = cleanEquation.match(/\\tag\*?\s*\{([^{}]*)\}/)?.[1];
    const number = tag ?? nextEquationLabel(context);
    if (!tag) {
      cleanEquation += `\\tag{${number}}`;
    }
  }
  return renderMath(`\\begin{${environment}}${cleanEquation}\\end{${environment}}`, true, context);
}

function nextEquationLabel(context: ParseContext): string {
  const number = context.equationNumber++;
  return context.chapterNumber > 0 ? `${context.chapterNumber}.${number}` : String(number);
}



export function renderFigureBody(body: string, context: ParseContext): string {
  const captionPattern = /\\caption\*?\s*\{/g;
  let captionHtml = "";
  let content = body.replace(/\\(?:centering|raggedleft|raggedright|noindent)\b/g, "");
  const captionMatch = captionPattern.exec(content);
  if (captionMatch) {
    const openingBrace = content.indexOf("{", captionMatch.index);
    const caption = readGroup(content, openingBrace);
    if (caption) {
      const figureNumber = ++context.figureNumber;
      const number = context.chapterNumber > 0
        ? `${context.chapterNumber}.${figureNumber}`
        : String(figureNumber);
      captionHtml = `<figcaption><strong>Figure ${escapeHtml(number)}.</strong> ${renderInline(caption.content, context)}</figcaption>`;
      content = `${content.slice(0, captionMatch.index)}${content.slice(caption.end)}`;
    }
  }
  content = content.replace(/\\label\s*\{[^{}]*\}/g, "").replace(/\\hfill\b/g, "");
  return `<figure class="latex-figure">${renderInline(content, context)}${captionHtml}</figure>`;
}
