export function normalizeGraphicPath(filename: string): string {
  return filename.replace(/\\/g, "/").replace(/^\.\//, "").trim().toLowerCase();
}
