export interface PreviewBlock {
  key: string;
  type: string;
  source: string;
  sourceLine: number;
  html: string;
}

export interface RawBlock {
  type: string;
  source: string;
  sourceLine: number;
  html: string;
}

export interface TheoremDefinition {
  title: string;
  nextNumber: number;
  style: "plain" | "definition" | "remark";
}

export interface DocumentMetadata {
  title: string;
  author: string;
  date: string;
  institute: string;
}

export interface ParseContext {
  macros: Record<string, string>;
  theorems: Map<string, TheoremDefinition>;
  graphics: Record<string, string>;
  footnotes: { number: number; html: string; sourceLine: number }[];
  metadata: DocumentMetadata;
  chapterNumber: number;
  sectionNumber: number;
  subsectionNumber: number;
  equationNumber: number;
  figureNumber: number;
  currentSourceLine: number;
  currentOverlay: number;
  quoteDepth: number;
  beamerLayout: boolean;
}
