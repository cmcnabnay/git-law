import { Diff, diffArrays, type Change } from "diff";
import { ROW_START, CELL_SEP } from "./tableMarkers.js";

export type ParagraphStatus = "unchanged" | "changed" | "removed" | "added";

// How finely a changed paragraph is broken up before its pieces are paired
// and word-diffed (see diffParagraph): "clause" splits on , . : ; while
// "sentence" splits only on sentence ends (. ? !) plus the ; and : that
// legal drafting uses to run a list inside one sentence — "the following
// events: (i) acts of God; (ii) flood, fire...;" — so each list item is
// compared as a unit without commas breaking it into fragments.
export type RedlineGranularity = "clause" | "sentence";

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

// ---------------------------------------------------------------------------
// Sentence mode: grouped edits instead of word-by-word alternation.
//
// The word tokenizer keeps each space as its own token, so a plain word diff
// of "in its sole discretion" -> "with Buyer's prior written consent"
// matches every space and renders as in|with its|Buyer's sole|prior... —
// alternating struck and inserted words that read as nothing. A lawyer's
// redline instead shows the replaced words struck together, then the new
// words inserted together, anchored on the text that really stayed put.

// Below this fraction of words kept after grouping, a sentence reads as
// rewritten rather than edited, and is shown as struck-then-inserted whole.
const SENTENCE_REWRITE_THRESHOLD = 0.5;

// A rewritten sentence still keeps an unchanged opening or ending of at
// least this many words (e.g. "Buyer shall perform its obligations under
// this Agreement") outside the struck/inserted block; anything shorter is
// folded in so the block reads as one whole sentence.
const KEEP_EDGE_WORDS = 3;

type Piece = { kind: "same"; value: string } | { kind: "edit"; removed: string; added: string };

function toPieces(changes: Change[]): Piece[] {
  const pieces: Piece[] = [];
  for (const c of changes) {
    if (!c.added && !c.removed) {
      pieces.push({ kind: "same", value: c.value });
      continue;
    }
    let run = pieces[pieces.length - 1];
    if (run?.kind !== "edit") {
      run = { kind: "edit", removed: "", added: "" };
      pieces.push(run);
    }
    if (c.removed) run.removed += c.value;
    else run.added += c.value;
  }
  return pieces;
}

function editWords(run: { removed: string; added: string }): number {
  return countWords(run.removed) + countWords(run.added);
}

/** Whether unchanged text sitting between two edits is too slight to anchor
 * on — whitespace or punctuation, or one lone word between two edits that
 * each change real words (the "Buyer" in "for any reason Buyer fails to
 * accept" -> "Buyer's material, uncured breach prevents") — and so belongs
 * inside one combined edit rather than splitting it in two. */
