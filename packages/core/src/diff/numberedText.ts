import { parse, NodeType, type HTMLElement, type Node } from "node-html-parser";

const BULLET_TAG = "ul";
const NUMBERED_TAG = "ol";

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
 * number a browser would actually render for it: a plain sequential counter
 * that resets to 1 at the start of every <ol> — including a nested one,
 * which is exactly how mammoth's default HTML conversion renders a
 * multi-level Word list (it emits bare nested <ol>/<li>, not the composite
 * "1.1" numbering Word's own numFmt/lvlText would produce, since it doesn't
 * carry that formatting into the HTML). Matching the browser's actual
 * rendering — rather than trying to reconstruct Word's original numbering
 * scheme — is what keeps this consistent with what the Formatted tab shows.
 *
 * A block with no text of its own (e.g. an empty paragraph) is skipped
 * entirely, never invoking `visit` — callers rely on that to keep this
 * walk's block sequence aligned 1:1 with computeRedline's paragraph list,
 * which likewise drops empty paragraphs.
 */
function forEachBlock(node: HTMLElement | Node, visit: (el: HTMLElement, text: string, number: number | null) => void): void {
  for (const child of node.childNodes) {
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    const tag = el.tagName?.toLowerCase();

    if (tag === NUMBERED_TAG || tag === BULLET_TAG) {
      let n = 0;
      for (const itemNode of el.childNodes) {
        if (itemNode.nodeType !== NodeType.ELEMENT_NODE) continue;
        const item = itemNode as HTMLElement;
        if (item.tagName?.toLowerCase() !== "li") continue;
        n++;
        const text = ownText(item);
        if (text) visit(item, text, tag === NUMBERED_TAG ? n : null);
        forEachBlock(item, visit);
      }
      continue;
    }

    if (tag === "table") {
      const text = el.textContent.trim();
      if (text) visit(el, text, null);
      continue;
    }

    // Anything else (p, h1-h6, a stray inline element, ...) is a leaf
    // paragraph — don't recurse into it. ownText() already walks its whole
    // subtree for text; recursing here too would re-visit each inline-
    // formatted run (every <strong>/<em>/<a> mammoth produces for bold,
    // italic, or linked text) as its own spurious extra "paragraph".
    const text = ownText(el);
    if (text) visit(el, text, null);
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
