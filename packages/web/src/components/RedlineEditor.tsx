import { useEffect, useRef, useState } from "react";
import type { EditableChange } from "@gitlaw/core/src/diff/editableRedline.js";
import type { EditorContent } from "@gitlaw/core/src/diff/docxPatch.js";
import { toSegments } from "./RedlineDiffView.js";

// An editable redline of a document. The PR's insertions (<ins>) and
// deletions (<del>) are shown as in the PR view; anything the user types
// goes into a <span class="user-ins"> of its own color. What the document
// says is everything on screen except struck text — see editorContent,
// which is what Save writes back to the file. Table cells are editable
// too, but a table's rows and cells stay as they are.
//
// The editable area is plain DOM managed here, not React state: the browser
// edits it in place, and React re-rendering it would fight the caret.

const USER_CLASS = "user-ins";

export function RedlineEditor({
  changes,
  onSave,
}: {
  changes: EditableChange[];
  /** `original` is the text the editor opened with (what the file holds). */
  onSave: (original: EditorContent, edited: EditorContent) => Promise<void>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const originalRef = useRef<EditorContent>({ paragraphs: [], rows: [] });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  function reset() {
    const root = rootRef.current;
    if (!root) return;
    buildDom(root, changes);
    originalRef.current = editorContent(root);
    setDirty(false);
    setMessage(null);
  }

  useEffect(reset, [changes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onBeforeInput = (e: InputEvent) => {
      // Keep the tables' shape: no edit may reach across a cell's edge (the
      // browser would merge a paragraph into a cell, or empty several
      // cells at once), and Enter can't split a cell's text.
      const target0 = e.getTargetRanges()[0];
      const sel0 = window.getSelection();
      const span = target0 ?? (sel0 && sel0.rangeCount ? sel0.getRangeAt(0) : null);
      if (span) {
        const startCell = closestWithin(span.startContainer, root, (el) => el.tagName === "TD");
        const endCell = closestWithin(span.endContainer, root, (el) => el.tagName === "TD");
        const lineBreak = e.inputType === "insertParagraph" || e.inputType === "insertLineBreak";
        if (startCell !== endCell || (startCell && lineBreak)) {
          e.preventDefault();
          return;
        }
      }
      const text =
        e.inputType === "insertText" || e.inputType === "insertReplacementText"
          ? (e.data ?? e.dataTransfer?.getData("text/plain") ?? "")
          : e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop"
            ? (e.dataTransfer?.getData("text/plain") ?? "")
            : null;
      if (text === null) return; // deletions, Enter, etc. — the browser's own editing is fine
      e.preventDefault();
      const target = e.getTargetRanges()[0];
      if (target) {
        const range = document.createRange();
        range.setStart(target.startContainer, target.startOffset);
        range.setEnd(target.endContainer, target.endOffset);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
      }
      insertUserText(root, text.replace(/\s*\r?\n\s*/g, " "));
      setDirty(true);
    };
    const onInput = () => setDirty(true);
    root.addEventListener("beforeinput", onBeforeInput);
    root.addEventListener("input", onInput);
    return () => {
      root.removeEventListener("beforeinput", onBeforeInput);
      root.removeEventListener("input", onInput);
    };
  }, []);

  function applyToSelection(action: Action) {
    const root = rootRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
      setMessage({ error: true, text: "Select some highlighted text first." });
      return;
    }
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    if (marksIn(root, range).length === 0) {
      setMessage({ error: true, text: `The selection has no green or struck text to ${action}.` });
      return;
    }
    applyToTarget(range, action);
    sel.removeAllRanges();
  }

  /** Accepts or rejects the PR marks in `target`: a range (only the part
   * of each mark inside it) or a single mark element (all of it). */
  function applyToTarget(target: Range | Element, action: Action) {
    const root = rootRef.current;
    if (!root) return;
    if (target instanceof Element) {
      resolveMark(target, action);
    } else {
      for (const mark of marksIn(root, target)) {
        isolateSelectedPart(mark, target);
        resolveMark(mark, action);
      }
    }
    root.normalize();
    setDirty(true);
    setMessage(null);
  }

  // Right-clicking a green or struck mark offers accept/reject for it — or,
  // if the right-click lands in a selection holding marks, for the
  // selection. The selection is read on mousedown, before the browser
  // moves the caret to the click point.
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectionAtRightClick = useRef<Range | null>(null);

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 2) return;
    const sel = window.getSelection();
    selectionAtRightClick.current =
      sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null;
  }

  function handleContextMenu(e: React.MouseEvent) {
    const root = rootRef.current;
    if (!root) return;
    const clicked = (e.target as Element).closest?.(MARKS);
    const mark = clicked && root.contains(clicked) ? clicked : null;
    const saved = selectionAtRightClick.current;
    const useSelection =
      saved && marksIn(root, saved).length > 0 && (!mark || saved.intersectsNode(mark));
    const target = useSelection ? saved : mark;
    if (!target) return; // plain text: leave the browser's own menu
    e.preventDefault();
    if (useSelection) {
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(saved);
    }
    setMenu({ x: e.clientX, y: e.clientY, target });
  }

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onMouseDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  function chooseFromMenu(action: Action) {
    if (!menu) return;
    applyToTarget(menu.target, action);
    window.getSelection()?.removeAllRanges();
    setMenu(null);
  }

  const menuNoun = !menu
    ? ""
    : menu.target instanceof Element
      ? menu.target.tagName === "INS"
        ? "insertion"
        : "deletion"
      : "selected changes";

  async function handleSave() {
    const root = rootRef.current;
    if (!root) return;
    setSaving(true);
    setMessage(null);
    try {
      const edited = editorContent(root);
      await onSave(originalRef.current, edited);
      originalRef.current = edited;
      setDirty(false);
      setMessage({ error: false, text: "Saved to the file on disk." });
    } catch (e: any) {
      setMessage({ error: true, text: e.message });
    } finally {
      setSaving(false);
    }
  }

  // mousedown, not click: keeps the editor's text selection from being
  // cleared by the button taking focus before the handler runs.
  const keepSelection = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div>
      <div className="redline-editor-toolbar">
        <button onMouseDown={keepSelection} onClick={() => applyToSelection("accept")}>
          Accept
        </button>
        <button onMouseDown={keepSelection} onClick={() => applyToSelection("reject")}>
          Reject
        </button>
        <span className="redline-editor-legend">
          <ins>PR insertion</ins> <del>PR deletion</del> <span className={USER_CLASS}>your edit</span>
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={reset} disabled={saving || !dirty}>
          Discard edits
        </button>
        <button className="primary" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {message && (
        <p style={{ color: message.error ? "var(--danger)" : "var(--success)", fontSize: 13, margin: "0 0 8px" }}>
          {message.text}
        </p>
      )}
      <div
        ref={rootRef}
        className="redline redline-editor"
        contentEditable
        suppressContentEditableWarning
        spellCheck
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
      />
      {menu && (
        <div ref={menuRef} className="redline-context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
          <button role="menuitem" onMouseDown={keepSelection} onClick={() => chooseFromMenu("accept")}>
            Accept {menuNoun}
          </button>
          <button role="menuitem" onMouseDown={keepSelection} onClick={() => chooseFromMenu("reject")}>
            Reject {menuNoun}
          </button>
        </div>
      )}
    </div>
  );
}

