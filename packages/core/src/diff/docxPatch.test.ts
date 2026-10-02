import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { saveParagraphEditsToDocx, type XmlImpl } from "./docxPatch.js";
import { docxBufferToHtml } from "./docxToHtml.js";
import { htmlToNumberedText } from "./numberedText.js";

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

async function paragraphsOf(bytes: Uint8Array): Promise<string[]> {
  const text = htmlToNumberedText(await docxBufferToHtml(Buffer.from(bytes)));
  return text.split("\n\n").filter(Boolean);
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
