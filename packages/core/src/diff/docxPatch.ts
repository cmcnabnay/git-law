import JSZip from "jszip";
import { diffArrays, diffWordsWithSpace } from "diff";
import { PSEUDO_COLUMN_GAP } from "./tableMarkers.js";

// Writes the Local tab editor's edits back into a .docx's word/document.xml
// in place, instead of regenerating the document from plain text — so every
// paragraph the edit didn't touch keeps its exact XML (styles, numbering,
// bold defined terms), and an edited paragraph keeps its paragraph
// properties and as much of its run formatting as the edit leaves intact.
// Table cells are written back the same way, cell by cell.
//
// Browser-safe: the XML parser is injected (DOMParser in the browser,
// @xmldom/xmldom in tests), and nothing here touches Node APIs.

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

// htmlToNumberedText prefixes a numbered-list paragraph with its rendered
// number ("3. ") — list markup, not run text, so it never appears in the XML.
const LIST_NUMBER_PREFIX = /^\d+\.\s+/;

export interface XmlImpl {
  parse(xml: string): Document;
  serialize(doc: Document): string;
}

const browserXml: XmlImpl = {
  parse: (xml) => new DOMParser().parseFromString(xml, "application/xml"),
  serialize: (doc) => new XMLSerializer().serializeToString(doc),
};

/** What the editor shows, in the shape htmlToNumberedText produces it:
 * body paragraphs (table rows excluded), and every table row in document
 * order as its displayed cells (a cell faking columns with tabs or runs of
 * spaces shows as several — see PSEUDO_COLUMN_GAP). */
export interface EditorContent {
  paragraphs: string[];
  rows: string[][];
}

/**
 * `original` is the document as the editor first showed it, `edited` what
 * it shows now. Returns the .docx with the difference applied.
 */
export async function saveEditsToDocx(
  bytes: Uint8Array,
  original: EditorContent,
  edited: EditorContent,
  xml: XmlImpl = browserXml
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("Not a Word document: word/document.xml is missing");
  const doc = xml.parse(await entry.async("string"));
  applyTableEdits(doc, original.rows, edited.rows);
  applyParagraphEdits(doc, original.paragraphs, edited.paragraphs);
  zip.file("word/document.xml", xml.serialize(doc));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

interface DocParagraph {
  el: Element;
  text: string;
}

interface Mapped {
  el: Element;
  prefix: string; // list number shown in the editor but not stored in the XML
}

export function applyParagraphEdits(doc: Document, original: string[], edited: string[]): void {
  const body = getBody(doc);
  const paragraphs = bodyParagraphs(body);
  const mapping = mapParagraphs(original, paragraphs);

  const need = (i: number): Mapped => {
    const m = mapping[i];
    if (!m) throw new Error(`Couldn't find this paragraph in the Word file to update it: "${truncate(original[i])}"`);
    return m;
  };

  let oi = 0;
  let anchor: Element | null = null; // last paragraph kept or written, for inserting after
  const insert = (text: string) => {
    const template = chooseTemplate(body, anchor, text);
    const p = newParagraph(doc, template, text);
    if (anchor) insertAfter(anchor, p);
    else {
      const firstKept = mapping.find(Boolean)?.el ?? paragraphs[0]?.el;
      if (firstKept) firstKept.parentNode!.insertBefore(p, firstKept);
      else insertBeforeSectPr(body, p);
    }
    anchor = p;
  };

  const chunks = diffArrays(original, edited);
  for (let k = 0; k < chunks.length; k++) {
    const chunk = chunks[k];
    if (!chunk.added && !chunk.removed) {
      for (let n = 0; n < chunk.value.length; n++, oi++) anchor = mapping[oi]?.el ?? anchor;
      continue;
    }
    if (chunk.added) {
      for (const text of chunk.value) insert(text);
      continue;
    }
    // Removed, possibly followed by its replacement. Pair each rewritten
    // paragraph with the one it most resembles, not just the next in line:
    // inserting a section renumbers every section after it, and pairing by
    // position would pour each section's text into its predecessor's
    // paragraph — taking that one's formatting, and leaving whatever sits
    // between paragraphs (tables) under the wrong section.
    const removedStart = oi;
    oi += chunk.value.length;
    const replacements = chunks[k + 1]?.added ? chunks[++k].value : [];
    for (const step of alignBySimilarity(chunk.value, replacements)) {
      if (step.r !== undefined && step.a !== undefined) {
        const m = need(removedStart + step.r);
        const text = replacements[step.a];
        replaceParagraphText(doc, m.el, m.prefix && text.startsWith(m.prefix) ? text.slice(m.prefix.length) : text);
        anchor = m.el;
      } else if (step.r !== undefined) {
        const m = need(removedStart + step.r);
        m.el.parentNode!.removeChild(m.el);
      } else {
        insert(replacements[step.a!]);
      }
    }
  }
}

function getBody(doc: Document): Element {
  const body = doc.getElementsByTagNameNS(W, "body")[0];
  if (!body) throw new Error("word/document.xml has no <w:body>");
  return body;
}

/** Body-level paragraphs in document order: not inside a table (tables
 * are written separately) and not nested inside another paragraph (text
 * boxes). */
function bodyParagraphs(body: Element): DocParagraph[] {
  const out: DocParagraph[] = [];
  const all = body.getElementsByTagNameNS(W, "p");
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    if (hasAncestor(p, body, (a) => a.localName === "tbl" || a.localName === "p")) continue;
    out.push({ el: p, text: paragraphText(p) });
  }
  return out;
}

