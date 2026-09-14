import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToNumberedText } from "./numberedText.js";

test("htmlToNumberedText numbers a flat ordered list like a browser renders it", () => {
  const html = "<ol><li>Definitions.</li><li>Confidentiality Obligations.</li><li>Term.</li></ol>";
  assert.equal(htmlToNumberedText(html), "1. Definitions.\n\n2. Confidentiality Obligations.\n\n3. Term.\n\n");
});

test("htmlToNumberedText restarts numbering inside a nested ordered list", () => {
  const html =
    "<ol><li>Definitions.</li>" +
    "<li>Confidentiality Obligations.<ol><li>Sub point A.</li><li>Sub point B.</li></ol></li>" +
    "<li>Term.</li></ol>";
  assert.equal(
    htmlToNumberedText(html),
    "1. Definitions.\n\n2. Confidentiality Obligations.\n\n1. Sub point A.\n\n2. Sub point B.\n\n3. Term.\n\n"
  );
});

test("htmlToNumberedText leaves unordered list items and plain paragraphs unnumbered", () => {
  const html = "<p>Intro.</p><ul><li>First bullet.</li><li>Second bullet.</li></ul>";
  assert.equal(htmlToNumberedText(html), "Intro.\n\nFirst bullet.\n\nSecond bullet.\n\n");
});

test("htmlToNumberedText doesn't duplicate text from inline formatting", () => {
  const html =
    '<p>The <strong>Recipient</strong> shall keep the <em>Confidential Information</em> secret, as defined <a href="#x">below</a>.</p>';
  assert.equal(
    htmlToNumberedText(html),
    "The Recipient shall keep the Confidential Information secret, as defined below.\n\n"
  );
});

test("htmlToNumberedText doesn't spawn a paragraph per bolded term inside a numbered list item", () => {
  // The <li> branch recurses into each item purely to find a nested
  // <ol>/<ul>; it must not also re-visit inline runs like a bookmark <a> or
  // a <strong>-wrapped defined term as if they were their own paragraphs.
  const html =
    '<ol><li><a id="a1"></a>May disclose to the other party ("<strong>Recipient</strong>") who agrees to keep it confidential (the "<strong>Purpose</strong>").</li></ol>';
  assert.equal(
    htmlToNumberedText(html),
    '1. May disclose to the other party ("Recipient") who agrees to keep it confidential (the "Purpose").\n\n'
  );
});
