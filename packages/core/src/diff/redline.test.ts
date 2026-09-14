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

  // The rewritten middle paragraph itself should read as one clean
  // strikethrough block followed by one clean inserted block, not a
  // scrambled word-by-word interleaving of the two unrelated sentences.
  const removed = changes.filter((c) => c.removed);
  const added = changes.filter((c) => c.added);
  assert.equal(removed.length, 1);
  assert.equal(added.length, 1);
  assert.ok(removed[0].value.includes("subject to any confidentiality obligation"));
  assert.ok(added[0].value.includes("otherwise reflects, to any degree"));
});

test("computeRedline diffs at clause granularity, leaving unrelated clauses in the same paragraph untouched", () => {
  const oldText = "First clause, second clause, this is the old ending clause.";
  const newText = "First clause, second clause, this is a totally different unrelated new ending.";

  const { changes } = computeRedline(oldText, newText);
  const unchangedText = changes
    .filter((c) => !c.added && !c.removed)
    .map((c) => c.value)
    .join("");
  const removed = changes.filter((c) => c.removed).map((c) => c.value.trim());
  const added = changes.filter((c) => c.added).map((c) => c.value.trim());

  assert.ok(unchangedText.includes("First clause,"));
  assert.ok(unchangedText.includes("second clause,"));
  assert.deepEqual(removed, ["this is the old ending clause."]);
  assert.deepEqual(added, ["this is a totally different unrelated new ending."]);
});

test("computeRedline never embeds a literal newline inside a removed/added chunk", () => {
  // mammoth joins paragraphs with "\n\n", so a changed paragraph's raw text
  // (as computeRedline receives it) ends with a trailing "\n" — that must
  // never end up glued onto the end of the last clause of a replaced run,
  // or the pre-wrap CSS renders it as a hard line break splitting the
  // strikethrough block from the inserted block right after it.
  const oldText =
    "Intro paragraph that stays the same.\n\n" +
    "Shared opening clause, this ending is the old unrelated text entirely.\n\n" +
    "Outro paragraph that stays the same.";
  const newText =
    "Intro paragraph that stays the same.\n\n" +
    "Shared opening clause, this ending is a wildly different replacement now.\n\n" +
    "Outro paragraph that stays the same.";

  const { changes } = computeRedline(oldText, newText);
  for (const c of changes) {
    if (c.added || c.removed) {
      assert.ok(!c.value.includes("\n"), `expected no embedded newline in: ${JSON.stringify(c.value)}`);
    }
  }
});

test("computeRedline treats two clauses as unchanged when only their boundary punctuation differs", () => {
  const oldText =
    "Shared clause, or destroy copies of Confidential Information in the ordinary course. " +
    "Recipient's confidentiality obligations under this Agreement shall continue only until expiration.";
  const newText =
    "Shared clause, or destroy copies of Confidential Information in the ordinary course, " +
    "provided that such retained copies remain subject to this agreement and are not used for any purpose.";

  const { changes } = computeRedline(oldText, newText);
  const unchangedText = changes
    .filter((c) => !c.added && !c.removed)
    .map((c) => c.value)
    .join("");
  const removed = changes.filter((c) => c.removed).map((c) => c.value.trim());
  const added = changes.filter((c) => c.added).map((c) => c.value.trim());

  assert.ok(unchangedText.includes("or destroy copies of Confidential Information in the ordinary course"));
  assert.deepEqual(removed, ["Recipient's confidentiality obligations under this Agreement shall continue only until expiration."]);
  assert.deepEqual(added, [
    "provided that such retained copies remain subject to this agreement and are not used for any purpose.",
  ]);
});

test("computeRedline keeps a closing quote with the clause it closes, not the clause after it", () => {
  const oldText =
    'whether or not marked or designated as "confidential," that is, where practicable, marked as such, and all notes, analyses, and summaries.';
  const newText = 'whether or not marked or designated as "confidential," and all notes, analyses, and summaries.';

  const { changes } = computeRedline(oldText, newText);
  const removed = changes.filter((c) => c.removed).map((c) => c.value);

  // The removed text must start with "that is" — not a stray leading quote
  // torn off the end of the preceding (unchanged) `"confidential,"` clause.
  assert.equal(removed.length, 1);
  assert.ok(removed[0].trim().startsWith("that is"), `expected clause to start with "that is", got: ${JSON.stringify(removed[0])}`);
  assert.ok(!removed[0].includes('"'), `expected no stray quote in removed clause: ${JSON.stringify(removed[0])}`);
});

test("computeRedline reports unchanged/changed/removed paragraph status", () => {
  const oldText =
    "Intro unchanged.\n\n" + "Old paragraph A.\n\n" + "Old paragraph B extra removed.\n\n" + "Outro unchanged.";
  const newText = "Intro unchanged.\n\n" + "Old paragraph A edited.\n\n" + "Outro unchanged.";

  const { paragraphStatus } = computeRedline(oldText, newText);

  assert.deepEqual(paragraphStatus.old, ["unchanged", "changed", "removed", "unchanged"]);
  assert.deepEqual(paragraphStatus.new, ["unchanged", "changed", "unchanged"]);
});

test("computeRedline reports unchanged/changed/added paragraph status", () => {
  const oldText = "Intro.\n\n" + "Para A.\n\n" + "Outro.";
  const newText = "Intro.\n\n" + "Para A edited.\n\n" + "Para B extra added.\n\n" + "Outro.";

  const { paragraphStatus } = computeRedline(oldText, newText);

  assert.deepEqual(paragraphStatus.old, ["unchanged", "changed", "unchanged"]);
  assert.deepEqual(paragraphStatus.new, ["unchanged", "changed", "added", "unchanged"]);
});

test("computeRedline keeps a lightly edited paragraph as a precise word-level diff", () => {
  const { changes } = computeRedline(
    "The Recipient shall keep the Confidential Information secret for one year.",
    "The Recipient shall keep the Confidential Information secret for TWO years."
  );
  const removed = changes.filter((c) => c.removed).map((c) => c.value);
  const added = changes.filter((c) => c.added).map((c) => c.value);
  assert.deepEqual(removed, ["one", "year"]);
  assert.deepEqual(added, ["TWO", "years"]);
});
