import JSZip from "jszip";
import { diffArrays, diffWordsWithSpace } from "diff";

// Writes paragraph-level text edits back into a .docx's word/document.xml
// in place, instead of regenerating the document from plain text — so every
// paragraph the edit didn't touch keeps its exact XML (styles, numbering,
// bold defined terms), and an edited paragraph keeps its paragraph
// properties and as much of its run formatting as the edit leaves intact.
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

/**
 * `original` is the document's paragraph text as the editor first showed it
 * (htmlToNumberedText's paragraphs, table rows excluded), `edited` what it
 * shows now. Returns the .docx with the difference applied.
 */
export async function saveParagraphEditsToDocx(
  bytes: Uint8Array,
  original: string[],
  edited: string[],
  xml: XmlImpl = browserXml
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("Not a Word document: word/document.xml is missing");
  const doc = xml.parse(await entry.async("string"));
  applyParagraphEdits(doc, original, edited);
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
  const body = doc.getElementsByTagNameNS(W, "body")[0];
  if (!body) throw new Error("word/document.xml has no <w:body>");
  const paragraphs = bodyParagraphs(body);
  const mapping = mapParagraphs(original, paragraphs);

  const need = (i: number): Mapped => {
    const m = mapping[i];
    if (!m) throw new Error(`Couldn't find this paragraph in the Word file to update it: "${truncate(original[i])}"`);
    return m;
  };

  let oi = 0;
  let anchor: Element | null = null; // last paragraph kept or written, for inserting after
  const insert = (text: string, template: Element | null) => {
    const p = newParagraph(doc, template ?? anchor ?? paragraphs[0]?.el ?? null, text);
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
      for (const text of chunk.value) insert(text, null);
      continue;
    }
    // Removed, possibly followed by its replacement: pair them up in order
    // so a rewritten paragraph is edited in place rather than deleted and
    // re-inserted without its formatting.
    const removedStart = oi;
    oi += chunk.value.length;
    const replacements = chunks[k + 1]?.added ? chunks[++k].value : [];
    const paired = Math.min(chunk.value.length, replacements.length);
    for (let n = 0; n < paired; n++) {
      const m = need(removedStart + n);
      const text = m.prefix && replacements[n].startsWith(m.prefix) ? replacements[n].slice(m.prefix.length) : replacements[n];
      replaceParagraphText(doc, m.el, text);
      anchor = m.el;
    }
    for (let n = paired; n < chunk.value.length; n++) {
      const m = need(removedStart + n);
      m.el.parentNode!.removeChild(m.el);
    }
    for (let n = paired; n < replacements.length; n++) {
      insert(replacements[n], paired > 0 ? need(removedStart + paired - 1).el : null);
    }
  }
}

/** Body-level paragraphs in document order: not inside a table (tables
 * aren't editable) and not nested inside another paragraph (text boxes). */
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

  const owner: number[] = [];
  runs.forEach((r, i) => {
    for (let n = 0; n < runText(r).length; n++) owner.push(i);
  });

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
  const rPr = template && childElements(template).find((c) => isW(c, "rPr"));
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

/** A new paragraph styled like `template` (its paragraph properties and its
 * first run's formatting) — what Word does when you press Enter. */
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
  const body = numbered ? text.replace(LIST_NUMBER_PREFIX, "") : text;
  p.appendChild(buildRun(doc, template ? (textRuns(template)[0] ?? null) : null, body));
  return p;
}

function insertAfter(ref: Element, el: Element): void {
  ref.parentNode!.insertBefore(el, ref.nextSibling);
}

function insertBeforeSectPr(body: Element, el: Element): void {
  const sectPr = childElements(body).find((c) => isW(c, "sectPr"));
  body.insertBefore(el, sectPr ?? null);
}
