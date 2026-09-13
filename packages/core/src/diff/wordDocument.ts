import { docxBufferToText, docxBufferToHtml } from "./docxToHtml.js";
import { legacyDocBufferToText, textToParagraphHtml } from "./docToText.js";

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
    const [text, html] = await Promise.all([docxBufferToText(buf), docxBufferToHtml(buf)]);
    return { text, html };
  }
  if (lower.endsWith(".doc")) {
    const text = await legacyDocBufferToText(buf);
    return { text, html: textToParagraphHtml(text) };
  }
  throw new Error(`Unsupported document format: ${filePath}`);
}
