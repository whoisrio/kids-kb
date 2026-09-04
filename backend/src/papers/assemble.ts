/** 上传文件归一化:多张 JPG/PNG(每图一页)+ 可选 PDF → 合成单个 PDF。 */
import { PDFDocument } from "pdf-lib";

export interface UploadFileInput {
  name: string;
  bytes: Uint8Array;
}

const ALLOWED = /\.(pdf|jpe?g|png)$/i;

export async function assemblePdf(
  files: UploadFileInput[],
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  if (files.length === 0) throw new Error("至少上传一个文件(PDF/JPG/PNG)");
  const doc = await PDFDocument.create();
  for (const f of files) {
    if (!ALLOWED.test(f.name)) throw new Error(`不支持的文件类型: ${f.name}(仅 PDF/JPG/PNG)`);
    if (/\.pdf$/i.test(f.name)) {
      let src: Awaited<ReturnType<typeof PDFDocument.load>>;
      try {
        src = await PDFDocument.load(f.bytes);
      } catch {
        throw new Error(`PDF 无法解析(文件损坏或加密): ${f.name}`);
      }
      const pages = await doc.copyPages(src, src.getPageIndices());
      pages.forEach((p) => doc.addPage(p));
    } else if (/\.jpe?g$/i.test(f.name)) {
      const img = await doc.embedJpg(f.bytes);
      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    } else {
      const img = await doc.embedPng(f.bytes);
      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
  }
  return { bytes: await doc.save(), pageCount: doc.getPageCount() };
}