/** Pairs each editor paragraph with the <w:p> it came from, walking both in
 * order. Paragraphs the editor never showed (empty ones) are skipped over;
 * an editor paragraph with no match (e.g. a footnote mammoth appended) maps
 * to nothing, which is only an error if the user then edits it. */
function mapParagraphs(original: string[], paragraphs: DocParagraph[]): (Mapped | null)[] {
  const result: (Mapped | null)[] = [];
  let cursor = 0;
  for (const text of original) {
    const target = normalize(text);
    const prefix = text.match(LIST_NUMBER_PREFIX)?.[0] ?? "";
    const withoutPrefix = normalize(text.slice(prefix.length));
    let found: Mapped | null = null;
    for (let j = cursor; j < paragraphs.length; j++) {
      const candidate = normalize(paragraphs[j].text);
      if (!candidate) continue;
      if (candidate === target) found = { el: paragraphs[j].el, prefix: "" };
      else if (prefix && candidate === withoutPrefix) found = { el: paragraphs[j].el, prefix };
      if (found) {
        cursor = j + 1;
        break;
      }
    }
    result.push(found);
  }
  return result;
}

// ---- Pairing rewritten paragraphs ----------------------------------------

/** Below this, two paragraphs count as different paragraphs rather than one
 * rewritten: the old one is deleted and the new one inserted. */
const MIN_SIMILARITY = 0.5;

type Step = { r?: number; a?: number };

/** Lines up `removed` with `added` in order, pairing paragraphs that are
 * similar enough (most shared words, ignoring "12." / "(a)" labels) and
 * leaving the rest as deletions and insertions — a weighted LCS. */
function alignBySimilarity(removed: string[], added: string[]): Step[] {
  const R = removed.length;
  const A = added.length;
  const rWords = removed.map(wordCounts);
  const aWords = added.map(wordCounts);
  const sim = (i: number, j: number) => similarity(rWords[i], aWords[j]);
  // best[i][j]: best total similarity aligning removed[i..] with added[j..].
  const best: Float64Array[] = Array.from({ length: R + 1 }, () => new Float64Array(A + 1));
  const simCache: Float64Array[] = Array.from({ length: R }, () => new Float64Array(A));
  for (let i = R - 1; i >= 0; i--) {
    for (let j = A - 1; j >= 0; j--) {
      const s = sim(i, j);
      simCache[i][j] = s;
      const skip = Math.max(best[i + 1][j], best[i][j + 1]);
      best[i][j] = s >= MIN_SIMILARITY ? Math.max(skip, s + best[i + 1][j + 1]) : skip;
    }
  }
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < R || j < A) {
    if (i < R && j < A && simCache[i][j] >= MIN_SIMILARITY && best[i][j] === simCache[i][j] + best[i + 1][j + 1]) {
      steps.push({ r: i++, a: j++ });
    } else if (i < R && (j === A || best[i + 1][j] >= best[i][j + 1])) {
      steps.push({ r: i++ });
    } else {
      steps.push({ a: j++ });
    }
  }
  return steps;
}

function wordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const rest = text.slice(labelOf(text)?.full.length ?? 0);
  for (const w of rest.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

/** Dice coefficient over word multisets. */
function similarity(a: Map<string, number>, b: Map<string, number>): number {
  let total = 0;
  let shared = 0;
  for (const [w, n] of a) {
    total += n;
    shared += Math.min(n, b.get(w) ?? 0);
  }
  for (const n of b.values()) total += n;
  return total === 0 ? 1 : (2 * shared) / total;
}

// ---- Paragraph labels ("12.", "(a)") --------------------------------------

type LabelKind = "number" | "paren-lower" | "paren-upper" | "paren-number" | "dot-lower" | "dot-upper" | "plain";

const LABELS: [LabelKind, RegExp][] = [
  ["number", /^\d+(?:\.\d+)*\.+\s+/],
  ["paren-number", /^\(\d+\)\s*/],
  ["paren-lower", /^\([a-z]{1,4}\)\s*/],
  ["paren-upper", /^\([A-Z]{1,4}\)\s*/],
  ["dot-lower", /^[a-z]\.\s+/],
  ["dot-upper", /^[A-Z]\.\s+/],
];

/** A typed paragraph label at the start of `text` (after any leading
 * whitespace), with the whitespace that follows it. */
function labelOf(text: string): { kind: LabelKind; full: string } | null {
  const lead = text.match(/^\s*/)![0];
  for (const [kind, re] of LABELS) {
    const m = text.slice(lead.length).match(re);
    if (m) return { kind, full: lead + m[0] };
  }
  return null;
}

function kindOfParagraph(p: Element): LabelKind {
  const pPr = childElements(p).find((c) => isW(c, "pPr"));
  if (pPr && childElements(pPr).some((c) => isW(c, "numPr"))) return "number";
  return labelOf(paragraphText(p))?.kind ?? "plain";
}

/** The paragraph a new one should be styled like: one with the same kind
 * of label — so a new "(b)" looks like an "(a)", and a new "13. Heading."
 * like section 12 — nearest to the insertion point, preferring one whose
 * text has the formatting most such paragraphs have (so a new "(b)" isn't
 * bold just because the "(a)" above it is an all-caps bold disclaimer).
 * With no paragraph of that kind, the paragraph it follows. */
function chooseTemplate(body: Element, anchor: Element | null, text: string): Element | null {
  const kind = labelOf(text)?.kind ?? "plain";
  const all = bodyParagraphs(body).filter((p) => p.text.trim());
  const at = anchor ? all.findIndex((p) => p.el === anchor) : -1;
  // Nearest first: walking back from the insertion point, then forward.
  const order = [...all.slice(0, at + 1).reverse(), ...all.slice(at + 1)];
  const sameKind = order.filter((p) => kindOfParagraph(p.el) === kind);
  if (sameKind.length === 0) return anchor ?? all[0]?.el ?? null;
  const counts = new Map<string, number>();
  for (const p of sameKind) counts.set(bodyFormat(p.el), (counts.get(bodyFormat(p.el)) ?? 0) + 1);
  const usual = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  return (sameKind.find((p) => bodyFormat(p.el) === usual) ?? sameKind[0]).el;
}

/** The formatting of a paragraph's text just past its label. */
function bodyFormat(p: Element): string {
  const runs = textRuns(p);
  const text = runs.map(runText).join("");
  const start = labelOf(text)?.full.length ?? text.match(/^\s*/)![0].length;
  return formatKey(runs[charOwners(runs)[start]] ?? null);
}

// ---- Tables ---------------------------------------------------------------

interface DocCell {
  paragraphs: Element[]; // the cell's own paragraphs
  texts: string[]; // their trimmed text, "" for empty ones
  parts: string[]; // displayed columns
  gaps: string[]; // what separated parts[i] from parts[i + 1]
}

interface DocRow {
  cells: DocCell[];
  display: string[];
}

/** Every table row in the document body, as the editor displays it — the
 * same cells and columns htmlToNumberedText's rowText produces. Rows with
 * no text are left out, as the editor leaves them out. */
function bodyRows(body: Element): DocRow[] {
  const out: DocRow[] = [];
  const rows = body.getElementsByTagNameNS(W, "tr");
  for (let i = 0; i < rows.length; i++) {
    const tr = rows[i];
    // Rows of a table nested inside a cell are part of that cell's text.
    if (hasAncestor(tr, body, (a) => a.localName === "tc")) continue;
    const cells: DocCell[] = [];
    for (const tc of childElements(tr).filter((c) => isW(c, "tc"))) {
      if (isMergedContinuation(tc)) continue; // mammoth folds it into the cell above
      const paragraphs = childElements(tc).filter((c) => isW(c, "p"));
      const texts = paragraphs.map((p) => paragraphText(p).trim());
      const joined = texts.filter(Boolean).join(" ").replace(/\n+/g, " ");
      const pieces = joined.split(new RegExp(`(${PSEUDO_COLUMN_GAP.source})`));
      cells.push({
        paragraphs,
        texts,
        parts: pieces.filter((_, k) => k % 2 === 0),
        gaps: pieces.filter((_, k) => k % 2 === 1),
      });
    }
    const display = cells.flatMap((c) => c.parts);
    if (display.some((d) => d.trim())) out.push({ cells, display });
  }
  return out;
}

function isMergedContinuation(tc: Element): boolean {
  const tcPr = childElements(tc).find((c) => isW(c, "tcPr"));
  const vMerge = tcPr && childElements(tcPr).find((c) => isW(c, "vMerge"));
  if (!vMerge) return false;
  const val = vMerge.getAttributeNS(W, "val") || vMerge.getAttribute("w:val");
  return !val || val === "continue";
}

const rowKey = (cells: string[]) => cells.map(normalize).join("\u001F");

export function applyTableEdits(doc: Document, original: string[][], edited: string[][]): void {
  if (original.length !== edited.length) {
    throw new Error("Table rows can't be added or removed in the editor — only the text in their cells.");
  }
  const docRows = bodyRows(getBody(doc));
  let cursor = 0;
  original.forEach((orig, r) => {
    const key = rowKey(orig);
    let found: DocRow | null = null;
    for (let j = cursor; j < docRows.length; j++) {
      if (rowKey(docRows[j].display) === key) {
        found = docRows[j];
        cursor = j + 1;
        break;
      }
    }
    const next = edited[r];
    if (rowKey(next) === key && next.every((cell, c) => cell === orig[c])) return;
    if (!found) throw new Error(`Couldn't find this table row in the Word file to update it: "${truncate(orig.join(" | "))}"`);
    if (next.length !== orig.length) throw new Error("A table row's cells can't be merged or split in the editor.");
    let col = 0;
    for (const cell of found.cells) {
      const newParts = next.slice(col, col + cell.parts.length);
      const oldParts = orig.slice(col, col + cell.parts.length);
      col += cell.parts.length;
      if (newParts.every((p, k) => p === oldParts[k])) continue;
      writeCell(doc, cell, newParts);
    }
  });
}

/** Rewrites a cell whose displayed columns are now `newParts`, keeping the
 * gaps between them and spreading the text back over the cell's own
 * paragraphs: unchanged text stays in the paragraph it was in, new text
 * goes into the paragraph of the text just before it. */
function writeCell(doc: Document, cell: DocCell, newParts: string[]): void {
  const interleave = (parts: string[]) => parts.map((p, k) => p + (cell.gaps[k] ?? "")).join("");
  const oldJoined = interleave(cell.parts);
  const newJoined = interleave(newParts);

  const filled = cell.texts.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
  if (filled.length === 0) {
    if (cell.paragraphs[0]) replaceParagraphText(doc, cell.paragraphs[0], newJoined);
    return;
  }

  // Which paragraph each character of oldJoined came from; -1 for the
  // space that joined two paragraphs.
  const owner: number[] = [];
  filled.forEach((pi, k) => {
    if (k > 0) owner.push(-1);
    for (let n = 0; n < cell.texts[pi].length; n++) owner.push(pi);
  });

  const out = new Map<number, string>(filled.map((pi) => [pi, ""]));
  let cur = filled[0];
  let afterJoin = false; // the last character passed was a paragraph join
  let pos = 0;
  for (const part of diffWordsWithSpace(oldJoined, newJoined)) {
    if (part.added) {
      // Text typed right after a join ends the paragraph before it; the
      // join's space, which belongs to neither paragraph, goes back in.
      out.set(cur, out.get(cur)! + (afterJoin ? " " : "") + part.value);
      continue;
    }
    for (const ch of part.value) {
      const o = owner[pos++];
      if (o === undefined) continue;
      afterJoin = o === -1;
      if (afterJoin) continue;
      cur = o;
      if (!part.removed) out.set(o, out.get(o)! + ch);
    }
  }
  for (const [pi, text] of out) {
    if (text !== cell.texts[pi]) replaceParagraphText(doc, cell.paragraphs[pi], text);
  }
}

// ---- XML helpers ------------------------------------------------------------

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string): string {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function hasAncestor(el: Element, stopAt: Element, test: (a: Element) => boolean): boolean {
  for (let a = el.parentNode as Element | null; a && a !== stopAt; a = a.parentNode as Element | null) {
    if (a.namespaceURI === W && test(a)) return true;
  }
  return false;
}

function childElements(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as Element);
  return out;
}

