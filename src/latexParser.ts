import katex from "katex";

export interface PreviewBlock {
  key: string;
  type: string;
  source: string;
  sourceLine: number;
  html: string;
}

interface RawBlock {
  type: string;
  source: string;
  sourceLine: number;
  html: string;
}

interface TheoremDefinition {
  title: string;
  nextNumber: number;
}

interface DocumentMetadata {
  title: string;
  author: string;
  date: string;
}

interface ParseContext {
  macros: Record<string, string>;
  theorems: Map<string, TheoremDefinition>;
  labels: Map<string, string>;
  graphics: Record<string, string>;
  footnotes: { number: number; html: string; sourceLine: number }[];
  metadata: DocumentMetadata;
  chapterNumber: number;
  sectionNumber: number;
  subsectionNumber: number;
  equationNumber: number;
  figureNumber: number;
  currentReference: string;
  currentSourceLine: number;
  quoteDepth: number;
  tikzNumber: number;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    };
    return entities[character];
  });
}

function resolveMathReferences(expression: string, context: ParseContext): string {
  return expression.replace(/\\(autoref|eqref|ref)\s*\{([^{}]+)\}/g, (_match, command: string, key: string) => {
    const value = context.labels.get(key.trim()) ?? "??";
    const reference = command === "eqref" ? `(${value})` : command === "autoref" ? `Equation ${value}` : value;
    return `\\text{${reference.replace(/[{}\\]/g, "")}}`;
  });
}

