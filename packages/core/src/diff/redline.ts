import { Diff, diffArrays, type Change } from "diff";
import { ROW_START, CELL_SEP } from "./tableMarkers.js";

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

// jsdiff's own word characters (see diffWordsWithSpace), so everything but
// numbers tokenizes exactly as it would there.
const WORD_CHARS =
  "a-zA-Z0-9_\\u{C0}-\\u{FF}\\u{D8}-\\u{F6}\\u{F8}-\\u{2C6}\\u{2C8}-\\u{2D7}\\u{2DE}-\\u{2FF}\\u{1E00}-\\u{1EFF}";

// A number — with its currency sign, thousands separators, decimals and
// percent sign — as one token: "$1,100", "35,000", "12.5%". A plain word
// diff splits "$1,100" into "$", "1", ",", "100", so "$1,100" -> "$900"
// matches up the "$" and renders as "$~~1,100~~900", or worse, matches the
// "100" of one number against another. A changed figure should instead read
// as the whole old amount struck and the whole new amount inserted.
const NUMBER_TOKEN = "[$€£¥]?\\d+(?:[.,]\\d+)*%?";

const numberAwareWordDiff = new Diff();
numberAwareWordDiff.tokenize = (value: string) =>
  value.match(new RegExp(`${NUMBER_TOKEN}|(\\r?\\n)|[${WORD_CHARS}]+|[^\\S\\n\\r]+|[^${WORD_CHARS}]`, "ug")) ?? [];

function diffWordsKeepingNumbers(oldText: string, newText: string): Change[] {
  return numberAwareWordDiff.diff(oldText, newText);
}

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
  const wordDiff = diffWordsKeepingNumbers(oldClause, newClause);
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
//
// Likewise a comma or period between two digits ("35,000", "$1,100.50") is
// a thousands/decimal separator, not a clause boundary — splitting there
// broke every figure into fragments ("35," + "000") that then got diffed
// against unrelated fragments of other numbers.
function isInsideNumber(text: string, i: number): boolean {
  return (text[i] === "," || text[i] === ".") && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "");
}

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
    } else if (bracketDepth === 0 && ",.:;".includes(ch) && !isInsideNumber(text, i)) {
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

function isTableRow(paragraph: string): boolean {
  return paragraph.startsWith(ROW_START);
}

function rowCells(paragraph: string): string[] {
  return paragraph.slice(ROW_START.length).split(CELL_SEP);
}

/** Lays out one table row's per-cell changes between ROW_START / CELL_SEP
 * marker changes, closed by its own "\n\n" change — each marker a
 * standalone unchanged Change, so a renderer can pick the row back apart
 * into cells by value alone (see tableMarkers.ts). */
function rowChanges(cells: Change[][]): Change[] {
  const changes: Change[] = [{ value: ROW_START } as Change];
  cells.forEach((cell, idx) => {
    if (idx > 0) changes.push({ value: CELL_SEP } as Change);
    changes.push(...cell.filter((c) => c.value.length > 0));
  });
  changes.push({ value: "\n\n" } as Change);
  return changes;
}

/** A paragraph that's wholly unchanged, added, or removed. */
function wholeParagraph(paragraph: string, flags: { added?: boolean; removed?: boolean }): Change[] {
  if (isTableRow(paragraph)) {
    return rowChanges(rowCells(paragraph).map((cell) => [{ ...flags, value: cell } as Change]));
  }
  return [{ ...flags, value: withTrailingBreak(paragraph) } as Change];
}

/** A matched old/new paragraph pair whose text differs. Two table rows are
 * diffed cell-by-cell against their positional counterpart, so an edit in
 * one cell can never be matched against text from a neighboring cell. */
function changedParagraph(oldPara: string, newPara: string): Change[] {
  if (isTableRow(oldPara) && isTableRow(newPara)) {
    const oldCells = rowCells(oldPara);
    const newCells = rowCells(newPara);
    const cells: Change[][] = [];
    for (let k = 0; k < Math.max(oldCells.length, newCells.length); k++) {
      const o = oldCells[k] ?? "";
      const n = newCells[k] ?? "";
      cells.push(o === n ? [{ value: o } as Change] : diffParagraph(o, n));
    }
    return rowChanges(cells);
  }
  if (isTableRow(oldPara) || isTableRow(newPara)) {
    return [...wholeParagraph(oldPara, { removed: true }), ...wholeParagraph(newPara, { added: true })];
  }
  const paraChanges = diffParagraph(oldPara, newPara);
  return paraChanges.map((c, idx) =>
    idx === paraChanges.length - 1 ? ({ ...c, value: withTrailingBreak(c.value) } as Change) : c
  );
}

/**
 * Word-level diff over plain text extracted from each docx version.
 *
 * Deliberately diffs plain text rather than mammoth's generated HTML:
 * diffing HTML word-by-word risks tearing markup across change boundaries
 * (e.g. an opening <strong> landing only in one diff chunk), producing
 * broken markup. Formatting-level changes (bold/styles) are not shown as
 * diff markup as a result — a separate "formatted view" of each version
 * (see docxToHtml) is offered alongside this as a complement. Table
 * structure is the exception: each row arrives as its own paragraph with
 * cell markers (see tableMarkers.ts), is diffed cell-by-cell, and comes
 * back out with those markers so it can still be rendered as a table.
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
          wholeParagraph(para, { added: true }).forEach(record);
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
          wholeParagraph(para, {}).forEach(record);
          oldStatus.push("unchanged");
          newStatus.push("unchanged");
        } else {
          changedParagraph(oldPara, para).forEach(record);
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
      changedParagraph(removedParas[p], addedParas[p]).forEach(record);
      oldStatus.push("changed");
      newStatus.push("changed");
    }
    for (let p = pairCount; p < removedParas.length; p++) {
      wholeParagraph(removedParas[p], { removed: true }).forEach(record);
      oldStatus.push("removed");
    }
    for (let p = pairCount; p < addedParas.length; p++) {
      wholeParagraph(addedParas[p], { added: true }).forEach(record);
      newStatus.push("added");
    }
  }

  return { changes, stats, paragraphStatus: { old: oldStatus, new: newStatus } };
}