type Action = "accept" | "reject";

interface ContextMenu {
  x: number;
  y: number;
  target: Range | Element;
}

/** The PR's own marks — green insertions and struck deletions, not the
 * user's edits. */
const MARKS = `ins:not(.${USER_CLASS}), del`;

/** PR marks that `range` touches. */
function marksIn(root: HTMLElement, range: Range): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(MARKS)).filter((el) => range.intersectsNode(el));
}

/** Accepting an insertion or rejecting a deletion keeps the text as plain
 * text; rejecting an insertion or accepting a deletion drops it. */
function resolveMark(mark: Element, action: Action): void {
  const keep = (mark.tagName === "INS") === (action === "accept");
  if (keep) mark.replaceWith(...Array.from(mark.childNodes));
  else mark.remove();
}

/** One <p> per paragraph, and a <table> per run of table rows. A row with
 * nothing but struck text (one the PR deleted) is marked data-gone: it
 * isn't in the file, so Save doesn't count it as a row. */
function buildDom(root: HTMLElement, changes: EditableChange[]): void {
  root.replaceChildren();
  for (const seg of toSegments(changes)) {
    if (seg.kind === "table") {
      const table = document.createElement("table");
      table.className = "redline-table";
      const tbody = table.appendChild(document.createElement("tbody"));
      for (const cells of seg.rows) {
        const tr = tbody.appendChild(document.createElement("tr"));
        for (const cell of cells) {
          const td = tr.appendChild(document.createElement("td"));
          for (const c of cell) td.appendChild(markFor(c, c.value));
        }
        if (!visibleText(tr).trim()) tr.dataset.gone = "true";
      }
      root.appendChild(table);
      continue;
    }
    let p = document.createElement("p");
    const flush = () => {
      if (p.childNodes.length) root.appendChild(p);
      p = document.createElement("p");
    };
    for (const c of seg.changes) {
      c.value.split("\n\n").forEach((piece, i) => {
        if (i > 0) flush();
        if (piece) p.appendChild(markFor(c, piece));
      });
    }
    flush();
  }
}