function isWeakAnchor(value: string, before: { removed: string; added: string }, after: { removed: string; added: string }) {
  const words = countWords(value);
  return words === 0 || (words === 1 && editWords(before) > 0 && editWords(after) > 0);
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/** Merges edits separated only by weak anchors into one struck run and one
 * inserted run. */
function groupEdits(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (let k = 0; k < pieces.length; k++) {
    const piece = pieces[k];
    const prev = out[out.length - 1];
    if (piece.kind === "edit") {
      if (prev?.kind === "edit") {
        prev.removed += piece.removed;
        prev.added += piece.added;
      } else {
        out.push({ ...piece });
      }
      continue;
    }
    const next = pieces[k + 1];
    if (prev?.kind === "edit" && next?.kind === "edit" && isWeakAnchor(piece.value, prev, next)) {
      prev.removed += piece.value;
      prev.added += piece.value;
      continue;
    }
    // An edit that opened a parenthesis on both sides — "five (5" ->
    // "twenty (20" — takes the matching ")" too, so it reads "five (5)"
    // -> "twenty (20)" rather than leaving the closer stranded outside.
    let value = piece.value;
    if (prev?.kind === "edit") {
      for (const [open, close] of [["(", ")"], ["[", "]"]]) {
        while (
          value.startsWith(close) &&
          count(prev.removed, open) > count(prev.removed, close) &&
          count(prev.added, open) > count(prev.added, close)
        ) {
          prev.removed += close;
          prev.added += close;
          value = value.slice(1);
        }
      }
    }
    if (value) out.push({ kind: "same", value });
  }
  return out;
}

function piecesToChanges(pieces: Piece[]): Change[] {
  const changes: Change[] = [];
  for (const piece of pieces) {
    if (piece.kind === "same") {
      changes.push({ value: piece.value } as Change);
      continue;
    }
    if (piece.removed) changes.push({ removed: true, value: piece.removed } as Change);
    if (piece.added) changes.push({ added: true, value: piece.added } as Change);
  }
  return changes;
}

/** A rewritten sentence: struck whole, then inserted whole, keeping only a
 * substantial unchanged opening/ending (see KEEP_EDGE_WORDS) outside. */
function wholeSentenceReplace(pieces: Piece[]): Change[] {
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  const keepFirst = first?.kind === "same" && countWords(first.value) >= KEEP_EDGE_WORDS;
  const keepLast = pieces.length > 1 && last?.kind === "same" && countWords(last.value) >= KEEP_EDGE_WORDS;
  const middle = pieces.slice(keepFirst ? 1 : 0, keepLast ? -1 : undefined);
  const removed = middle.map((p) => (p.kind === "same" ? p.value : p.removed)).join("");
  const added = middle.map((p) => (p.kind === "same" ? p.value : p.added)).join("");
  return piecesToChanges([
    ...(keepFirst ? [first] : []),
    { kind: "edit", removed, added },
    ...(keepLast ? [last] : []),
  ]);
}

/** Sentence-mode counterpart of wordDiffOrReplace: word-diffs a matched
 * sentence pair, groups the result into whole struck/inserted runs, and
 * falls back to replacing the sentence whole when too little survives —
 * returning null when nothing at all is kept, so the caller can fold the
 * pair into the surrounding struck/inserted blocks (see diffSentenceRun). */
function groupedSentenceDiff(oldSentence: string, newSentence: string): Change[] | null {
  const pieces = groupEdits(toPieces(diffWordsKeepingNumbers(oldSentence, newSentence)));
  const keptWords = pieces.reduce((sum, p) => sum + (p.kind === "same" ? countWords(p.value) : 0), 0);
  const similarity = keptWords / Math.max(countWords(oldSentence), countWords(newSentence), 1);
  if (similarity >= SENTENCE_REWRITE_THRESHOLD) return piecesToChanges(pieces);
  const replaced = wholeSentenceReplace(pieces);
  return replaced.some((c) => !c.added && !c.removed) ? replaced : null;
}

/** Diffs a run of changed sentences: pairs them by content, word-diffs each
 * pair, and shows everything else — unpaired sentences and pairs rewritten
 * outright — as one struck block followed by one inserted block between
 * the pairs that did keep something in common. */
function diffSentenceRun(olds: string[], news: string[]): Change[] {
  const changes: Change[] = [];
  let removed = "";
  let added = "";
  const flush = () => {
    if (removed) changes.push({ removed: true, value: removed } as Change);
    if (added) changes.push({ added: true, value: added } as Change);
    removed = added = "";
  };
  for (const pair of alignByContent(olds, news)) {
    const diff = pair.old !== undefined && pair.new !== undefined ? groupedSentenceDiff(pair.old, pair.new) : null;
    if (diff) {
      flush();
      changes.push(...diff);
    } else {
      removed += pair.old ?? "";
      added += pair.new ?? "";
    }
  }
  flush();
  return changes;
}

// Short words that every sentence shares, ignored when judging whether two
// sentences or paragraphs are about the same thing (see contentSimilarity).
const FILLER_WORDS = new Set([
  "the", "and", "any", "for", "not", "all", "its", "this", "that", "with", "such", "shall", "may", "from", "under",
  "upon", "other", "which", "will", "are", "was", "has", "have", "been", "their", "these", "those", "into", "within",
]);

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !FILLER_WORDS.has(w));
}