function isW(el: Element, name: string): boolean {
  return el.namespaceURI === W && el.localName === name;
}

/** The paragraph's own runs that carry visible text — not runs nested in a
 * text box's paragraphs, and not tracked-change deletions (<w:del>), which
 * Word doesn't show and mammoth doesn't extract either. */
function textRuns(p: Element): Element[] {
  const out: Element[] = [];
  const runs = p.getElementsByTagNameNS(W, "r");
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (hasAncestor(r, p, (a) => a.localName === "p" || a.localName === "del")) continue;
    if (childElements(r).some((c) => isW(c, "t") || isW(c, "tab"))) out.push(r);
  }
  return out;
}

function runText(r: Element): string {
  return childElements(r)
    .map((c) => (isW(c, "t") ? (c.textContent ?? "") : isW(c, "tab") ? "\t" : ""))
    .join("");
}

function paragraphText(p: Element): string {
  return textRuns(p).map(runText).join("");
}

/** For each character of the runs' text, the index of the run it's in. */
function charOwners(runs: Element[]): number[] {
  const owner: number[] = [];
  runs.forEach((r, i) => {
    for (let n = 0; n < runText(r).length; n++) owner.push(i);
  });
  return owner;
}

/** Rewrites a paragraph's text, keeping its <w:pPr> untouched and giving
 * each surviving piece of text the formatting of the run it was in; newly
 * typed text takes the formatting of the text just before it. */