function markFor(c: EditableChange, text: string): Node {
  if (c.removed) {
    const del = document.createElement("del");
    del.textContent = text;
    return del;
  }
  if (c.user) {
    const span = document.createElement("span");
    span.className = USER_CLASS;
    span.textContent = text;
    return span;
  }
  if (c.added) {
    const ins = document.createElement("ins");
    ins.textContent = text;
    return ins;
  }
  return document.createTextNode(text);
}

/** What the editor shows, in the shape Save writes back: the paragraphs,
 * and each table row's cells, all without struck text. */
function editorContent(root: HTMLElement): EditorContent {
  const rows = Array.from(root.querySelectorAll<HTMLTableRowElement>("table tr"))
    .filter((tr) => !tr.dataset.gone)
    .map((tr) => Array.from(tr.cells).map((td) => visibleText(td).trim()));
  return { paragraphs: paragraphTexts(root), rows };
}

/** The document's paragraphs as currently edited: every block's text
 * except struck (<del>) text, skipping tables and empty paragraphs. */
function paragraphTexts(root: HTMLElement): string[] {
  const out: string[] = [];
  let loose = ""; // text the browser left directly in the root, outside any <p>
  const push = (text: string) => {
    if (text.trim()) out.push(text);
  };
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE && /^(P|DIV|H[1-6]|LI|BLOCKQUOTE)$/.test((node as Element).tagName)) {
      push(loose);
      loose = "";
      push(visibleText(node));
    } else if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "TABLE") {
      push(loose);
      loose = "";
    } else {
      loose += visibleText(node);
    }
  }
  push(loose);
  return out;
}

function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data;
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = (node as Element).tagName;
  if (tag === "DEL" || tag === "BR") return "";
  return Array.from(node.childNodes).map(visibleText).join("");
}

function closestWithin(node: Node, root: HTMLElement, test: (el: Element) => boolean): Element | null {
  for (let n: Node | null = node; n && n !== root; n = n.parentNode) {
    if (n.nodeType === Node.ELEMENT_NODE && test(n as Element)) return n as Element;
  }
  return null;
}

/** Inserts typed text at the caret as the user's own edit: appended to the
 * user-edit span the caret is already in, or else in a new one — splitting
 * a PR <ins>/<del> in two if the caret sits inside it, so the typed text
 * never inherits green or strikethrough. */
function insertUserText(root: HTMLElement, text: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !text) return;
  if (!root.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
  // Typing over a selection replaces it — let the browser delete it (it
  // also merges paragraphs when the selection spans several).
  if (!sel.isCollapsed) document.execCommand("delete");
  const range = sel.getRangeAt(0);
  const { startContainer, startOffset } = range;

  const placeCaret = (node: Text, offset: number) => {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  };

  const userSpan = closestWithin(startContainer, root, (el) => el.classList.contains(USER_CLASS));
  if (userSpan && startContainer.nodeType === Node.TEXT_NODE) {
    (startContainer as Text).insertData(startOffset, text);
    placeCaret(startContainer as Text, startOffset + text.length);
    return;
  }

  const span = document.createElement("span");
  span.className = USER_CLASS;
  const textNode = span.appendChild(document.createTextNode(text));
  const mark = closestWithin(startContainer, root, (el) => el.tagName === "INS" || el.tagName === "DEL");
  if (mark) {
    const tail = document.createRange();
    tail.setStart(startContainer, startOffset);
    tail.setEnd(mark, mark.childNodes.length);
    const rest = tail.extractContents();
    mark.after(span);
    if (rest.textContent) {
      const clone = mark.cloneNode(false) as Element;
      clone.appendChild(rest);
      span.after(clone);
    }
    if (!mark.textContent) mark.remove();
  } else {
    range.insertNode(span);
  }
  placeCaret(textNode, text.length);
}

/** Splits `mark` so that only the part inside `range` stays in it — the
 * parts before and after become separate copies of the same mark. */
function isolateSelectedPart(mark: Element, range: Range): void {
  const whole = document.createRange();
  whole.selectNodeContents(mark);
  if (range.compareBoundaryPoints(Range.START_TO_START, whole) > 0) {
    const before = document.createRange();
    before.setStart(mark, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const frag = before.extractContents();
    if (frag.textContent) {
      const clone = mark.cloneNode(false) as Element;
      clone.appendChild(frag);
      mark.before(clone);
    }
  }
  whole.selectNodeContents(mark);
  if (range.compareBoundaryPoints(Range.END_TO_END, whole) < 0) {
    const after = document.createRange();
    after.setStart(range.endContainer, range.endOffset);
    after.setEnd(mark, mark.childNodes.length);
    const frag = after.extractContents();
    if (frag.textContent) {
      const clone = mark.cloneNode(false) as Element;
      clone.appendChild(frag);
      mark.after(clone);
    }
  }
}
