import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRedline } from "./redline.js";
import { overlayLocalEdits, unchangedText, type EditableChange } from "./editableRedline.js";
import { ROW_START, CELL_SEP } from "./tableMarkers.js";

// [-struck-] {+PR insertion+} {~user insertion~}
function render(changes: EditableChange[]): string {
  return changes
    .map((c) => (c.user ? `{~${c.value}~}` : c.added ? `{+${c.value}+}` : c.removed ? `[-${c.value}-]` : c.value))
    .join("");
}

const base = "The term is one year.\n\nPayment is due in thirty days.\n\n";
const head = "The term is two years.\n\nPayment is due in thirty days.\n\n";

test("with no local edits the overlay is the PR's redline", () => {
  const pr = computeRedline(base, head);
  assert.deepEqual(render(overlayLocalEdits(pr.changes, head, head)!), render(pr.changes));
});

test("local insertions are marked as the user's and local deletions disappear", () => {
  const pr = computeRedline(base, head).changes;
  const current = "The term is two full years.\n\nPayment is due in days.\n\n";
  const out = render(overlayLocalEdits(pr, head, current)!);
  assert.match(out, /\{~full ~\}/);
  assert.doesNotMatch(out, /thirty/);
  assert.match(out, /\[-one year-\]|\[-one-\]/);
});

test("the new side of the overlay is exactly the current text", () => {
  const pr = computeRedline(base, head).changes;
  const current = "Intro.\n\nThe term is two years.\n\nPayment is due in thirty days, net.\n\n";
  const out = overlayLocalEdits(pr, head, current)!;
  assert.equal(out.filter((c) => !c.removed).map((c) => c.value).join(""), current);
});

test("returns null when the redline doesn't match the head text", () => {
  const pr = computeRedline(base, head).changes;
  assert.equal(overlayLocalEdits(pr, "something else\n\n", head), null);
});

test("unmarked text keeps table markers as changes of their own, so tables render as tables", () => {
  const text = `IN WITNESS WHEREOF.\n\n${ROW_START}${CELL_SEP}Data Center, LLC\n\n${ROW_START}${CELL_SEP}By____ Name: Brenlee Fox\n\nEXHIBIT A\n\n`;
  const changes = unchangedText(text);
  assert.equal(changes.map((c) => c.value).join(""), text);
  for (const c of changes) {
    if (c.value.includes(ROW_START) || c.value.includes(CELL_SEP)) assert.ok(c.value === ROW_START || c.value === CELL_SEP, JSON.stringify(c.value));
  }
  assert.ok(changes.every((c) => !c.added && !c.removed));
  // With a local edit on top, the row's markers still stand alone.
  const edited = text.replace("By____", "By__/s/ Brenlee Fox__");
  const overlay = overlayLocalEdits(changes, text, edited)!;
  assert.ok(overlay.some((c) => c.user && c.value.includes("/s/")));
  assert.equal(overlay.filter((c) => c.value === ROW_START).length, 2);
});
