import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRedline } from "./redline.js";

test("computeRedline marks a substituted word as removed+added", () => {
  const { changes, stats } = computeRedline("The term is one year.", "The term is TWO years.");
  const removed = changes.filter((c) => c.removed).map((c) => c.value);
  const added = changes.filter((c) => c.added).map((c) => c.value);
  assert.deepEqual(removed, ["one", "year"]);
  assert.deepEqual(added, ["TWO", "years"]);
  assert.equal(stats.removed, 2);
  assert.equal(stats.added, 2);
});

test("computeRedline reports no changes for identical text", () => {
  const { changes, stats } = computeRedline("Same text.", "Same text.");
  assert.ok(changes.every((c) => !c.added && !c.removed));
  assert.equal(stats.added, 0);
  assert.equal(stats.removed, 0);
});

test("computeRedline keeps unchanged paragraphs intact around a heavily reworded one", () => {
  const oldText =
    "Intro paragraph that stays the same across both versions.\n\n" +
    "This shall be the property of Recipient but shall be subject to any confidentiality obligation of this Agreement.\n\n" +
    "Closing paragraph that also stays the same across both versions.";
  const newText =
    "Intro paragraph that stays the same across both versions.\n\n" +
    "This otherwise reflects, to any degree, the foregoing.\n\n" +
    "Closing paragraph that also stays the same across both versions.";

  const { changes } = computeRedline(oldText, newText);

  // The intro and closing paragraphs are untouched, so each should appear as
  // a single unchanged chunk rather than being torn into scattered
  // add/remove fragments by a whole-document word diff.
  const unchanged = changes.filter((c) => !c.added && !c.removed);
  assert.ok(unchanged.some((c) => c.value.includes("Intro paragraph that stays the same")));
  assert.ok(unchanged.some((c) => c.value.includes("Closing paragraph that also stays the same")));

  const introChunk = unchanged.find((c) => c.value.includes("Intro paragraph"))!;
  assert.equal(introChunk.value.trim(), "Intro paragraph that stays the same across both versions.");
});