/** Dice similarity of two texts' content words, 0..1. Two pieces with no
 * content words at all — a paragraph number "12. ", a "(a) " label — count
 * as the same kind of thing so they still pair up with each other. */
function contentSimilarity(a: string, b: string): number {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (wa.length === 0 || wb.length === 0) return wa.length === wb.length ? 1 : 0;
  const counts = new Map<string, number>();
  for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of wb) {
    const n = counts.get(w) ?? 0;
    if (n > 0) {
      common++;
      counts.set(w, n - 1);
    }
  }
  return (2 * common) / (wa.length + wb.length);
}

// Minimum contentSimilarity for a removed and an added sentence/paragraph to
// be diffed against each other rather than shown as a whole removal plus a
// whole insertion.
const PAIRING_THRESHOLD = 0.3;

type Aligned = { old: string; new: string } | { old: string; new?: undefined } | { old?: undefined; new: string };

/**
 * Pairs a run of removed items with a run of added ones by content rather
 * than by position: the in-order pairing with the greatest total similarity
 * (an LCS weighted by contentSimilarity), where only pairs at or above
 * PAIRING_THRESHOLD may match. Pairing by position instead is what diffed
 * an old "Compliance with Law" paragraph against a new "Termination" one
 * just because an earlier paragraph had been deleted. Between matched
 * pairs, every unmatched removed item comes before every unmatched added
 * one, so a replaced passage reads as one struck block then one inserted
 * block instead of alternating red and green.
 */
function alignByContent(olds: string[], news: string[]): Aligned[] {
  const sim = olds.map((o) => news.map((n) => contentSimilarity(o, n)));
  const best = Array.from({ length: olds.length + 1 }, () => new Array<number>(news.length + 1).fill(0));
  for (let a = olds.length - 1; a >= 0; a--) {
    for (let b = news.length - 1; b >= 0; b--) {
      const pair = sim[a][b] >= PAIRING_THRESHOLD ? sim[a][b] + best[a + 1][b + 1] : -1;
      best[a][b] = Math.max(best[a + 1][b], best[a][b + 1], pair);
    }
  }

  const out: Aligned[] = [];
  const pendingOld: string[] = [];
  const pendingNew: string[] = [];
  const flush = () => {
    out.push(...pendingOld.splice(0).map((old) => ({ old })), ...pendingNew.splice(0).map((n) => ({ new: n })));
  };
  let a = 0;
  let b = 0;
  while (a < olds.length && b < news.length) {
    if (sim[a][b] >= PAIRING_THRESHOLD && best[a][b] === sim[a][b] + best[a + 1][b + 1]) {
      flush();
      out.push({ old: olds[a++], new: news[b++] });
    } else if (best[a][b] === best[a + 1][b]) {
      pendingOld.push(olds[a++]);
    } else {
      pendingNew.push(news[b++]);
    }
  }
  pendingOld.push(...olds.slice(a));
  pendingNew.push(...news.slice(b));
  flush();
  return out;
}

type ArrayChunk = { added?: boolean; removed?: boolean; value: string[] };

/** Collects the maximal run of consecutive added/removed chunks starting at
 * index i — diffArrays can emit one changed passage as added, removed,
 * added — so the whole run is aligned at once (see alignByContent). */
