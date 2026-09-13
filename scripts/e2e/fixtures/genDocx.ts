import { Document, Packer, Paragraph, TextRun } from "docx";
import fs from "node:fs";

export async function genFixture(outPath: string, paragraphs: string[]): Promise<void> {
  const doc = new Document({
    sections: [{ children: paragraphs.map((p) => new Paragraph({ children: [new TextRun(p)] })) }],
  });
  fs.writeFileSync(outPath, await Packer.toBuffer(doc));
}

// Allow direct CLI use: tsx genDocx.ts <outPath> <paragraph> [paragraph...]
if (process.argv[1] && process.argv[1].endsWith("genDocx.ts")) {
  const [, , outPath, ...paragraphs] = process.argv;
  await genFixture(outPath, paragraphs);
}
