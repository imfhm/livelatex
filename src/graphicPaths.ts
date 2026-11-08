import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizeGraphicPath } from "./graphicPathUtils";
const supportedExtensions = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp"];
const svgExtensions = [".svg"];

export async function resolveGraphicFiles(text: string, baseDirectory: string): Promise<Record<string, string>> {
  const searchDirectories = [""];
  for (const graphicspath of text.matchAll(/\\graphicspath\s*\{((?:\s*\{[^{}]*\}\s*)+)\}/g)) {
    for (const directory of graphicspath[1].matchAll(/\{([^{}]*)\}/g)) {
      searchDirectories.push(directory[1].trim());
    }
  }

  const resources: Record<string, string> = {};
  const includePattern = /\\(includegraphics|includesvg)\*?(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g;
  for (const include of text.matchAll(includePattern)) {
    const command = include[1];
    const filename = include[2].trim();
    if (!filename || path.isAbsolute(filename)) {
      continue;
    }

    const requestedExtension = path.extname(filename);
    const extensions = command === "includesvg" ? svgExtensions : supportedExtensions;
    for (const directory of searchDirectories) {
      if (path.isAbsolute(directory)) {
        continue;
      }
      const basePath = path.resolve(baseDirectory, directory, filename);
      const candidates = requestedExtension
        ? extensions.includes(requestedExtension.toLowerCase()) ? [basePath] : []
        : extensions.map((extension) => `${basePath}${extension}`);
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
        resources[normalizeGraphicPath(filename)] = found;
        break;
      }
    }
  }
  return resources;
}
