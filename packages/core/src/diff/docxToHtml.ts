import mammoth from "mammoth";

export async function docxBufferToHtml(buf: Buffer): Promise<string> {
  const { value } = await mammoth.convertToHtml({ buffer: buf });
  return value;
}

export async function docxBufferToText(buf: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return value;
}
