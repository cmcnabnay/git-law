import { diffArrays, diffLines, diffWordsWithSpace, type Change } from "diff";

export interface RedlineDiff {
  changes: Change[];
  stats: { added: number; removed: number };
}

function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

// Below this fraction of matched words, a clause counts as replaced by an
// unrelated one rather than lightly edited (see wordDiffOrReplace below).
const REWRITE_THRESHOLD = 0.4;

/**
 * Word-diffs a changed clause pair, but falls back to a plain whole-clause
 * replacement when the two are mostly dissimilar.
 *
 * LCS word diffing matches any common word wherever it recurs, including
 * short filler words ("the", "to", "with") that show up regardless of what
 * changed. For a lightly edited clause that's exactly what you want (see
 * the "TWO years" test) — but for two clauses that just happen to share a
 * few words while saying different things, it produces a scrambled diff
 * that doesn't read as a real edit. A real legal redline instead shows the
 * old clause struck through as a block, then the new clause inserted as a
 * block, once two clauses are mostly unrelated rather than a light edit of
 * one another.
 */
function wordDiffOrReplace(oldClause: string, newClause: string): Change[] {
  const wordDiff = diffWordsWithSpace(oldClause, newClause);
  const oldWords = countWords(oldClause);
  const newWords = countWords(newClause);
  const unchangedWords = wordDiff
    .filter((c) => !c.added && !c.removed)
    .reduce((sum, c) => sum + countWords(c.value), 0);
  const similarity = unchangedWords / Math.max(oldWords, newWords, 1);

  if (similarity < REWRITE_THRESHOLD) {
    return [
      { removed: true, value: oldClause } as Change,
      { added: true, value: newClause } as Change,
    ];
  }
  return wordDiff;
}

// Splits on , . : ; keeping each delimiter attached to the clause it ends,
// along with a trailing quote (a closing quote right after the punctuation
// belongs with the clause that precedes it, e.g. `confidential,"` — that's
// just how a quoted term is closed before a comma) and any trailing spaces
// or tabs — but deliberately NOT a newline, so mammoth's paragraph-joining
// "\n\n" can't get swallowed into the last clause and force a line break
// between two clauses that are otherwise meant to render inline (it instead
// falls out as its own trailing whitespace-only "clause", which matches
// identically on both sides and so never affects rendering). Concatenating
// the pieces back together reproduces the original text exactly.
function splitClauses(text: string): string[] {
  return text.match(/[^,.:;]*[,.:;]+["']?[ \t]*|[^,.:;]+$/g) ?? [text];
}

// Two clauses count as the same for matching purposes even if only their
// boundary punctuation differs (e.g. "...course." vs "...course," when a
// clause that used to end a sentence now continues into a new one) — the
// rendered value still keeps each clause's own exact original punctuation;
// this only affects whether diffArrays treats them as an unchanged match.
function normalizeForCompare(clause: string): string {
  return clause.trim().replace(/[,.:;]+["']?$/, "").trim();
}

/**
 * Diffs a changed paragraph pair at clause granularity before falling back
 * to word-level diffing within a matched pair of clauses.
 *
 * A flat word diff over the whole paragraph lets LCS match short recurring
 * words ("the", "to", "with") between two clauses that aren't actually
 * related to each other, mashing unrelated sentences together into a
 * scrambled redline. Diffing clause-by-clause first (splitting on the
 * punctuation that actually separates clauses in legal text: , . : ;) keeps
 * identical clauses — including boilerplate that surrounds a rewritten
 * sentence — untouched, and only ever compares a clause against its
 * positional counterpart, via wordDiffOrReplace's rewrite threshold: a
 * lightly edited clause still gets a precise word diff, while a wholly
 * different one reads as a clean strikethrough+insert instead of a word
 * salad of coincidentally shared words.
 */
function diffParagraph(oldParagraph: string, newParagraph: string): Change[] {
  const clauseChanges = diffArrays(splitClauses(oldParagraph), splitClauses(newParagraph), {
    comparator: (a, b) => normalizeForCompare(a) === normalizeForCompare(b),
  });
  const changes: Change[] = [];

  let i = 0;
  while (i < clauseChanges.length) {
    const chunk = clauseChanges[i];
    if (!chunk.removed) {
      changes.push({ added: chunk.added, value: (chunk.value as string[]).join("") } as Change);
      i++;
      continue;
    }

    const removedText = (chunk.value as string[]).join("");
    const next = clauseChanges[i + 1];
    if (next?.added) {
      changes.push(...wordDiffOrReplace(removedText, (next.value as string[]).join("")));
      i += 2;
    } else {
      changes.push({ removed: true, value: removedText } as Change);
      i++;
    }
  }
  return changes;
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
 * Diffing is done in three passes, each anchored on the one before it so a
 * flat LCS never gets the chance to match content across unrelated regions:
 * paragraphs first (mammoth joins paragraphs with "\n\n", so diffLines
 * effectively aligns paragraph-by-paragraph), then clauses within a matched
 * removed/added paragraph pair (see diffParagraph), then words within a
 * matched pair of clauses (see wordDiffOrReplace).
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
      diffParagraph(removedRun[p].value, addedRun[p].value).forEach(record);
    }
    for (let p = pairCount; p < removedRun.length; p++) record(removedRun[p]);
    for (let p = pairCount; p < addedRun.length; p++) record(addedRun[p]);
  }

  return { changes, stats };
}
