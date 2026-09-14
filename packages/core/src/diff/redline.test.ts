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

  // The rewritten middle paragraph itself should read as a clean
  // strikethrough block followed by a clean inserted block (each may be
  // several adjacent clause-level Change objects, which render seamlessly
  // as one block), not a scrambled word-by-word interleaving of the two
  // unrelated sentences.
  const removedText = changes.filter((c) => c.removed).map((c) => c.value).join("");
  const addedText = changes.filter((c) => c.added).map((c) => c.value).join("");
  assert.ok(removedText.includes("subject to any confidentiality obligation"));
  assert.ok(addedText.includes("otherwise reflects, to any degree"));
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
  const removedText = changes.filter((c) => c.removed).map((c) => c.value).join("");

  // The removed text must start with "that is" — not a stray leading quote
  // torn off the end of the preceding (unchanged) `"confidential,"` clause.
  assert.ok(
    removedText.trim().startsWith("that is"),
    `expected removed text to start with "that is", got: ${JSON.stringify(removedText)}`
  );
  assert.ok(!removedText.includes('"'), `expected no stray quote in removed text: ${JSON.stringify(removedText)}`);
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

test("computeRedline doesn't mismatch renumbered paragraphs after an inserted numbered paragraph", () => {
  // Inserting a whole new numbered paragraph shifts every numbered
  // paragraph after it on the new side — paragraph 3 becomes paragraph 4 —
  // even though its actual content is unchanged. The diff must still
  // recognize it as the same paragraph rather than pairing it with the
  // wrong neighbor and duplicating text (the original bug) — but a pure
  // renumbering is still a real, visible change: it must show up as a
  // struck-through old number replaced by the new one, not be silently
  // swapped in as if nothing happened (see the next assertions).
  const oldText =
    "1. First paragraph unchanged.\n\n" +
    "2. Second paragraph unchanged.\n\n" +
    "3. Third paragraph unchanged.";
  const newText =
    "1. First paragraph unchanged.\n\n" +
    "2. Second paragraph unchanged.\n\n" +
    "3. A brand new inserted paragraph.\n\n" +
    "4. Third paragraph unchanged.";

  const { changes, paragraphStatus } = computeRedline(oldText, newText);

  assert.deepEqual(paragraphStatus.old, ["unchanged", "unchanged", "changed"]);
  assert.deepEqual(paragraphStatus.new, ["unchanged", "unchanged", "added", "changed"]);

  const added = changes.filter((c) => c.added).map((c) => c.value.trim());
  const removed = changes.filter((c) => c.removed).map((c) => c.value.trim());
  assert.deepEqual(added, ["3. A brand new inserted paragraph.", "4"]);
  assert.deepEqual(removed, ["3"]);

  // The renumbered final paragraph must appear exactly once, with its new
  // number, not duplicated or glued onto another paragraph's text.
  const fullText = changes.map((c) => c.value).join("");
  assert.equal(fullText.match(/Third paragraph unchanged\./g)?.length, 1);
  assert.ok(fullText.includes("Third paragraph unchanged."));
});

test("computeRedline doesn't split a clause on a comma inside a bracketed placeholder", () => {
  // A comma inside a filled-in template blank — an address, a company name
  // — is part of that one value, not a clause boundary. Splitting there
  // anyway mismatches the clause counts between old and new (one blank
  // becomes several "clauses"), which is exactly what made two unrelated
  // placeholders get paired against each other.
  const oldText = "and [•], a [•] [•] located at [•].";
  const newText = "and [Data Center, LLC], a [Texas Limited Liability Company] [] located at [2722 Travis, Houston TX 77002].";

  const { changes } = computeRedline(oldText, newText);
  const removed = changes.filter((c) => c.removed).map((c) => c.value);
  const added = changes.filter((c) => c.added).map((c) => c.value);

  assert.deepEqual(removed, ["•", "•", "•", "•"]);
  assert.deepEqual(added, ["Data Center, LLC", "Texas Limited Liability Company", "2722 Travis, Houston TX 77002"]);

  // Each blank's whole filled-in value must appear as a single addition —
  // not torn apart at its own internal comma.
  assert.ok(added.some((a) => a === "Data Center, LLC"));
  assert.ok(added.some((a) => a === "2722 Travis, Houston TX 77002"));
});

test("computeRedline doesn't join multiple unmatched clauses into one blob before diffing", () => {
  // A comma inserted mid-sentence on the new side splits what was one old
  // clause into three new clauses. diffArrays groups all three into a
  // single chunk's multi-element .value — diffParagraph must pair them up
  // clause-by-clause against the (single) old clause, not join the whole
  // run into one string and word-diff that blob, which would let LCS match
  // words (e.g. "posting of bond") across clauses that aren't actually each
  // other's counterpart.
  const oldText =
    "Discloser shall be entitled to equitable relief without the posting of bond or other security. " +
    "Recipient waives any claim or defense.";
  const newText =
    "Discloser shall be entitled to equitable relief, subject to the court's discretion and to the showing required by law, " +
    "including as to the posting of bond or other security. " +
    "Recipient waives any claim or defense.";

  const { changes } = computeRedline(oldText, newText);

  const removed = changes.filter((c) => c.removed).map((c) => c.value.trim());
  const added = changes.filter((c) => c.added).map((c) => c.value.trim());

  assert.deepEqual(removed, ["without the posting of bond or other security."]);
  assert.deepEqual(added, [
    ",",
    "subject to the court's discretion and to the showing required by law,",
    "including as to the posting of bond or other security.",
  ]);

  // "posting of bond or other security" must appear once on each side, not
  // get matched as unchanged across the two unrelated clauses that both
  // happen to contain it.
  const unchangedText = changes.filter((c) => !c.added && !c.removed).map((c) => c.value).join("");
  assert.ok(!unchangedText.includes("posting of bond"));
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
