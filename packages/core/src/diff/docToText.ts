import WordExtractor from "word-extractor";

const extractor = new WordExtractor();

/** Extracts plain text from a legacy binary .doc file (pre-2007 OLE format).
 * Pure JS — no LibreOffice/Word install required. */
export async function legacyDocBufferToText(buf: Buffer): Promise<string> {
  const doc = await extractor.extract(buf);
  return doc.getBody();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** .doc carries no structured formatting we can recover, so the "formatted"
 * view for it is just one <p> per line — plain text, no bold/tables/styles. */
export function textToParagraphHtml(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `<p>${escapeHtml(line) || "&nbsp;"}</p>`)
    .join("");
}
