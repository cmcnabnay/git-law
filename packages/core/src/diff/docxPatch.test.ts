import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { saveEditsToDocx, type XmlImpl } from "./docxPatch.js";
import { docxBufferToHtml } from "./docxToHtml.js";
import { htmlToNumberedText } from "./numberedText.js";
import { ROW_START, CELL_SEP } from "./tableMarkers.js";

const xml: XmlImpl = {
  parse: (s) => new DOMParser().parseFromString(s, "application/xml") as unknown as Document,
  serialize: (d) => new XMLSerializer().serializeToString(d as any),
};

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

async function makeDocx(bodyXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W_NS}"><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`
  );
  return zip.generateAsync({ type: "uint8array" });
}

async function documentXml(bytes: Uint8Array): Promise<string> {
  return (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
}

async function blocksOf(bytes: Uint8Array): Promise<string[]> {
  const text = htmlToNumberedText(await docxBufferToHtml(Buffer.from(bytes)));
  return text.split("\n\n").filter(Boolean);
}

async function paragraphsOf(bytes: Uint8Array): Promise<string[]> {
  return (await blocksOf(bytes)).filter((b) => !b.startsWith(ROW_START));
}

async function rowsOf(bytes: Uint8Array): Promise<string[][]> {
  return (await blocksOf(bytes)).filter((b) => b.startsWith(ROW_START)).map((b) => b.slice(1).split(CELL_SEP));
}

function saveParagraphEditsToDocx(bytes: Uint8Array, original: string[], edited: string[], impl: XmlImpl) {
  return saveEditsToDocx(bytes, { paragraphs: original, rows: [] }, { paragraphs: edited, rows: [] }, impl);
}

const BODY =
  `<w:p><w:r><w:t>This Agreement is between </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Seller</w:t></w:r><w:r><w:t xml:space="preserve"> and Buyer &amp; Co.</w:t></w:r></w:p>` +
  `<w:p/>` +
  `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Second paragraph.</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t>Third paragraph.</w:t></w:r></w:p>`;

test("an edited paragraph keeps the formatting of the text around the edit", async () => {
  const bytes = await makeDocx(BODY);
  const original = await paragraphsOf(bytes);
  assert.deepEqual(original, ["This Agreement is between Seller and Buyer & Co.", "Second paragraph.", "Third paragraph."]);

  const edited = ["This Agreement is between Seller and the Buyer & Co.", original[1], original[2]];
  const out = await saveParagraphEditsToDocx(bytes, original, edited, xml);

  assert.deepEqual(await paragraphsOf(out), edited);
  const docXml = await documentXml(out);
  assert.match(docXml, /<w:b\/><\/w:rPr><w:t xml:space="preserve">Seller<\/w:t>/, "bold run survives");
  assert.match(docXml, /<w:jc w:val="center"\/>/, "untouched paragraph keeps its properties");
});

test("paragraphs can be removed and inserted", async () => {
  const bytes = await makeDocx(BODY);
  const original = await paragraphsOf(bytes);
  const edited = [original[0], "A brand new paragraph.", original[2]];
  const out = await saveParagraphEditsToDocx(bytes, original, edited, xml);
  assert.deepEqual(await paragraphsOf(out), edited);
});

test("a paragraph added after the last one lands before the section properties", async () => {
  const bytes = await makeDocx(BODY);
  const original = await paragraphsOf(bytes);
  const edited = [...original, "Closing paragraph."];
  const out = await saveParagraphEditsToDocx(bytes, original, edited, xml);
  assert.deepEqual(await paragraphsOf(out), edited);
  assert.match(await documentXml(out), /Closing paragraph\.<\/w:t><\/w:r><\/w:p><w:sectPr\/>/);
});

test("a numbered paragraph is matched without its rendered number, which isn't written into the text", async () => {
  const numbered = `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Sale of Goods.</w:t></w:r></w:p>`;
  const bytes = await makeDocx(numbered);
  const original = ["1. Sale of Goods."];
  const out = await saveParagraphEditsToDocx(bytes, original, ["1. Sale of Widgets."], xml);
  const docXml = await documentXml(out);
  assert.match(docXml, /Sale of /);
  assert.match(docXml, /Widgets\./);
  assert.doesNotMatch(docXml, /1\. /);
  assert.match(docXml, /<w:numId w:val="1"\/>/);
});

test("editing a paragraph that can't be found in the file fails instead of guessing", async () => {
  const bytes = await makeDocx(BODY);
  await assert.rejects(
    saveParagraphEditsToDocx(bytes, ["Not in the document."], ["Changed."], xml),
    /Couldn't find this paragraph/
  );
});

// A contract laid out the way Word users often type one: section numbers
// and "(a)" labels as plain text, sub-paragraphs indented, section titles
// underlined, and a table belonging to one section.
const run = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const section = (n: number, title: string, body = "") =>
  `<w:p>${run(`${n}.  `)}${run(title, `<w:u w:val="single"/>`)}${body ? run(` ${body}`) : ""}</w:p>`;
const sub = (label: string, text: string, rPr = "") => `<w:p><w:pPr><w:ind w:left="360"/></w:pPr>${run(`    (${label})  `)}${run(text, rPr)}</w:p>`;
const table = (rows: string[][]) =>
  `<w:tbl>${rows.map((cells) => `<w:tr>${cells.map((c) => `<w:tc><w:p>${run(c)}</w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;

const CONTRACT =
  section(1, "Limitation of Liability.") +
  sub("a", "IN NO EVENT SHALL EITHER PARTY BE LIABLE.", "<w:b/>") +
  sub("b", "The Seller shall not be liable for delays.") +
  section(2, "Compliance with Law.", "Each party shall comply with all laws.") +
  section(3, "Termination.", "Either party may terminate this Agreement.") +
  section(4, "Notices.", "All notices shall be in writing and addressed as follows:") +
  table([["Notice to Seller:", "2301 Tech Drive"], ["Notice to Buyer:", "2722 Travis Street"]]) +
  section(5, "Severability.", "If any term is invalid, the rest survives.");

test("inserting a section keeps every renumbered section in its own paragraph, with its table", async () => {
  const bytes = await makeDocx(CONTRACT);
  const original = await paragraphsOf(bytes);
  const at = original.findIndex((p) => p.startsWith("2."));
  const renumber = (p: string) => p.replace(/^(\d+)\./, (_, n) => `${Number(n) + 1}.`);
  const edited = [
    ...original.slice(0, at + 1),
    "3. Indemnification.",
    "(a) Each Party shall indemnify the other.",
    "(b) Buyer shall defend Seller.",
    ...original.slice(at + 1).map(renumber),
  ];
  const out = await saveParagraphEditsToDocx(bytes, original, edited, xml);

  const blocks = await blocksOf(out);
  const notices = blocks.findIndex((b) => b.startsWith("5.  Notices."));
  assert.ok(notices >= 0, "Notices kept its own paragraph, renumbered");
  assert.ok(blocks[notices + 1].startsWith(ROW_START), "the table still follows Notices");

  const docXml = await documentXml(out);
  // Renumbered sections were edited in place: the title run is still underlined.
  assert.match(docXml, /<w:t xml:space="preserve">4\.  <\/w:t><\/w:r><w:r><w:rPr><w:u w:val="single"\/><\/w:rPr><w:t xml:space="preserve">Termination\./);
  // The new heading is styled like the other headings: only its title underlined.
  assert.match(docXml, /<w:t xml:space="preserve">3\. <\/w:t><\/w:r><w:r><w:rPr><w:u w:val="single"\/><\/w:rPr><w:t xml:space="preserve">Indemnification\.<\/w:t>/);
  // New sub-paragraphs are indented like the others, label not underlined,
  // text plain (not bold like the all-caps disclaimer above them).
  const newSub = docXml.match(/<w:p>(?:(?!<\/w:p>).)*Each Party shall indemnify(?:(?!<\/w:p>).)*<\/w:p>/)![0];
  assert.match(newSub, /<w:ind w:left="360"\/>/);
  assert.match(newSub, /<w:t xml:space="preserve">    <\/w:t>/);
  assert.doesNotMatch(newSub, /<w:u |<w:b\/>/);
});

test("edits in table cells are written into those cells", async () => {
  const bytes = await makeDocx(CONTRACT);
  const original = { paragraphs: await paragraphsOf(bytes), rows: await rowsOf(bytes) };
  assert.deepEqual(original.rows, [["Notice to Seller:", "2301 Tech Drive"], ["Notice to Buyer:", "2722 Travis Street"]]);
  const edited = { ...original, rows: [original.rows[0], ["Notice to Buyer:", "100 Main Street, Suite 4"]] };
  const out = await saveEditsToDocx(bytes, original, edited, xml);
  assert.deepEqual(await rowsOf(out), edited.rows);
  assert.deepEqual(await paragraphsOf(out), original.paragraphs);
});

test("a cell faking columns with spaces, and a cell of several paragraphs, keep their layout", async () => {
  const bytes = await makeDocx(
    `<w:tbl><w:tr><w:tc><w:p>${run("Type A      10,000      $1,100")}</w:p></w:tc>` +
      `<w:tc><w:p>${run("2722 Travis")}</w:p><w:p>${run("Houston, TX")}</w:p></w:tc></w:tr></w:tbl>`
  );
  const rows = await rowsOf(bytes);
  assert.deepEqual(rows, [["Type A", "10,000", "$1,100", "2722 Travis Houston, TX"]]);
  const edited = [["Type A", "12,000", "$1,100", "2722 Travis Street Houston, TX"]];
  const out = await saveEditsToDocx(bytes, { paragraphs: [], rows }, { paragraphs: [], rows: edited }, xml);
  assert.deepEqual(await rowsOf(out), edited);
  const docXml = await documentXml(out);
  assert.match(docXml, /Type A      12,000      \$1,100/);
  assert.match(docXml, /2722 Travis Street<\/w:t><\/w:r><\/w:p><w:p>.*Houston, TX/);
});

test("adding or removing table rows in the editor is refused", async () => {
  const bytes = await makeDocx(CONTRACT);
  const rows = await rowsOf(bytes);
  await assert.rejects(
    saveEditsToDocx(bytes, { paragraphs: [], rows }, { paragraphs: [], rows: rows.slice(1) }, xml),
    /can't be added or removed/
  );
});
