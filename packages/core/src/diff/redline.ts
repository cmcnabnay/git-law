import { diffArrays, diffWordsWithSpace, type Change } from "diff";

export type ParagraphStatus = "unchanged" | "changed" | "removed" | "added";

export interface RedlineDiff {
  changes: Change[];
  stats: { added: number; removed: number };
  // Per-paragraph status, in document order, for the old and new side
  // respectively — e.g. paragraphStatus.old[3] describes the 4th paragraph
  // of the old document. Lets a consumer (see annotateParagraphHtml) mark up
  // the corresponding block element in each side's rendered HTML.
  paragraphStatus: { old: ParagraphStatus[]; new: ParagraphStatus[] };
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
//
// Punctuation inside a bracketed placeholder — `[Data Center, LLC]`, `[2722
// Travis, Houston TX 77002]` — is never a clause boundary: it's part of one
// blank being filled in, not a separator between clauses. Splitting there
// anyway is exactly what broke a fill-in-the-blank paragraph: a value with
// its own internal comma turns one old clause into several new ones, and
// that clause-count mismatch is what made the pairing below match unrelated
// fragments against each other. A plain non-regex scan (rather than trying
// to teach the regex about bracket depth) tracks whether each character
// falls inside `[...]` and only treats , . : ; as delimiters outside it.
function splitClauses(text: string): string[] {
  const clauses: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") {
      bracketDepth++;
    } else if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (bracketDepth === 0 && ",.:;".includes(ch)) {
      let end = i + 1;
      if (end < text.length && (text[end] === '"' || text[end] === "'")) end++;
      while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
      clauses.push(text.slice(start, end));
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) clauses.push(text.slice(start));
  return clauses.length ? clauses : [text];
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

    // diffArrays groups every consecutive run of unmatched clauses into one
    // chunk, whose .value can hold several clauses at once (e.g. one old
    // clause splitting into three new ones because a comma got inserted
    // mid-sentence). Pair them up clause-by-clause — the same index-paired
    // pattern computeRedline's own paragraph-level loop uses — rather than
    // joining the whole run into one string and word-diffing that: joining
    // first would feed wordDiffOrReplace a blob spanning multiple unrelated
    // clauses, letting it match words (e.g. "posting of bond or other
    // security") across clauses that aren't actually each other's
    // counterpart, instead of leaving each clause to compare only against
    // its own positional pair (or stand alone as a clean whole add/remove).
    const removedClauses = chunk.value as string[];
    i++;
    const next = clauseChanges[i];
    const addedClauses = next?.added ? (next.value as string[]) : [];
    if (next?.added) i++;

    const pairCount = Math.min(removedClauses.length, addedClauses.length);
    for (let p = 0; p < pairCount; p++) {
      changes.push(...wordDiffOrReplace(removedClauses[p], addedClauses[p]));
    }
    for (let p = pairCount; p < removedClauses.length; p++) {
      changes.push({ removed: true, value: removedClauses[p] } as Change);
    }
    for (let p = pairCount; p < addedClauses.length; p++) {
      changes.push({ added: true, value: addedClauses[p] } as Change);
    }
  }
  return changes;
}

// mammoth (via htmlToNumberedText) joins paragraphs with "\n\n" — split back
// into one entry per paragraph so diffArrays can track real paragraph
// indices (see paragraphStatus), rather than diffLines' line-oriented chunks
// which don't expose how many actual paragraphs a merged run represents.
function splitParagraphs(text: string): string[] {
  return text.split("\n\n").filter((p) => p.length > 0);
}

// htmlToNumberedText prefixes a numbered paragraph with e.g. "5. " — a
// number a browser (re-)computes fresh per side from each version's own
// <ol> nesting, so inserting or removing just one numbered paragraph
// renumbers every one after it on that side. Comparing paragraphs by their
// exact text would then treat every later paragraph as "changed" — or worse,
// pair it with the wrong counterpart — purely because its number shifted,
// even though its actual content didn't. Stripping the number before
// comparing keeps matching anchored on content; the number each side
// actually renders is still what ends up in the output, since it's part of
// the paragraph text itself, only the *comparison* ignores it.
function stripParagraphNumber(paragraph: string): string {
  return paragraph.replace(/^\d+\.\s+/, "");
}

