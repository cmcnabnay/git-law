import { parse, NodeType, type HTMLElement, type Node } from "node-html-parser";

const BULLET_TAG = "ul";
const NUMBERED_TAG = "ol";
const LEAF_BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"]);

/** Text of `el` itself, excluding any nested <ol>/<ul> descendants — those
 * are walked separately so a numbered sub-list inside a list item doesn't
 * get folded into that item's own paragraph text. Collapses any literal
 * "\n\n" that happened to be in the source run text so it can never be
 * mistaken for the "\n\n" this module uses as its own paragraph separator —
 * that separator is what keeps a paragraph's index here lined up with its
 * block element's index in the HTML (see annotateParagraphHtml). */
function ownText(el: HTMLElement): string {
  let text = "";
  for (const child of el.childNodes) {
    if (child.nodeType === NodeType.TEXT_NODE) {
      text += child.rawText;
      continue;
    }
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
    const tag = (child as HTMLElement).tagName?.toLowerCase();
    if (tag === BULLET_TAG || tag === NUMBERED_TAG) continue;
    text += (child as HTMLElement).textContent;
  }
  return text.trim().replace(/\n{2,}/g, " ");
}

/**
 * Walks the block-level children of `node` in document order, invoking
 * `visit` once per paragraph-like block (a plain <p>/<h1-6>/<table>, or a
 * numbered/bulleted <li>) with its own text and, for a numbered <li>, the
 * number a browser would actually render for it: a sequential counter,
 * shared across every top-level <ol> sibling found among `node`'s direct
 * children, but reset to 1 for a genuinely nested <ol> (one found while
 * recursing into an <li> — a fresh `forEachBlock` call, so it gets its own
 * counter). The shared-across-siblings part matters because mammoth's docx
 * conversion splits one continuous Word numbered list into multiple
 * sibling <ol> elements whenever a non-list paragraph sits between list
 * items (e.g. a manually-typed "5. ..." paragraph rather than a real
 * auto-numbered list item) — Word itself still renders the items after
 * that split continuing the same sequence (6, 7, 8, ...), so restarting
 * each sibling <ol> at 1 would silently disagree with the actual document.
 * A nested <ol> restarts at 1 correctly, since mammoth emits bare nested
 * <ol>/<li> for a multi-level Word list rather than composite "1.1"
 * numbering, so there's no shared sequence to continue there anyway.
 *
 * A block with no text of its own (e.g. an empty paragraph) is skipped
 * entirely, never invoking `visit` — callers rely on that to keep this
 * walk's block sequence aligned 1:1 with computeRedline's paragraph list,
 * which likewise drops empty paragraphs.
 */
function forEachBlock(node: HTMLElement | Node, visit: (el: HTMLElement, text: string, number: number | null) => void): void {
  let numberedCounter = 0;
  for (const child of node.childNodes) {
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    const tag = el.tagName?.toLowerCase();

    if (tag === NUMBERED_TAG || tag === BULLET_TAG) {
      let n = numberedCounter;
      for (const itemNode of el.childNodes) {
        if (itemNode.nodeType !== NodeType.ELEMENT_NODE) continue;
        const item = itemNode as HTMLElement;
        if (item.tagName?.toLowerCase() !== "li") continue;
        n++;
        const text = ownText(item);
        if (text) visit(item, text, tag === NUMBERED_TAG ? n : null);
        forEachBlock(item, visit);
      }
      if (tag === NUMBERED_TAG) numberedCounter = n;
      continue;
    }

    if (tag === "table") {
      const text = el.textContent.trim();
      if (text) visit(el, text, null);
      continue;
    }

    // Only a known block tag counts as its own paragraph — anything else
    // (a stray <strong>/<em>/<a>/bookmark <a id="..."> at this level) is
    // just inline formatting encountered while walking a container's
    // children (e.g. an <li>'s children, walked below purely to find a
    // nested <ol>/<ul>) and must be ignored, not treated as a leaf block.
    // Treating "anything unrecognized" as a paragraph was exactly the bug:
    // every <strong>Purpose</strong> mammoth emits for a bolded defined
    // term was getting re-visited as its own spurious one-word "paragraph".
    if (LEAF_BLOCK_TAGS.has(tag ?? "")) {
      const text = ownText(el);
      if (text) visit(el, text, null);
    }
  }
}

