import { docxBufferToHtml } from "./docxToHtml.js";
import { legacyDocBufferToText, textToParagraphHtml } from "./docToText.js";
import { htmlToNumberedText } from "./numberedText.js";

export const SUPPORTED_EXTENSIONS = [".docx", ".doc"];

export function isSupportedDocument(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface WordDocument {
  text: string;
  html: string;
}

/** Reads a Word document buffer (either modern .docx or legacy .doc) into
 * plain text (used for the redline diff) and HTML (used for the formatted
 * preview view). Dispatches on file extension since the two formats need
 * completely different parsers. */
export async function readWordDocument(buf: Buffer, filePath: string): Promise<WordDocument> {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".docx")) {
    const html = await docxBufferToHtml(buf);
    // Derived from the same HTML the Formatted view renders (rather than a
    // separate mammoth.extractRawText call) so a numbered paragraph carries
    // its number here too — plain-text extraction otherwise drops Word list
    // numbering entirely, since it's list markup, not run text.
    return { text: htmlToNumberedText(html), html };
  }
  if (lower.endsWith(".doc")) {
    const text = await legacyDocBufferToText(buf);
    return { text, html: textToParagraphHtml(text) };
  }
  throw new Error(`Unsupported document format: ${filePath}`);
}
