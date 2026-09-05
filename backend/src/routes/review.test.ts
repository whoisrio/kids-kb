/** 资料 API（旧静态复核页的 React 化）：读路径直连 PG，图片从 storageRoot 回传。 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { Hono } from "hono";
import { resetDbForTest } from "../db.js";
import { reviewRoutes } from "./review.js";
import type { SearchHit } from "../retrieval/search.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

maybe("review API（真库）", () => {
  let pool: pg.Pool;
  let app: Hono;
  let tmpRoot: string;
  let storageRoot: string;
  let docId = "";
  let flatDocId = "";
  let page1 = "";
  let page2 = "";
  let block11 = "";
  let block12 = "";

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-review-test-"));
    storageRoot = join(tmpRoot, "pipeline", "storage");
    app = new Hono();
    app.route("/api/review", reviewRoutes(pool, {
      search: async () => [] as SearchHit[],
      pipelineUrl: "http://127.0.0.1:8766",
      storageRoot,
    }));

    const doc = await pool.query(
      `INSERT INTO documents (title, subject, doc_type, source_path, status)
       VALUES ('口算天天练','数学','workbook','/tmp/a.pdf','parsed') RETURNING id::text`);
    docId = doc.rows[0].id;
    const mkPage = async (pageNo: number) =>
      (await pool.query(
        `INSERT INTO pages (document_id, page_no, image_path, status)
         VALUES ($1,$2,$3,'parsed') RETURNING id::text`,
        [docId, pageNo, join("storage", docId, "pages", `p${String(pageNo).padStart(4, "0")}.png`)],
      )).rows[0].id;
    page1 = await mkPage(1);
    page2 = await mkPage(2);
    const pagesDir = join(storageRoot, docId, "pages");
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, "p0001.png"), PNG_1PX);
    writeFileSync(join(pagesDir, "p0002.png"), PNG_1PX);
    const mkBlock = async (pageId: string, type: string, content: string | null, bbox: number[] | null) =>
      (await pool.query(
        `INSERT INTO blocks (page_id, block_type, bbox, crop_path, content_md)
         VALUES ($1,$2,$3,$4,$5) RETURNING id::text`,
        [pageId, type, JSON.stringify(bbox), join("storage", docId, "blocks", `${pageId}-${type}.png`), content],
      )).rows[0].id;
    block11 = await mkBlock(page1, "text", "24+37=61", [10, 20, 200, 80]);
    block12 = await mkBlock(page1, "header", "第 1 页", null);
    const blocksDir = join(storageRoot, docId, "blocks");
    mkdirSync(blocksDir, { recursive: true });
    writeFileSync(join(blocksDir, `${page1}-text.png`), PNG_1PX);
    await pool.query(
      "INSERT INTO review_queue (block_id, reason) VALUES ($1,'empty')", [block12]);
    await pool.query(
      "INSERT INTO review_queue (page_id, reason, status) VALUES ($1,'版面歪斜','approved')", [page2]);

    const flatDoc = await pool.query(
      `INSERT INTO documents (title, subject, doc_type, source_path, status, struct_mode)
       VALUES ('学霸提优大试卷','数学','exam','/tmp/b.pdf','parsed','flat') RETURNING id::text`);
    flatDocId = flatDoc.rows[0].id;
    const fp = await pool.query(
      `INSERT INTO pages (document_id, page_no, image_path, status, adopted_source, page_md)
       VALUES ($1,1,$2,'parsed','page_md','第二套 竖式计算') RETURNING id::text`,
      [flatDocId, join("storage", flatDocId, "pages", "p0001.png")]);
    const fDir = join(storageRoot, flatDocId, "pages");
    mkdirSync(fDir, { recursive: true });
    writeFileSync(join(fDir, "p0001.png"), PNG_1PX);
    await pool.query(
      "INSERT INTO chapters (document_id, chapter_no, title, content_md) VALUES ($1,1,'学霸提优大试卷','第二套 竖式计算')",
      [flatDocId]);
    void fp;
  });
  afterAll(async () => { await pool.end(); });

  it("GET /docs：文档列表带 pending_pages 徽标数", async () => {
    const resp = await app.request("/api/review/docs");
    expect(resp.status).toBe(200);
    const docs = (await resp.json()) as { id: string; title: string; pending_pages: number; struct_mode: string | null }[];
    const d = docs.find((x) => x.id === docId)!;
    expect(d).toMatchObject({ title: "口算天天练", subject: "数学", doc_type: "workbook", pending_pages: 1 });
    expect(docs.find((x) => x.id === flatDocId)!.struct_mode).toBe("flat");
  });

  it("GET /pages?status=pending|approved：按复核行推导分桶，可按 doc_id 过滤", async () => {
    const pending = (await (await app.request(`/api/review/pages?status=pending`)).json()) as {
      pages: { id: string; page_no: number; doc_title: string; pending_reasons: string[] }[];
    };
    expect(pending.pages.map((p) => p.page_no)).toEqual([1]);
    expect(pending.pages[0]).toMatchObject({ doc_title: "口算天天练", pending_reasons: ["empty"] });
    const approved = (await (await app.request(
      `/api/review/pages?status=approved&doc_id=${docId}`,
    )).json()) as { pages: { page_no: number }[] };
    expect(approved.pages.map((p) => p.page_no)).toEqual([2]);
  });

  it("GET /pages/:id：页详情（块含 pending 行明细，页级 pending 行单列）", async () => {
    const resp = await app.request(`/api/review/pages/${page1}`);
    expect(resp.status).toBe(200);
    const d = (await resp.json()) as {
      id: string; page_no: number; doc_title: string; image_url: string;
      blocks: { id: string; block_type: string; bbox: number[] | null; content_md: string | null; pending: { reason: string }[] }[];
      page_pending: { reason: string }[];
    };
    expect(d.page_no).toBe(1);
    expect(d.image_url).toBe(`/api/review/pages/${page1}/image`);
    expect(d.blocks).toHaveLength(2);
    const text = d.blocks.find((b) => b.id === block11)!;
    expect(text).toMatchObject({ block_type: "text", content_md: "24+37=61", bbox: [10, 20, 200, 80], pending: [] });
    expect(d.blocks.find((b) => b.id === block12)!.pending).toEqual([
      { id: expect.any(String), reason: "empty" },
    ]);
  });

  it("GET /pages/:id/image 与 /blocks/:id/crop：相对路径按 pipeline 根解析回传 PNG；缺失 404", async () => {
    const img = await app.request(`/api/review/pages/${page1}/image`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    const crop = await app.request(`/api/review/blocks/${block11}/crop`);
    expect(crop.status).toBe(200);
    const missing = await app.request("/api/review/pages/00000000-0000-0000-0000-000000000000/image");
    expect(missing.status).toBe(404);
  });

  it("GET /pages/:id 不存在 → 404；id 非法 → 422", async () => {
    expect((await app.request("/api/review/pages/not-a-uuid")).status).toBe(422);
    expect((await app.request("/api/review/pages/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
});
