export function escapeHtml(text: string): string {
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



export function findUnescaped(source: string, needle: string, start: number): number {
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



export function isSafeCssColor(color: string): boolean {
  return /^(?:#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d.%\s,]+\)|hsla?\([\d.%\s,deg]+\))$/i.test(color);
}



export function readGroup(source: string, openingBrace: number): { content: string; end: number } | undefined {
  if (source[openingBrace] !== "{") {
    return undefined;
  }
  const closingBrace = findClosingBrace(source, openingBrace + 1);
  return closingBrace === -1
    ? undefined
    : { content: source.slice(openingBrace + 1, closingBrace), end: closingBrace + 1 };
}



export function stripComment(line: string): string {
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



export function findClosingBrace(source: string, start: number): number {
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



export function skipWhitespace(source: string, start: number): number {
  while (/\s/.test(source[start] ?? "")) {
    start += 1;
  }
  return start;
}