function renderMath(expression: string, displayMode: boolean, context: ParseContext): string {
  try {
    const cleanExpression = expression.replace(/\\(?:nonumber|notag)\b/g, "");
    return katex.renderToString(resolveMathReferences(cleanExpression, context), {
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

function findUnescaped(source: string, needle: string, start: number): number {
  let index = source.indexOf(needle, start);
  while (index !== -1) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
      slashes += 1;
    }
    if (slashes % 2 === 0) {
      return index;
    }
    index = source.indexOf(needle, index + needle.length);
  }
  return -1;
}

function isSafeCssColor(color: string): boolean {
  return /^(?:#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d.%\s,]+\)|hsla?\([\d.%\s,deg]+\))$/i.test(color);
}

function readGroup(source: string, openingBrace: number): { content: string; end: number } | undefined {
  if (source[openingBrace] !== "{") {
    return undefined;
  }
  const closingBrace = findClosingBrace(source, openingBrace + 1);
  return closingBrace === -1
    ? undefined
    : { content: source.slice(openingBrace + 1, closingBrace), end: closingBrace + 1 };
}

function renderInline(source: string, context: ParseContext): string {
  let output = "";
  let cursor = 0;
  const tokenPattern = /\\begin\{tikzpicture\}(?:\[[^\]]*\])?|\\includegraphics\*?(?:\s*\[[^\]]*\])?\s*\{|\\(?:textbf|textit|emph|texttt|textcolor|ref|eqref|autoref|label|enquote|footnote)\s*\{|\\\(|\$(?!\$)/g;

  while (cursor < source.length) {
    tokenPattern.lastIndex = cursor;
    const match = tokenPattern.exec(source);
    if (!match) {
      output += escapeHtml(source.slice(cursor));
      break;
    }

    output += escapeHtml(source.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("\\begin{tikzpicture}")) {
      const options = token.match(/^\\begin\{tikzpicture\}(?:\[([^\]]*)\])?/)?.[1] ?? "";
      const bodyStart = match.index + token.length;
      const end = source.indexOf("\\end{tikzpicture}", bodyStart);
      if (end === -1) {
        output += escapeHtml(source.slice(match.index));
        break;
      }
      output += renderTikzPicture(source.slice(bodyStart, end), options, context);
      cursor = end + "\\end{tikzpicture}".length;
      continue;
    }
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

    function normalizeGraphicPath(filename: string): string {
      return filename.replace(/\\/g, "/").replace(/^\.\//, "").trim().toLowerCase();
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

    const command = token.match(/\\(textbf|textit|emph|texttt|textcolor|ref|eqref|autoref|label|enquote|footnote)/)?.[1];
    if (command === "label") {
      if (context.currentReference) {
        context.labels.set(firstArgument.content.trim(), context.currentReference);
      }
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

    if (command === "ref" || command === "eqref" || command === "autoref") {
      const value = context.labels.get(firstArgument.content.trim()) ?? "??";
      const rendered = command === "eqref" ? `(${value})` : command === "autoref" ? `Equation ${value}` : value;
      output += `<span class="reference">${escapeHtml(rendered)}</span>`;
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

function stripComment(line: string): string {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "%") {
      continue;
    }
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
      slashes += 1;
    }
    if (slashes % 2 === 0) {
      return line.slice(0, index);
    }
  }
  return line;
}

function findClosingBrace(source: string, start: number): number {
  let depth = 1;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{" && source[index - 1] !== "\\") {
      depth += 1;
    } else if (source[index] === "}" && source[index - 1] !== "\\") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function skipWhitespace(source: string, start: number): number {
  while (/\s/.test(source[start] ?? "")) {
    start += 1;
  }
  return start;
}

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
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = definitionPattern.exec(source)) !== null) {
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

    theorems.set(match[1], { title: source.slice(titleStart + 1, titleEnd), nextNumber: 1 });
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

function renderMathEnvironment(environment: string, expression: string, context: ParseContext): string {
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
      const labelKeys = [...row.matchAll(/\\label\s*\{([^{}]*)\}/g)].map((match) => match[1].trim());
      let cleanRow = row.replace(/\\label\s*\{[^{}]*\}/g, "").replace(/\\(?:notag|nonumber)\b/g, "");
      if (!numberedEnvironment || suppressNumber || !cleanRow.trim()) {
        return cleanRow;
      }

      const generatedNumber = nextEquationLabel(context);
      const number = cleanRow.match(/\\tag\*?\s*\{([^{}]*)\}/)?.[1] ?? generatedNumber;
      context.currentReference = number;
      for (const key of labelKeys) {
        context.labels.set(key, number);
      }
      return /\\tag\*?\s*\{/.test(cleanRow) ? cleanRow : `${cleanRow}\\tag{${number}}`;
    });
    if (!numberedEnvironment) {
      context.currentReference = "";
    }
    return renderMath(`\\begin{${environment}}${taggedRows.join("\\\\")}\\end{${environment}}`, true, context);
  }

  const labelKeys = [...cleanExpression.matchAll(/\\label\s*\{([^{}]*)\}/g)].map((match) => match[1].trim());
  const suppressNumber = /\\(?:notag|nonumber)\b/.test(cleanExpression);
  let cleanEquation = cleanExpression.replace(/\\label\s*\{[^{}]*\}/g, "").replace(/\\(?:notag|nonumber)\b/g, "");
  if (numberedEnvironment && !suppressNumber) {
    const tag = cleanEquation.match(/\\tag\*?\s*\{([^{}]*)\}/)?.[1];
    const number = tag ?? nextEquationLabel(context);
    context.currentReference = number;
    for (const key of labelKeys) {
      context.labels.set(key, number);
    }
    if (!tag) {
      cleanEquation += `\\tag{${number}}`;
    }
  } else {
    context.currentReference = "";
  }
  return renderMath(`\\begin{${environment}}${resolveMathReferences(cleanEquation, context)}\\end{${environment}}`, true, context);
}

function nextEquationLabel(context: ParseContext): string {
  const number = context.equationNumber++;
  context.currentReference = context.chapterNumber > 0 ? `${context.chapterNumber}.${number}` : String(number);
  return context.currentReference;
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

interface TikzPoint {
  x: number;
  y: number;
}

interface TikzLabel {
  point: TikzPoint;
  content: string;
  options: string[];
}

function splitTikzOptions(options: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] === "{") {
      depth += 1;
    } else if (options[index] === "}") {
      depth = Math.max(0, depth - 1);
    } else if (options[index] === "," && depth === 0) {
      result.push(options.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (start < options.length) {
    result.push(options.slice(start).trim());
  }
  return result.filter(Boolean);
}

function tikzLength(value: string): number | undefined {
  const match = value.trim().match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(cm|mm|in|pt)?$/i);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "cm").toLowerCase();
  const factor = unit === "mm" ? 0.1 : unit === "in" ? 2.54 : unit === "pt" ? 1 / 28.45 : 1;
  return amount * factor;
}

function readTikzCommand(source: string, start: number): { command: string; body: string; end: number } | undefined {
  const match = source.slice(start).match(/^\\(draw|filldraw|fill|path|node|coordinate)\b/);
  if (!match) {
    return undefined;
  }
  const bodyStart = start + match[0].length;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{" && source[index - 1] !== "\\") {
      braceDepth += 1;
    } else if (character === "}" && source[index - 1] !== "\\") {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (character === "[" && braceDepth === 0) {
      bracketDepth += 1;
    } else if (character === "]" && braceDepth === 0) {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (character === "(" && braceDepth === 0) {
      parenDepth += 1;
    } else if (character === ")" && braceDepth === 0) {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (character === ";" && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      return { command: match[1], body: source.slice(bodyStart, index), end: index + 1 };
    }
  }
  return { command: match[1], body: source.slice(bodyStart), end: source.length };
}

function readTikzOptions(source: string, start: number): { options: string; end: number } | undefined {
  const opening = skipWhitespace(source, start);
  if (source[opening] !== "[") {
    return undefined;
  }
  let braceDepth = 0;
  for (let index = opening + 1; index < source.length; index += 1) {
    if (source[index] === "{") {
      braceDepth += 1;
    } else if (source[index] === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (source[index] === "]" && braceDepth === 0) {
      return { options: source.slice(opening + 1, index), end: index + 1 };
    }
  }
  return undefined;
}

function renderTikzPicture(source: string, pictureOptions: string, context: ParseContext): string {
  const settings = splitTikzOptions(pictureOptions);
  const settingValue = (name: string) => settings.find((option) => option.startsWith(`${name}=`))?.slice(name.length + 1);
  const scale = Number(settingValue("scale") ?? "1");
  const drawingScale = Number.isFinite(scale) && scale !== 0 ? scale : 1;
  const scaleMagnitude = Math.abs(drawingScale);
  const xUnit = tikzLength(settingValue("x") ?? "1cm") ?? 1;
  const yUnit = tikzLength(settingValue("y") ?? "1cm") ?? 1;
  const scaleX = drawingScale * xUnit;
  const scaleY = drawingScale * yUnit;
  const coordinates = new Map<string, TikzPoint>();
  const labels: TikzLabel[] = [];
  const shapes: string[] = [];
  const markerId = `tikz-arrow-${++context.tikzNumber}`;
  const nonColorOptions = new Set([
    "above", "below", "left", "right", "draw", "fill", "thin", "thick", "very thick", "ultra thick",
    "dashed", "dotted", "solid", "circle", "rectangle", "->", "<-", "<->"
  ]);
  const isTikzColor = (value: string) => isSafeCssColor(value) && !nonColorOptions.has(value.trim().toLowerCase());
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const includePoint = (point: TikzPoint, margin = 0) => {
    minX = Math.min(minX, point.x - margin);
    minY = Math.min(minY, point.y - margin);
    maxX = Math.max(maxX, point.x + margin);
    maxY = Math.max(maxY, point.y + margin);
  };
  const parsePoint = (value: string, previous?: TikzPoint): TikzPoint | undefined => {
    const normalized = value.trim();
    const relative = normalized.match(/^(\+\+?)\s*\(([^()]*)\)$/);
    const absolute = normalized.match(/^\(([^()]*)\)$/);
    const body = relative?.[2] ?? absolute?.[1];
    if (body === undefined) {
      return undefined;
    }
    const parts = body.split(",");
    if (parts.length !== 2) {
      return relative ? undefined : coordinates.get(body.trim());
    }
    const x = tikzLength(parts[0]);
    const y = tikzLength(parts[1]);
    if (x === undefined || y === undefined) {
      return undefined;
    }
    if (relative) {
      return { x: (previous?.x ?? 0) + x * scaleX, y: (previous?.y ?? 0) + y * scaleY };
    }
    return { x: x * scaleX, y: y * scaleY };
  };
  const parseCommandOptions = (body: string) => {
    const optionGroup = readTikzOptions(body, 0);
    return { options: splitTikzOptions(optionGroup?.options ?? ""), rest: body.slice(optionGroup?.end ?? 0) };
  };
  const colorOption = (options: string[], key: "draw" | "fill"): string | undefined => {
    const value = options.find((option) => option.startsWith(`${key}=`))?.slice(key.length + 1).trim();
    if (value) {
      return value.toLowerCase() === "none" ? "none" : isSafeCssColor(value) ? value : undefined;
    }
    return options.find(isTikzColor);
  };

  const commandPattern = /\\(?:draw|filldraw|fill|path|node|coordinate)\b/g;
  let commandMatch: RegExpExecArray | null;
  while ((commandMatch = commandPattern.exec(source)) !== null) {
    const parsed = readTikzCommand(source, commandMatch.index);
    if (!parsed) {
      continue;
    }
    commandPattern.lastIndex = parsed.end;
    const { options, rest } = parseCommandOptions(parsed.body);

    if (parsed.command === "coordinate") {
      const coordinateMatch = rest.match(/^\s*\(([^()]+)\)\s*at\s*\(([^()]*)\)/);
      if (coordinateMatch) {
        const point = parsePoint(`(${coordinateMatch[2]})`);
        if (point) {
          coordinates.set(coordinateMatch[1].trim(), point);
          includePoint(point);
        }
      }
      continue;
    }

    if (parsed.command === "node") {
      let nodeRest = rest.trim();
      const nameMatch = nodeRest.match(/^\(([^()]*)\)\s*/);
      const name = nameMatch?.[1].trim();
      if (nameMatch) {
        nodeRest = nodeRest.slice(nameMatch[0].length);
      }
      const atMatch = nodeRest.match(/^at\s*\(([^()]*)\)\s*/);
      if (!atMatch) {
        continue;
      }
      const point = parsePoint(`(${atMatch[1]})`);
      const contentStart = skipWhitespace(nodeRest, atMatch[0].length);
      const contentGroup = readGroup(nodeRest, contentStart);
      if (!point || !contentGroup) {
        continue;
      }
      if (name) {
        coordinates.set(name, point);
      }
      includePoint(point);
      labels.push({ point, content: contentGroup.content, options });
      continue;
    }

    const tokenPattern = /\+\+?\s*\([^()]*\)|\([^()]*\)|--|rectangle|circle\s*\([^()]*\)|cycle/g;
    const tokens = [...rest.matchAll(tokenPattern)];
    let points: TikzPoint[] = [];
    let current: TikzPoint | undefined;
    let connected = false;
    let closed = false;
    let rectangleFrom: TikzPoint | undefined;
    const flushPath = () => {
      if (connected && points.length > 1) {
        const d = `M ${points[0].x} ${points[0].y} ${points.slice(1).map((point) => `L ${point.x} ${point.y}`).join(" ")}${closed ? " Z" : ""}`;
        shapes.push(svgShape("path", d, parsed.command, options, scale));
      }
      points = current ? [current] : [];
      connected = false;
      closed = false;
    };

    for (const tokenMatch of tokens) {
      const token = tokenMatch[0].trim();
      if (token === "--") {
        connected = true;
        continue;
      }
      if (token === "cycle") {
        closed = true;
        continue;
      }
      if (token.startsWith("circle")) {
        const radiusMatch = token.match(/circle\s*\(([^()]*)\)/);
        const radius = radiusMatch ? tikzLength(radiusMatch[1]) : undefined;
        if (current && radius !== undefined && radius > 0) {
          flushPath();
          shapes.push(svgShape("circle", `${current.x} ${current.y} ${radius * scaleMagnitude}`, parsed.command, options, scaleMagnitude));
          includePoint(current, radius * scaleMagnitude);
        }
        continue;
      }
      if (token === "rectangle") {
        rectangleFrom = current;
        flushPath();
        continue;
      }

      const next = parsePoint(token, current);
      if (!next) {
        continue;
      }
      includePoint(next);
      if (!token.startsWith("+") || token.startsWith("++")) {
        current = next;
      }
      if (rectangleFrom) {
        shapes.push(svgShape("rect", `${Math.min(rectangleFrom.x, next.x)} ${Math.min(rectangleFrom.y, next.y)} ${Math.abs(next.x - rectangleFrom.x)} ${Math.abs(next.y - rectangleFrom.y)}`, parsed.command, options, scale));
        includePoint(rectangleFrom);
        points = [next];
        rectangleFrom = undefined;
        connected = false;
        continue;
      }
      if (points.length === 0) {
        points = [next];
      } else if (connected) {
        points.push(next);
      } else {
        flushPath();
        points = [next];
      }
    }
    flushPath();
  }

  if (labels.length === 0 && shapes.length === 0) {
    return `<div class="tikz-unsupported">This preview supports basic TikZ paths, shapes, and text nodes.</div>`;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
  }
  const margin = 0.1 * scaleMagnitude;
  minX -= margin;
  minY -= margin;
  maxX += margin;
  maxY += margin;
  const width = Math.max(0.01, maxX - minX);
  const height = Math.max(0.01, maxY - minY);
  const physicalWidth = width * 96 / 2.54;
  const nodeHtml = labels.map((label) => {
    const x = ((label.point.x - minX) / width) * 100;
    const y = ((maxY - label.point.y) / height) * 100;
    const color = colorOption(label.options, "draw");
    const fill = colorOption(label.options, "fill");
    const style: string[] = [`left:${x}%`, `top:${y}%`];
    if (label.options.includes("draw")) {
      style.push(`border:1px solid ${color && color !== "none" ? color : "currentColor"}`);
    }
    if (fill && fill !== "none") {
      style.push(`background:${fill}`);
    }
    if (label.options.includes("circle")) {
      style.push("border-radius:50%");
    }
    const position = label.options.find((option) => ["above", "below", "left", "right"].includes(option));
    if (position === "above") {
      style.push("transform:translate(-50%,-100%)");
    } else if (position === "below") {
      style.push("transform:translate(-50%,0)");
    } else if (position === "left") {
      style.push("transform:translate(-100%,-50%)");
    } else if (position === "right") {
      style.push("transform:translate(0,-50%)");
    } else {
      style.push("transform:translate(-50%,-50%)");
    }
    return `<span class="tikz-label" style="${escapeHtml(style.join(";"))}">${renderInline(label.content, context)}</span>`;
  }).join("");

  return `<div class="tikz-picture" style="width:${physicalWidth}px;max-width:100%;aspect-ratio:${width}/${height}"><svg viewBox="${minX} ${-maxY} ${width} ${height}" role="img" aria-label="TikZ drawing"><defs><marker id="${markerId}" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L7,3.5 L0,7 Z" fill="context-stroke"/></marker></defs><g transform="scale(1,-1)">${shapes.join("")}</g></svg>${nodeHtml}</div>`;

  function svgShape(kind: "path" | "rect" | "circle", geometry: string, command: string, options: string[], drawingScale: number): string {
    const drawOption = options.find((option) => option.startsWith("draw="))?.slice(5);
    const fillOption = options.find((option) => option.startsWith("fill="))?.slice(5);
    const shorthandColor = options.find(isTikzColor);
    const hasDraw = options.includes("draw") || drawOption !== undefined || ["draw", "filldraw"].includes(command);
    const hasFill = options.includes("fill") || fillOption !== undefined || ["fill", "filldraw"].includes(command);
    const stroke = command === "fill" && drawOption === undefined && !options.includes("draw")
      ? "none"
      : drawOption === "none" ? "none" : isSafeCssColor(drawOption ?? shorthandColor ?? "black") ? drawOption ?? shorthandColor ?? "black" : "black";
    const fill = fillOption === "none"
      ? "none"
      : fillOption && isSafeCssColor(fillOption) ? fillOption
        : hasFill ? (stroke === "none" ? shorthandColor ?? "black" : stroke) : "none";
    const lineWidth = (options.includes("ultra") && options.includes("thick")) ? (tikzLength("1.6pt") ?? 0) * drawingScale
      : (options.includes("very") && options.includes("thick")) ? (tikzLength("1.2pt") ?? 0) * drawingScale
        : options.includes("thick") ? (tikzLength("0.8pt") ?? 0) * drawingScale
          : options.includes("thin") ? (tikzLength("0.4pt") ?? 0) * drawingScale
            : (tikzLength(options.find((option) => option.startsWith("line width="))?.slice(11) ?? "0.4pt") ?? 0) * drawingScale;
    const dash = options.includes("dashed") ? ` stroke-dasharray="${lineWidth * 4} ${lineWidth * 3}"`
      : options.includes("dotted") ? ` stroke-dasharray="${lineWidth} ${lineWidth * 2}"`
        : "";
    const arrow = options.includes("<->")
      ? ` marker-start="url(#${markerId})" marker-end="url(#${markerId})"`
      : options.includes("<-")
        ? ` marker-start="url(#${markerId})"`
        : options.includes("->")
          ? ` marker-end="url(#${markerId})"`
          : "";
    const style = `fill="${escapeHtml(fill)}" stroke="${escapeHtml(hasDraw ? stroke : "none")}" stroke-width="${lineWidth}"${dash}${arrow}`;
    if (kind === "path") {
      return `<path d="${escapeHtml(geometry)}" ${style}/>`;
    }
    if (kind === "rect") {
      const [x, y, width, height] = geometry.split(" ").map(Number);
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" ${style}/>`;
    }
    const [cx, cy, radius] = geometry.split(" ").map(Number);
    return `<circle cx="${cx}" cy="${cy}" r="${radius}" ${style}/>`;
  }
}

function renderFigureBody(body: string, context: ParseContext): string {
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
      context.currentReference = number;
      captionHtml = `<figcaption><strong>Figure ${escapeHtml(number)}.</strong> ${renderInline(caption.content, context)}</figcaption>`;
      const labels = content.slice(caption.end).matchAll(/\\label\s*\{([^{}]*)\}/g);
      for (const label of labels) {
        context.labels.set(label[1].trim(), number);
      }
      content = `${content.slice(0, captionMatch.index)}${content.slice(caption.end)}`;
    }
  }
  content = content.replace(/\\label\s*\{[^{}]*\}/g, "").replace(/\\hfill\b/g, "");
  return `<figure class="latex-figure">${renderInline(content, context)}${captionHtml}</figure>`;
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
        html: `<p>${renderInline(content, context)}</p>`
      });
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
      const labels = closingBrace === -1
        ? []
        : [...line.slice(closingBrace + 1).matchAll(/\\label\s*\{([^{}]*)\}/g)].map((match) => match[1].trim());
      if (number) {
        context.currentReference = number;
        for (const label of labels) {
          context.labels.set(label, number);
        }
      } else {
        context.currentReference = "";
      }
      blocks.push({
        type: `heading${level}`,
        source: line,
        sourceLine: sourceLineAt(index),
        html: `<h${level}>${escapeHtml(prefix)}${renderInline(content, context)}</h${level}>`
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
      index = closed ? closingLine + 1 : lines.length;
      continue;
    }

    const tikzStart = line.match(/^\\begin\{tikzpicture\}(?:\[([^\]]*)\])?/);
    if (tikzStart) {
      flushParagraph();
      const rawLines = [line];
      let body = line.slice(tikzStart[0].length);
      let closingLine = index;
      let closed = false;
      while (true) {
        const endAt = body.indexOf("\\end{tikzpicture}");
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
        type: "tikz",
        source: rawLines.join("\n"),
        sourceLine: sourceLineAt(index),
        html: renderTikzPicture(body, tikzStart[1] ?? "", context)
      });
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
        const displayNumber = context.chapterNumber > 0
          ? `${context.chapterNumber}.${theoremNumber}`
          : String(theoremNumber);
        context.currentReference = displayNumber;
        const beginEnd = line.indexOf(theoremStart[0]) + theoremStart[0].length;
        const labelsAtStart = line.slice(beginEnd).matchAll(/\\label\s*\{([^{}]*)\}/g);
        for (const label of labelsAtStart) {
          context.labels.set(label[1].trim(), displayNumber);
        }
        heading = `${escapeHtml(theorem.title)} ${displayNumber}${optionalTitle ? ` (${renderInline(optionalTitle, context)})` : ""}.`;
        bodyStyle = "theorem-body";
        headingMarkup = `<strong>${heading}</strong>`;
      }
      blocks.push({
        type: environment === "proof" ? "proof" : "theorem",
        source: rawLines.join("\n"),
        sourceLine: sourceLineAt(index),
        html: `<div class="${bodyStyle}">${headingMarkup} ${renderTheoremBody(body, context, sourceLineAt(index))}${environment === "proof" ? '<span class="qed" aria-label="end of proof"></span>' : ""}</div>`
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
      if (context.currentReference) {
        context.labels.set(standaloneLabel[1].trim(), context.currentReference);
      }
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
  const createContext = (labels = new Map<string, string>()): ParseContext => ({
    macros: macroDocument.macros,
    theorems: new Map([...theoremDocument.theorems].map(([name, theorem]) => [
      name,
      { title: theorem.title, nextNumber: 1 }
    ])),
    labels,
    graphics,
    footnotes: [],
    metadata: document.metadata,
    chapterNumber: 0,
    sectionNumber: 0,
    subsectionNumber: 0,
    equationNumber: 1,
    figureNumber: 0,
    currentReference: "",
    currentSourceLine: 0,
    quoteDepth: 0,
    tikzNumber: 0
  });
  const collectionContext = createContext();
  parseBlocks(document.source, collectionContext);
  const context = createContext(collectionContext.labels);
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