function replaceParagraphText(doc: Document, p: Element, editedText: string): void {
  const runs = textRuns(p);
  const oldText = runs.map(runText).join("");
  // The editor's text is the XML text trimmed (see htmlToNumberedText), so
  // put back leading/trailing whitespace (e.g. an indenting tab) it dropped.
  const lead = oldText.match(/^\s*/)![0];
  const trail = oldText.slice(lead.length).match(/\s*$/)![0];
  const newText = lead + editedText.trim() + trail;
  if (newText === oldText) return;

  const owner = charOwners(runs);
  const pieces: { run: number; text: string }[] = [];
  const push = (run: number, text: string) => {
    const last = pieces[pieces.length - 1];
    if (last && last.run === run) last.text += text;
    else pieces.push({ run, text });
  };
  let pos = 0;
  for (const part of diffWordsWithSpace(oldText, newText)) {
    if (part.removed) {
      pos += part.value.length;
    } else if (part.added) {
      push(owner[Math.max(pos - 1, 0)] ?? 0, part.value);
    } else {
      for (const ch of part.value) push(owner[pos++] ?? 0, ch);
    }
  }

  const first = runs[0];
  const newRuns = pieces.map((piece) => buildRun(doc, runs[piece.run] ?? null, piece.text));
  if (first) {
    for (const r of newRuns) first.parentNode!.insertBefore(r, first);
    for (const r of runs) removeTextFromRun(r);
  } else {
    for (const r of newRuns) p.appendChild(r);
  }
}

/** Drops a run's text; the run itself goes too unless it also holds
 * something else (a field character, drawing, footnote reference). */
function removeTextFromRun(r: Element): void {
  const children = childElements(r);
  const other = children.filter((c) => !isW(c, "t") && !isW(c, "tab") && !isW(c, "rPr"));
  if (other.length === 0) {
    r.parentNode!.removeChild(r);
    return;
  }
  for (const c of children) if (isW(c, "t") || isW(c, "tab")) r.removeChild(c);
}