/** Rebuilds mammoth's extractRawText-style output ("paragraph\n\nparagraph"),
 * but with each numbered-list paragraph prefixed by the same number the
 * Formatted tab's rendered <ol> would show it — numbering that plain-text
 * extraction otherwise drops entirely, since it isn't part of any run's
 * actual text, only the list markup around it. */
export function htmlToNumberedText(html: string): string {
  const paragraphs: string[] = [];
  forEachBlock(parse(html), (_el, text, number) => {
    paragraphs.push(number != null ? `${number}. ${text}` : text);
  });
  return paragraphs.join("\n\n") + (paragraphs.length ? "\n\n" : "");
}

/** Walks the same way `forEachBlock` numbers list items, but mutates the
 * HTML itself: sets an explicit `start` attribute on any <ol> that
 * continues a sibling list mammoth split apart, so a plain rendered
 * <ol>/<li> — no per-item numbering logic involved, just the browser's own
 * native list rendering — shows the same continuous numbering the redline
 * text view computes, instead of restarting at 1. A genuinely nested <ol>
 * (a Word sub-list) is left untouched, since the browser already renders
 * that correctly starting at 1. */
function fixListStarts(node: HTMLElement | Node): void {
  let numberedCounter = 0;
  for (const child of node.childNodes) {
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    const tag = el.tagName?.toLowerCase();

    if (tag === NUMBERED_TAG || tag === BULLET_TAG) {
      let n = numberedCounter;
      if (tag === NUMBERED_TAG && numberedCounter > 0) {
        el.setAttribute("start", String(numberedCounter + 1));
      }
      for (const itemNode of el.childNodes) {
        if (itemNode.nodeType !== NodeType.ELEMENT_NODE) continue;
        const item = itemNode as HTMLElement;
        if (item.tagName?.toLowerCase() !== "li") continue;
        n++;
        fixListStarts(item);
      }
      if (tag === NUMBERED_TAG) numberedCounter = n;
      continue;
    }
  }
}

/** Fixes up mammoth's raw docx-to-html output so a plain rendered view
 * (nothing but `dangerouslySetInnerHTML` and the browser's own <ol> CSS)
 * shows correct numbering even where mammoth split one continuous Word
 * list into multiple sibling <ol> elements — see fixListStarts. Apply this
 * once, right after mammoth's conversion, before the HTML reaches any
 * renderer (the Remote tab's blob preview, the Local tab's preview, and
 * the PR redline view via annotateParagraphHtml all share this path). */
export function fixOrderedListNumbering(html: string): string {
  const root = parse(html);
  fixListStarts(root);
  return root.toString();
}

export type ParagraphStatus = "unchanged" | "changed" | "removed" | "added";

/** Marks each paragraph-like block of `html`, in the same document order
 * `htmlToNumberedText` visits them, with a `redline-<status>` class from
 * `statuses` — so the Formatted view can show a GitHub-style colored
 * background per changed paragraph. `statuses[i]` must correspond to the
 * i-th non-empty block `htmlToNumberedText` would report for this same
 * `html`, which is exactly what computeRedline's per-paragraph status
 * arrays give you, since both are derived from the same numbered text. */
export function annotateParagraphHtml(html: string, statuses: ParagraphStatus[]): string {
  const root = parse(html);
  let i = 0;
  forEachBlock(root, (el) => {
    const status = statuses[i];
    i++;
    if (status && status !== "unchanged") {
      el.classList.add(`redline-${status}`);
    }
  });
  return root.toString();
}
