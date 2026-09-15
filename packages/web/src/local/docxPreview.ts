import mammoth from "mammoth";
// Deep import, not the package's own index — that barrel also re-exports
// Node-only modules (better-sqlite3, fs-based config, etc.) that would
// break the browser bundle. This one file only imports node-html-parser,
// which is browser-safe.
import { fixOrderedListNumbering } from "@gitlaw/core/src/diff/numberedText.js";

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
 * picked via File System Access and is never uploaded anywhere.
 *
 * Vite resolves mammoth's own "browser" package.json field for us, which
 * swaps in a build whose `unzip` only recognizes an `arrayBuffer` option —
 * the Node build's `buffer` option (what @gitlaw/core's server-side
 * equivalent uses) throws "Could not find file in options" here instead. */
export async function docxBytesToHtml(bytes: Uint8Array): Promise<string> {
  const { value } = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer });
  return fixOrderedListNumbering(value);
}
