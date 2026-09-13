import { readBlob } from "../git/show.js";
import { changedFiles } from "../git/changedFiles.js";
import { readWordDocument, isSupportedDocument } from "./wordDocument.js";
import { computeRedline, type RedlineDiff } from "./redline.js";

export interface FileDiff {
  path: string;
  redline: RedlineDiff;
  oldHtml: string | null;
  newHtml: string | null;
}

async function safeReadDocument(barePath: string, rev: string, filePath: string) {
  try {
    const buf = readBlob(barePath, rev, filePath);
    const { text, html } = await readWordDocument(buf, filePath);
    return { text, html };
  } catch {
    // file didn't exist at this revision (e.g. newly added file)
    return { text: "", html: null };
  }
}

export async function computeFileDiff(
  barePath: string,
  baseSha: string,
  headSha: string,
  filePath: string
): Promise<FileDiff> {
  const [oldVersion, newVersion] = await Promise.all([
    safeReadDocument(barePath, baseSha, filePath),
    safeReadDocument(barePath, headSha, filePath),
  ]);
  return {
    path: filePath,
    redline: computeRedline(oldVersion.text, newVersion.text),
    oldHtml: oldVersion.html,
    newHtml: newVersion.html,
  };
}

export async function computePrDiff(barePath: string, baseSha: string, headSha: string): Promise<FileDiff[]> {
  const paths = changedFiles(barePath, baseSha, headSha).filter(isSupportedDocument);
  return Promise.all(paths.map((p) => computeFileDiff(barePath, baseSha, headSha, p)));
}
