import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { assemblePdf } from "./assemble.js";

// 1x1 透明 PNG(固定 base64;JPG 基准样例见下,若解析失败可用 pipeline 重新生成:
// uv run --project ../pipeline python -c "import pymupdf as f; p=f.Pixmap(f.csRGB,f.IRect(0,0,1,1)); p.clear_with(255); p.save('/tmp/1x1.jpg')"
// 然后 base64 < /tmp/1x1.jpg 替换)
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPG_1PX =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

const png = (name = "a.png") => ({ name, bytes: Uint8Array.from(atob(PNG_1PX), (c) => c.charCodeAt(0)) });
const jpg = (name = "a.jpg") => ({ name, bytes: Uint8Array.from(atob(JPG_1PX), (c) => c.charCodeAt(0)) });

describe("assemblePdf", () => {
  it("多张图片按顺序合成,每图一页", async () => {
    const { bytes, pageCount } = await assemblePdf([png("1.png"), jpg("2.jpg")]);
    expect(pageCount).toBe(2);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
  });

  it("PDF 直接并入(单 PDF 上传)", async () => {
    const src = await PDFDocument.create();
    src.addPage([300, 400]);
    src.addPage([300, 400]);
    const { pageCount } = await assemblePdf([
      { name: "x.pdf", bytes: await src.save() },
    ]);
    expect(pageCount).toBe(2);
  });

  it("空列表抛错;不支持的扩展名抛错", async () => {
    await expect(assemblePdf([])).rejects.toThrow("至少");
    await expect(assemblePdf([{ name: "a.heic", bytes: new Uint8Array() }])).rejects.toThrow("不支持的文件类型");
  });

  it("坏 PDF(垃圾字节)报可读错误而非 pdf-lib 内部报错", async () => {
    await expect(assemblePdf([
      { name: "corrupt.pdf", bytes: new TextEncoder().encode("junk junk junk") },
    ])).rejects.toThrow(/PDF 无法解析.*corrupt\.pdf/);
  });
});
