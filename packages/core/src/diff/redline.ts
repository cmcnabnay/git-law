import { diffLines, diffWordsWithSpace, type Change } from "diff";

export interface RedlineDiff {
  changes: Change[];
  stats: { added: number; removed: number };
}

function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Word-level diff over plain text extracted from each docx version.
 *
 * Deliberately diffs plain text rather than mammoth's generated HTML:
 * diffing HTML word-by-word risks tearing markup across change boundaries
 * (e.g. an opening <strong> landing only in one diff chunk), producing
 * broken markup. Formatting-level changes (bold/tables/styles) are not
 * shown as diff markup as a result — a separate "formatted view" of each
 * version (see docxToHtml) is offered alongside this as a complement.
 *
 * Diffing is done in two passes: paragraphs first (mammoth joins paragraphs
 * with "\n\n", so diffLines effectively aligns paragraph-by-paragraph), then
 * word-level diffing is confined to matched removed/added paragraph pairs.
 * A single flat word-level diff over the whole document lets the LCS match
 * common short words (the, of, a) across unrelated, distant paragraphs,
 * producing a scrambled, interleaved redline. Anchoring on paragraphs first
 * keeps unrelated, unchanged sections untouched and keeps each edited
 * section's words together.
 */
export function computeRedline(oldText: string, newText: string): RedlineDiff {
  const paragraphChanges = diffLines(oldText, newText);
  const changes: Change[] = [];
  const stats = { added: 0, removed: 0 };

  const record = (c: Change) => {
    changes.push(c);
    if (c.added) stats.added += countWords(c.value);
    if (c.removed) stats.removed += countWords(c.value);
  };

  let i = 0;
  while (i < paragraphChanges.length) {
    const chunk = paragraphChanges[i];
    if (!chunk.removed) {
      record(chunk);
      i++;
      continue;
    }

    // A run of removed paragraphs directly followed by a run of added
    // paragraphs is a modified region: pair them up index-by-index and
    // word-diff each pair, so replaced paragraphs stay aligned rather than
    // being matched against whatever paragraph happens to follow.
    const removedRun: Change[] = [];
    while (i < paragraphChanges.length && paragraphChanges[i].removed) {
      removedRun.push(paragraphChanges[i]);
      i++;
    }
    const addedRun: Change[] = [];
    while (i < paragraphChanges.length && paragraphChanges[i].added) {
      addedRun.push(paragraphChanges[i]);
      i++;
    }

    const pairCount = Math.min(removedRun.length, addedRun.length);
    for (let p = 0; p < pairCount; p++) {
      diffWordsWithSpace(removedRun[p].value, addedRun[p].value).forEach(record);
    }
    for (let p = pairCount; p < removedRun.length; p++) record(removedRun[p]);
    for (let p = pairCount; p < addedRun.length; p++) record(addedRun[p]);
  }

  return { changes, stats };
}
