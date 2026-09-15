import mammoth from "mammoth";
import { fixOrderedListNumbering } from "./numberedText.js";

export async function docxBufferToHtml(buf: Buffer): Promise<string> {
  const { value } = await mammoth.convertToHtml({ buffer: buf });
  return fixOrderedListNumbering(value);
}
