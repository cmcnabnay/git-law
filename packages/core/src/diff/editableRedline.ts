import { diffWordsWithSpace } from "diff";
import { ROW_START, CELL_SEP } from "./tableMarkers.js";

// A redline change as the Local tab's editor renders it: `user` marks text
// the user typed on their own branch (added relative to the PR's version),
// shown in its own color apart from the PR's green insertions.
export interface EditableChange {
  value: string;
  added?: boolean;
  removed?: boolean;
  user?: boolean;
}

type Kind = "plain" | "ins" | "del" | "user";

/**
 * Overlays a local document's own edits onto a pull request's redline.
 *
 * `prChanges` is the PR's redline (base → `headText`); `currentText` is the
 * document as it sits on disk now, on a branch created from the PR's head.
 * Text the user deleted since then disappears, text they added shows as
 * `user`, and the PR's own insertions and deletions keep their marks — so
 * right after branching (currentText === headText) this is exactly the PR's
 * redline.
 *
 * Returns null if `prChanges` doesn't rebuild `headText`, i.e. the redline
 * and the text came from different versions and can't be lined up.
 */
export function overlayLocalEdits(
  prChanges: EditableChange[],
  headText: string,
  currentText: string
): EditableChange[] | null {
  const newSide = prChanges.filter((c) => !c.removed).map((c) => c.value).join("");
  if (newSide !== headText) return null;
  if (currentText === headText) return prChanges.map((c) => ({ ...c }));

  // For each character of headText: whether the user deleted it, and what
  // they inserted just before it (index headText.length = at the very end).
  const deleted = new Array<boolean>(headText.length).fill(false);
  const insertedBefore = new Map<number, string>();
  let h = 0;
  for (const part of diffWordsWithSpace(headText, currentText)) {
    if (part.added) insertedBefore.set(h, (insertedBefore.get(h) ?? "") + part.value);
    else {
      if (part.removed) deleted.fill(true, h, h + part.value.length);
      h += part.value.length;
    }
  }

  const chars: { ch: string; kind: Kind }[] = [];
  const emitInserted = (at: number) => {
    for (const ch of insertedBefore.get(at) ?? "") chars.push({ ch, kind: "user" });
  };
  h = 0;
  for (const c of prChanges) {
    if (c.removed) {
      for (const ch of c.value) chars.push({ ch, kind: "del" });
      continue;
    }
    const kind: Kind = c.added ? "ins" : "plain";
    for (const ch of c.value) {
      emitInserted(h);
      if (!deleted[h]) chars.push({ ch, kind });
      h++;
    }
  }
  emitInserted(h);

  return group(chars);
}

/** `text` (htmlToNumberedText's output) with nothing marked, laid out the
 * way a redline is — table markers and paragraph breaks as changes of their
 * own — so the editor shows its tables as tables. For a document with no
 * redline to show: a file the PR didn't touch, or a branch with no PR. */
export function unchangedText(text: string): EditableChange[] {
  return group(Array.from(text, (ch) => ({ ch, kind: "plain" as Kind })));
}

/** Merges runs of same-kind characters back into changes, keeping table
 * markers and "\n\n" paragraph breaks as changes of their own — the
 * renderer recognizes those by exact value (see RedlineDiffView's
 * toSegments). */
function group(chars: { ch: string; kind: Kind }[]): EditableChange[] {
  const out: EditableChange[] = [];
  let run: { value: string; kind: Kind } | null = null;
  const flush = () => {
    if (run) out.push(toChange(run.value, run.kind));
    run = null;
  };
  for (let i = 0; i < chars.length; i++) {
    const { ch, kind } = chars[i];
    if (ch === ROW_START || ch === CELL_SEP) {
      flush();
      out.push(toChange(ch, kind));
    } else if (ch === "\n" && chars[i + 1]?.ch === "\n") {
      flush();
      out.push(toChange("\n\n", kind));
      i++;
    } else if (run && run.kind === kind) {
      run.value += ch;
    } else {
      flush();
      run = { value: ch, kind };
    }
  }
  flush();
  return out;
}

function toChange(value: string, kind: Kind): EditableChange {
  switch (kind) {
    case "ins":
      return { value, added: true };
    case "del":
      return { value, removed: true };
    case "user":
      return { value, added: true, user: true };
    default:
      return { value };
  }
}
