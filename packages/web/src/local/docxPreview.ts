import mammoth from "mammoth";

const PREVIEWABLE_EXTENSIONS = [".docx"];

/** Only .docx renders inline — mammoth doesn't read the legacy binary .doc
 * format at all (that needs `word-extractor`, a Node-only library the
 * server uses for the Remote tab; porting it to the browser is more than
 * this needs right now). */
export function isPreviewableDocument(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return PREVIEWABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Converts a .docx file's bytes to HTML entirely client-side — the same
 * mammoth conversion the server runs for the Remote tab's preview, run
 * here instead because a Local-tab file lives only in the folder the user
 * picked via File System Access and is never uploaded anywhere. */
export async function docxBytesToHtml(bytes: Uint8Array): Promise<string> {
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  return value;
}
