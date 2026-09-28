// Control characters that can't occur in real document text, used to carry
// table structure through the plain-text redline pipeline. A table row
// becomes one "paragraph" whose text starts with ROW_START and separates its
// cells with CELL_SEP (see htmlToNumberedText); computeRedline then emits
// each of these as its own unchanged Change, so a renderer can rebuild the
// row as a real <tr>/<td> instead of one run-on line of text.
//
// Kept in its own dependency-free module so the web bundle can import it
// without pulling in the rest of @gitlaw/core.
export const ROW_START = "\u001E";
export const CELL_SEP = "\u001F";
