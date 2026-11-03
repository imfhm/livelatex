# LiveLaTeX

LiveLaTeX is a Visual Studio Code extension for previewing LaTeX as you type. It renders in a webview, reads unsaved editor contents, and updates the existing preview after a short debounce instead of running a full TeX compilation for every edit.

## Development

1. Install Node.js and npm.
2. Run `npm install`.
3. Run `npm run build`.
4. Open this folder in VS Code and press F5 to launch the Extension Development Host.
5. Open a `.tex` file and run **LiveLaTeX: Open Preview** from the Command Palette.

The preview updates after edits without saving. It uses a responsive A4-sized paper background to give equations a document-like layout. Use Ctrl+mousewheel to zoom the paper between 50% and 250%, centered around the pointer; zooming scales the rendered sheet without reflowing its contents. It incrementally updates block elements and supports document titles and numbered chapters/sections, paragraphs, bold, italic, colored text, `\enquote` with nested English-style quotation marks, `\footnote` references with a numbered notes section, and `tikzpicture` environments with common straight paths, circles, rectangles, arrows, and text nodes. TikZ coordinates use centimeter-based physical sizing by default, and picture `scale`, `x`, and `y` options affect the drawing size and proportions. TikZ support is a built-in subset; advanced paths, libraries, and arbitrary TikZ commands are not interpreted. It also supports inline and display math, numbered `figure` environments with captions, and PNG/JPEG/WebP/GIF/SVG/BMP `\includegraphics` from paths relative to the LaTeX file or `\graphicspath` directories (with common width, height, scale, and angle options), itemize/enumerate lists, simple `\newcommand`/`\renewcommand` macros, `\newtheorem` declarations with theorem and proof environments (including display equations inside them), and equation, align, and gather environments with equation numbers and per-row `\nonumber` suppression. The first paragraph in a theorem or proof follows its heading inline. `\label`, `\ref`, and `\eqref` work for supported headings, figures, theorems, and numbered equations, including references inside inline math. Long display equations shrink to fit the text area while reserving room around equation numbers. Ctrl+click a preview block to focus the source editor and jump to the corresponding line (with a text-position estimate for prose). Math is rendered with KaTeX. LaTeX outside this supported subset is not fully interpreted.

Set `livelatex.preview.debounceMs` to adjust the preview delay (150 ms by default).

## PDF compilation

For full TeX compatibility, run **LiveLaTeX: Compile PDF with Tectonic**. Install Tectonic and set `livelatex.tectonic.path` if its executable is not on `PATH`. The command saves a dirty document, starts Tectonic asynchronously, and opens the generated PDF on success. Compilation writes the PDF alongside the source file.