function withTrailingBreak(value: string): string {
  return value + "\n\n";
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
 * paragraphs first, then clauses within a matched removed/added paragraph
 * pair (see diffParagraph), then words within a matched pair of clauses
 * (see wordDiffOrReplace).
 */
export function computeRedline(oldText: string, newText: string): RedlineDiff {
  const oldParagraphs = splitParagraphs(oldText);
  const newParagraphs = splitParagraphs(newText);
  const paragraphChanges = diffArrays(oldParagraphs, newParagraphs, {
    comparator: (a, b) => stripParagraphNumber(a) === stripParagraphNumber(b),
  });

  const changes: Change[] = [];
  const stats = { added: 0, removed: 0 };
  const oldStatus: ParagraphStatus[] = [];
  const newStatus: ParagraphStatus[] = [];

  const record = (c: Change) => {
    changes.push(c);
    if (c.added) stats.added += countWords(c.value);
    if (c.removed) stats.removed += countWords(c.value);
  };

  let i = 0;
  while (i < paragraphChanges.length) {
    const chunk = paragraphChanges[i];
    if (!chunk.removed) {
      // Either genuinely unchanged, or (chunk.added true) a pure insertion
      // with nothing removed at this position — diffArrays reports both the
      // same way (removed: falsy), so chunk.added decides which this is.
      for (const para of chunk.value as string[]) {
        if (chunk.added) {
          record({ value: withTrailingBreak(para), added: true, removed: false } as Change);
          newStatus.push("added");
          continue;
        }

        // A "matched" pair only means the comparator's stripped-of-number
        // content is equal — the two can still differ in their actual
        // number (see stripParagraphNumber), which counts as a real,
        // visible change: without this check, a paragraph renumbered by an
        // insertion or deletion elsewhere would silently show its new
        // number with no indication anything changed, while a paragraph
        // whose content *also* happened to change would (its number is
        // itself the first "clause" diffParagraph sees) — inconsistent.
        const oldPara = oldParagraphs[oldStatus.length];
        if (oldPara === para) {
          record({ value: withTrailingBreak(para), added: false, removed: false } as Change);
          oldStatus.push("unchanged");
          newStatus.push("unchanged");
        } else {
          const paraChanges = diffParagraph(oldPara, para);
          paraChanges.forEach((c, idx) => {
            const isLast = idx === paraChanges.length - 1;
            record({ ...c, value: isLast ? withTrailingBreak(c.value) : c.value } as Change);
          });
          oldStatus.push("changed");
          newStatus.push("changed");
        }
      }
      i++;
      continue;
    }

    // A removed chunk directly followed by an added chunk is a modified
    // region: pair paragraphs up index-by-index and clause-diff each pair,
    // so replaced paragraphs stay aligned rather than being matched against
    // whatever paragraph happens to follow.
    const removedParas = chunk.value as string[];
    i++;
    const next = paragraphChanges[i];
    const addedParas = next?.added ? (next.value as string[]) : [];
    if (next?.added) i++;

    const pairCount = Math.min(removedParas.length, addedParas.length);
    for (let p = 0; p < pairCount; p++) {
      const paraChanges = diffParagraph(removedParas[p], addedParas[p]);
      paraChanges.forEach((c, idx) => {
        const isLast = idx === paraChanges.length - 1;
        record({ ...c, value: isLast ? withTrailingBreak(c.value) : c.value } as Change);
      });
      oldStatus.push("changed");
      newStatus.push("changed");
    }
    for (let p = pairCount; p < removedParas.length; p++) {
      record({ value: withTrailingBreak(removedParas[p]), added: false, removed: true } as Change);
      oldStatus.push("removed");
    }
    for (let p = pairCount; p < addedParas.length; p++) {
      record({ value: withTrailingBreak(addedParas[p]), added: true, removed: false } as Change);
      newStatus.push("added");
    }
  }

  return { changes, stats, paragraphStatus: { old: oldStatus, new: newStatus } };
}