function buildRun(doc: Document, template: Element | null, text: string): Element {
  const r = doc.createElementNS(W, "w:r");
  const rPr = template && runProperties(template);
  if (rPr) r.appendChild(rPr.cloneNode(true));
  text.split("\t").forEach((part, i) => {
    if (i > 0) r.appendChild(doc.createElementNS(W, "w:tab"));
    if (!part) return;
    const t = doc.createElementNS(W, "w:t");
    t.setAttributeNS(XML_NS, "xml:space", "preserve");
    t.appendChild(doc.createTextNode(part));
    r.appendChild(t);
  });
  return r;
}

function runProperties(r: Element): Element | null {
  return childElements(r).find((c) => isW(c, "rPr")) ?? null;
}

/** A structural fingerprint of a run's formatting, for telling whether two
 * runs look the same. */
function formatKey(r: Element | null): string {
  const rPr = r && runProperties(r);
  if (!rPr) return "";
  const key = (el: Element): string => {
    const attrs = Array.from(el.attributes ?? [])
      .map((a) => `${a.name}=${a.value}`)
      .sort()
      .join(",");
    return `<${el.localName} ${attrs}>${childElements(el).map(key).join("")}`;
  };
  return key(rPr);
}

/** A new paragraph styled like `template` — what Word does when you press
 * Enter, but piece by piece: the template's paragraph properties and its
 * leading indent, its label's formatting for the new label ("13." or
 * "(b)"), and, when the template opens with a differently formatted title
 * ("Compliance with Law." underlined), that formatting for the new text's
 * first sentence and the rest of the template's for the remainder. */
function newParagraph(doc: Document, template: Element | null, text: string): Element {
  const p = doc.createElementNS(W, "w:p");
  const pPr = template && childElements(template).find((c) => isW(c, "pPr"));
  let numbered = false;
  if (pPr) {
    const copy = pPr.cloneNode(true) as Element;
    // A section break belongs to the one paragraph that ends the section.
    for (const c of childElements(copy)) if (isW(c, "sectPr")) copy.removeChild(c);
    numbered = childElements(copy).some((c) => isW(c, "numPr"));
    p.appendChild(copy);
  }
  // Word numbers a list paragraph itself — don't also keep a typed number.
  let rest = numbered ? text.trim().replace(LIST_NUMBER_PREFIX, "") : text.trim();

  const runs = template ? textRuns(template) : [];
  const tText = runs.map(runText).join("");
  const owner = charOwners(runs);
  const runAt = (i: number): Element | null => runs[owner[Math.min(i, owner.length - 1)]] ?? null;
  const pieces: { run: Element | null; text: string }[] = [];
  const add = (run: Element | null, s: string) => {
    if (s) pieces.push({ run, text: s });
  };

  let t = tText.match(/^\s*/)![0].length;
  add(runAt(0), tText.slice(0, t)); // the template's indenting spaces or tab
  const tLabel = labelOf(tText);
  const nLabel = numbered ? null : labelOf(rest);
  const labelRun = tLabel ? runAt(t) : null;
  if (tLabel && nLabel) {
    add(labelRun, nLabel.full);
    rest = rest.slice(nLabel.full.length);
  }
  if (tLabel) t = tLabel.full.length;

  if (t < tText.length) {
    const bodyRun = runAt(t);
    let e = t;
    while (e < tText.length && formatKey(runAt(e)) === formatKey(bodyRun)) e++;
    const title = rest.match(/^.{1,120}?\.(?=\s|$)/)?.[0];
    if (tText.slice(t, e).trim().endsWith(".") && title) {
      add(bodyRun, title);
      add(e < tText.length ? runAt(e) : (labelRun ?? bodyRun), rest.slice(title.length));
    } else {
      add(bodyRun, rest);
    }
  } else {
    add(labelRun ?? runs[0] ?? null, rest);
  }

  if (pieces.length === 0) pieces.push({ run: runs[0] ?? null, text: "" });
  for (const piece of pieces) p.appendChild(buildRun(doc, piece.run, piece.text));
  return p;
}

function insertAfter(ref: Element, el: Element): void {
  ref.parentNode!.insertBefore(el, ref.nextSibling);
}

function insertBeforeSectPr(body: Element, el: Element): void {
  const sectPr = childElements(body).find((c) => isW(c, "sectPr"));
  body.insertBefore(el, sectPr ?? null);
}