function collectChangedRun(chunks: ArrayChunk[], i: number): { olds: string[]; news: string[]; next: number } {
  const olds: string[] = [];
  const news: string[] = [];
  while (i < chunks.length && (chunks[i].added || chunks[i].removed)) {
    (chunks[i].removed ? olds : news).push(...chunks[i].value);
    i++;
  }
  return { olds, news, next: i };
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

// Words that end in a period without ending the sentence. Checked
// lowercase, without the trailing period. Dotted forms like "e.g", "U.S" or
// "L.L.C" don't need listing — any run of single letters joined by periods
// is treated as an abbreviation (see isAbbreviation).
const NON_TERMINAL_ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "hon", "st", "no", "nos", "sec", "secs", "art", "arts", "para", "paras",
  "cl", "sch", "ex", "exh", "fig", "p", "pp", "vol", "ch", "cf", "vs", "v", "viz", "approx", "al", "id",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

// Abbreviations that often do close a sentence ("...between Acme Inc. The
// parties agree"), so they only count as a sentence end when the next word
// starts with a capital letter.
const MAYBE_TERMINAL_ABBREVIATIONS = new Set([
  "inc", "ltd", "co", "corp", "llc", "llp", "lp", "plc", "jr", "sr", "etc", "esq",
]);

function wordBefore(text: string, i: number): string {
  let start = i;
  while (start > 0 && /[\p{L}.]/u.test(text[start - 1])) start--;
  return text.slice(start, i);
}

function isAbbreviation(word: string): boolean {
  return /^(?:\p{L}\.)*\p{L}$/u.test(word) || NON_TERMINAL_ABBREVIATIONS.has(word.toLowerCase());
}

// "Exhibit A." / "Schedule B." — a lone letter naming a document part, not
// a person's initial, so it can end a sentence like any other word.
const LETTERED_REFERENCE = /\b(?:exhibit|schedule|annex|appendix|attachment|article|section|part|clause|paragraph|rider|tab)\s+\p{L}$/iu;

const SENTENCE_CLOSERS = "\"'\u201D\u2019)";

/**
 * Whether the "." at text[i] ends a sentence — not every one does: a
 * decimal or section number ("2.5", "Section 3.1"), an abbreviation ("e.g.",
 * "No. 5", "U.S."), an initial ("J. Smith"), or a period followed straight
 * by more punctuation ("Inc.,") or a lowercase word ("etc. and") all leave
 * the sentence running. A period only ends one when it's followed (after
 * any closing quote or parenthesis) by whitespace or the end of the text.
 */
function isSentenceEndingPeriod(text: string, i: number): boolean {
  if (isInsideNumber(text, i)) return false;
  let j = i + 1;
  while (j < text.length && SENTENCE_CLOSERS.includes(text[j])) j++;
  if (j < text.length && !/\s/.test(text[j])) return false;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (j >= text.length) return true;

  const next = text[j];
  if (/\p{Ll}/u.test(next)) return false;

  const word = wordBefore(text, i);
  // A paragraph number ("5. ") that htmlToNumberedText prefixed — splitting
  // it off matches clause mode, where it's the paragraph's first clause.
  if (word === "") return true;
  if (word.length === 1 && LETTERED_REFERENCE.test(text.slice(Math.max(0, i - 20), i))) return true;
  if (isAbbreviation(word)) return false;
  if (MAYBE_TERMINAL_ABBREVIATIONS.has(word.toLowerCase())) return /\p{Lu}/u.test(next);
  return true;
}

/**
 * Splits text into sentences, where a sentence ends at . ? ! — or at ; or :,
 * which in contracts separate the items of a list run inside one sentence.
 * Like splitClauses, each piece keeps its terminator plus any closing quotes
 * or parentheses and trailing spaces (never a newline), bracketed
 * placeholders are never split, and joining the pieces reproduces the text.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") {
      bracketDepth++;
      continue;
    }
    if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (bracketDepth > 0) continue;

    let isBoundary: boolean;
    if (ch === ".") isBoundary = isSentenceEndingPeriod(text, i);
    else if (ch === ":") isBoundary = !(/\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")); // "10:30"
    else isBoundary = "?!;".includes(ch);
    if (!isBoundary) continue;

    let end = i + 1;
    // Absorb a run of terminators ("?!", "...") into the same sentence.
    while (end < text.length && ".?!".includes(text[end])) end++;
    while (end < text.length && SENTENCE_CLOSERS.includes(text[end])) end++;
    while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
    sentences.push(text.slice(start, end));
    start = end;
    i = end - 1;
  }
  if (start < text.length) sentences.push(text.slice(start));
  return sentences.length ? sentences : [text];
}

// Two clauses count as the same for matching purposes even if only their
// boundary punctuation differs (e.g. "...course." vs "...course," when a
// clause that used to end a sentence now continues into a new one) — the
// rendered value still keeps each clause's own exact original punctuation;
// this only affects whether diffArrays treats them as an unchanged match.
function normalizeForCompare(clause: string): string {
  return clause.trim().replace(/[,.:;]+["'\u201D\u2019]?$/, "").trim();
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
 *
 * With granularity "sentence" the same pairing runs over whole sentences
 * (and ;/: list items) instead — see splitSentences.
 */
function diffParagraph(oldParagraph: string, newParagraph: string, granularity: RedlineGranularity): Change[] {
  const split = granularity === "sentence" ? splitSentences : splitClauses;
  const clauseChanges = diffArrays(split(oldParagraph), split(newParagraph), {
    comparator: (a, b) => normalizeForCompare(a) === normalizeForCompare(b),
  });
  const changes: Change[] = [];

  let i = 0;
  while (i < clauseChanges.length) {
    const chunk = clauseChanges[i];
    if (granularity === "sentence" && (chunk.added || chunk.removed)) {
      const run = collectChangedRun(clauseChanges, i);
      i = run.next;
      changes.push(...diffSentenceRun(run.olds, run.news));
      continue;
    }
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
function changedParagraph(oldPara: string, newPara: string, granularity: RedlineGranularity): Change[] {
  if (isTableRow(oldPara) && isTableRow(newPara)) {
    const oldCells = rowCells(oldPara);
    const newCells = rowCells(newPara);
    const cells: Change[][] = [];
    for (let k = 0; k < Math.max(oldCells.length, newCells.length); k++) {
      const o = oldCells[k] ?? "";
      const n = newCells[k] ?? "";
      cells.push(o === n ? [{ value: o } as Change] : diffParagraph(o, n, granularity));
    }
    return rowChanges(cells);
  }
  if (isTableRow(oldPara) || isTableRow(newPara)) {
    return [...wholeParagraph(oldPara, { removed: true }), ...wholeParagraph(newPara, { added: true })];
  }
  const paraChanges = diffParagraph(oldPara, newPara, granularity);
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
 * paragraphs first, then clauses (or sentences, per granularity) within a
 * matched removed/added paragraph pair (see diffParagraph), then words
 * within a matched pair of clauses (see wordDiffOrReplace).
 */
export function computeRedline(
  oldText: string,
  newText: string,
  granularity: RedlineGranularity = "clause"
): RedlineDiff {
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
    if (granularity === "sentence" && (chunk.added || chunk.removed)) {
      const run = collectChangedRun(paragraphChanges, i);
      i = run.next;
      for (const pair of alignByContent(run.olds, run.news)) {
        if (pair.old !== undefined && pair.new !== undefined) {
          changedParagraph(pair.old, pair.new, granularity).forEach(record);
          oldStatus.push("changed");
          newStatus.push("changed");
        } else if (pair.old !== undefined) {
          wholeParagraph(pair.old, { removed: true }).forEach(record);
          oldStatus.push("removed");
        } else {
          wholeParagraph(pair.new, { added: true }).forEach(record);
          newStatus.push("added");
        }
      }
      continue;
    }
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
          changedParagraph(oldPara, para, granularity).forEach(record);
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
      changedParagraph(removedParas[p], addedParas[p], granularity).forEach(record);
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
