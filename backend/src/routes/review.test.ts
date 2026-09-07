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
  let textDocId = "";
  let page1 = "";
  let page2 = "";
  let block11 = "";
  let block12 = "";
  let itemId = "";

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
      `INSERT INTO documents (title, subject, doc_type, source_path, parse_status)
       VALUES ('口算天天练','数学','workbook','/tmp/a.pdf','parsed') RETURNING id::text`);
    docId = doc.rows[0].id;
    const mkPage = async (pageNo: number) =>
      (await pool.query(
        `INSERT INTO pages (document_id, page_no, image_path, parse_status)
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
      `INSERT INTO documents (title, subject, doc_type, source_path, parse_status, struct_mode)
       VALUES ('学霸提优大试卷','数学','exam','/tmp/b.pdf','parsed','flat') RETURNING id::text`);
    flatDocId = flatDoc.rows[0].id;
    const fp = await pool.query(
      `INSERT INTO pages (document_id, page_no, image_path, parse_status, adopted_source, page_md)
       VALUES ($1,1,$2,'parsed','page_md','第二套 竖式计算') RETURNING id::text`,
      [flatDocId, join("storage", flatDocId, "pages", "p0001.png")]);
    const fDir = join(storageRoot, flatDocId, "pages");
    mkdirSync(fDir, { recursive: true });
    writeFileSync(join(fDir, "p0001.png"), PNG_1PX);
    await pool.query(
      "INSERT INTO chapters (document_id, chapter_no, title, content_md) VALUES ($1,1,'学霸提优大试卷','第二套 竖式计算')",
      [flatDocId]);
    void fp;

    const item = await pool.query(
      `INSERT INTO items (document_id, content_type, label, content_md, chapter, taxonomy, tags, qc_status)
       VALUES ($1,'exercise','例 1','24+37=61','第 1 讲 加法','计算类',ARRAY['口算','进位加'],'pending')
       RETURNING id::text`, [docId]);
    itemId = item.rows[0].id;
    await pool.query(
      "INSERT INTO item_blocks (item_id, block_id, role) VALUES ($1,$2,'stem')", [itemId, block11]);
    await pool.query(
      "INSERT INTO review_queue (item_id, reason) VALUES ($1,'ungrounded:例 1 摘录')", [itemId]);

    const textDoc = await pool.query(
      `INSERT INTO documents (title, subject, doc_type, source_path, page_count, parse_status)
       VALUES ('英语语法测试','英语','workbook','/tmp/c.docx',0,'parsed') RETURNING id::text`);
    textDocId = textDoc.rows[0].id;
    await pool.query(
      "INSERT INTO chapters (document_id, chapter_no, title, content_md) VALUES ($1,1,'英语语法测试','一、单项选择')",
      [textDocId],
    );
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

  it("GET /items?doc_id=&status=pending：qc pending 或有 pending 复核行的条目", async () => {
    const resp = await app.request(`/api/review/items?doc_id=${docId}&status=pending`);
    expect(resp.status).toBe(200);
    const { items } = (await resp.json()) as {
      items: { id: string; label: string; chapter: string; qc_status: string; pending_reasons: string[] }[];
    };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: itemId, label: "例 1", chapter: "第 1 讲 加法", qc_status: "pending",
      pending_reasons: ["ungrounded:例 1 摘录"],
    });
  });

  it("GET /chapters：无页文本资料的内容可见，可按 doc_id 过滤", async () => {
    const resp = await app.request(`/api/review/chapters?doc_id=${textDocId}`);
    expect(resp.status).toBe(200);
    const { chapters } = (await resp.json()) as {
      chapters: { id: string; doc_title: string; chapter_no: number; title: string; content_md: string }[];
    };
    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({
      doc_title: "英语语法测试", chapter_no: 1, title: "英语语法测试", content_md: "一、单项选择",
    });
  });

  it("GET /items/:id：详情 + grounding 块（带裁图 URL）+ 复核行", async () => {
    const resp = await app.request(`/api/review/items/${itemId}`);
    expect(resp.status).toBe(200);
    const d = (await resp.json()) as {
      content_md: string; taxonomy: string | null; tags: string[] | null;
      blocks: { id: string; role: string; content_md: string | null; crop_url: string }[];
      reviews: { reason: string; status: string }[];
    };
    expect(d.content_md).toBe("24+37=61");
    expect(d.taxonomy).toBe("计算类");
    expect(d.blocks).toEqual([
      { id: block11, role: "stem", block_type: "text", content_md: "24+37=61", source_model: null,
        crop_url: `/api/review/blocks/${block11}/crop` },
    ]);
    expect(d.reviews[0]).toMatchObject({ reason: "ungrounded:例 1 摘录", status: "pending" });
  });

  it("GET /search?q=：复用注入的检索（带 subject 过滤透传）", async () => {
    let seen: { q: string; filters?: Record<string, string> } | null = null;
    const a = new Hono();
    a.route("/api/review", reviewRoutes(pool, {
      search: async (q, filters) => { seen = { q, filters }; return [{ item_id: itemId, document_id: docId, content_md: "命中", score: 1 }]; },
      pipelineUrl: "http://x", storageRoot,
    }));
    const resp = await a.request("/api/review/search?q=竖式计算&subject=数学");
    expect(resp.status).toBe(200);
    expect((await resp.json()).hits).toHaveLength(1);
    expect(seen).toEqual({ q: "竖式计算", filters: { subject: "数学" } });
    expect((await a.request("/api/review/search?q=")).status).toBe(422);
  });

  it("PATCH /blocks/:id：编辑转录（纯 DB 写，不刷镜像）", async () => {
    const resp = await app.request(`/api/review/blocks/${block11}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_md: "24+37=61（改）" }),
    });
    expect(resp.status).toBe(200);
    const row = (await pool.query("SELECT content_md FROM blocks WHERE id=$1", [block11])).rows[0];
    expect(row.content_md).toBe("24+37=61（改）");
    expect((await app.request("/api/review/blocks/00000000-0000-0000-0000-000000000000", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_md: "x" }),
    })).status).toBe(404);
  });

  it("PATCH /items/:id：编辑条目内容并作废旧向量", async () => {
    await pool.query(
      `INSERT INTO chunks (item_id, document_id, content_md, meta, embedding)
       VALUES ($1,$2,'旧内容','{}'::jsonb, $3::vector)`,
      [itemId, docId, `[${Array.from({ length: 1024 }, () => 1.0).join(",")}]`]);
    const resp = await app.request(`/api/review/items/${itemId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_md: "24+37=61（条目改）" }),
    });
    expect(resp.status).toBe(200);
    expect((await pool.query("SELECT content_md FROM items WHERE id=$1", [itemId])).rows[0].content_md)
      .toBe("24+37=61（条目改）");
    expect((await pool.query("SELECT count(*)::int AS n FROM chunks WHERE item_id=$1", [itemId])).rows[0].n)
      .toBe(0);
  });

  it("PATCH /pages/:id：编辑整页稿并删除相关页 chunk", async () => {
    const vec = `[${Array.from({ length: 1024 }, () => 1.0).join(",")}]`;
    await pool.query(
      `INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding, page_no)
       SELECT ch.id, ch.document_id, 1, '旧整页稿', '{}'::jsonb, $1::vector, 1
       FROM chapters ch WHERE ch.document_id=$2`,
      [vec, docId]);
    const res = await app.request(`/api/review/pages/${page1}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_md: "# 第 1 页\n新整页稿" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ id: page1, page_md: "# 第 1 页\n新整页稿", index_status: "stale" });
    expect((await pool.query("SELECT count(*)::int AS n FROM chunks WHERE document_id=$1", [docId])).rows[0].n).toBe(0);
  });

  it("POST /blocks/:id/annotations 与 PATCH/DELETE：管理 OCR 批注", async () => {
    const created = await app.request(`/api/review/blocks/${block11}/annotations`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "先检查进位" }),
    });
    expect(created.status).toBe(201);
    const annotation = (await created.json()) as { id: string };
    const updated = await app.request(`/api/review/block-annotations/${annotation.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "先检查括号" }),
    });
    expect(updated.status).toBe(200);
    expect((await pool.query("SELECT body FROM block_annotations WHERE id=$1", [annotation.id])).rows[0].body).toBe("先检查括号");
    const removed = await app.request(`/api/review/block-annotations/${annotation.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect((await pool.query("SELECT count(*)::int AS n FROM block_annotations WHERE id=$1", [annotation.id])).rows[0].n).toBe(0);
  });

  it("POST /pages/:id/reject 与 /items/:id/reject：建 pending 复核行（body.reason 必填）", async () => {
    const r1 = await app.request(`/api/review/pages/${page2}/reject`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "缺题" }),
    });
    expect(r1.status).toBe(201);
    const row = (await pool.query(
      "SELECT reason, status FROM review_queue WHERE page_id=$1 ORDER BY created_at DESC LIMIT 1",
      [page2])).rows[0];
    expect(row).toMatchObject({ reason: "缺题", status: "pending" });
    const r2 = await app.request(`/api/review/items/${itemId}/reject`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "串章" }),
    });
    expect(r2.status).toBe(201);
    expect((await app.request(`/api/review/pages/${page2}/reject`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })).status).toBe(422);
  });

  it("POST /pages/:id/adopt：采用版本切换（page_md 需已有整页转录）", async () => {
    const bad = await app.request(`/api/review/pages/${page2}/adopt`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "page_md" }),
    });
    expect(bad.status).toBe(409);
    await pool.query("UPDATE pages SET page_md='整页稿', page_md_model='qwen' WHERE id=$1", [page2]);
    const ok = await app.request(`/api/review/pages/${page2}/adopt`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "page_md" }),
    });
    expect(ok.status).toBe(200);
    expect((await pool.query("SELECT adopted_source FROM pages WHERE id=$1", [page2])).rows[0].adopted_source)
      .toBe("page_md");
  });

  it("POST /pages/:id/approve：关闭该页 pending 行；flat 文档同时调 /internal/embed-flat-page（失败不回滚行）", async () => {
    const calls: { doc_id: string; page_no: number }[] = [];
    const stubPipeline = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/internal/embed-flat-page")) {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ chunks: 1 }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/internal/")) return new Response("{}", {
        status: 200, headers: { "Content-Type": "application/json" },
      });
      return new Response("no route", { status: 404 });
    };
    const a = new Hono();
    a.route("/api/review", reviewRoutes(pool, {
      search: async () => [], pipelineUrl: "http://pipeline.test", storageRoot,
    }));
    const { vi } = await import("vitest");
    vi.stubGlobal("fetch", stubPipeline);
    try {
      const r1 = await a.request(`/api/review/pages/${page1}/approve`, { method: "POST" });
      expect(r1.status).toBe(200);
      expect((await r1.json()).resolved).toBe(1);
      expect((await pool.query(
        "SELECT count(*)::int AS n FROM review_queue WHERE block_id=$1 AND status='pending'",
        [block12])).rows[0].n).toBe(0);
      expect(calls).toEqual([]);

      const flatPage = (await pool.query(
        "SELECT id::text FROM pages WHERE document_id=$1", [flatDocId])).rows[0].id;
      const r2 = await a.request(`/api/review/pages/${flatPage}/approve`, { method: "POST" });
      expect(r2.status).toBe(200);
      const body2 = await r2.json();
      expect(body2.embedded).toBe(1);
      expect(calls).toEqual([{ doc_id: flatDocId, page_no: 1 }]);

      vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
      const r3 = await a.request(`/api/review/pages/${flatPage}/approve`, { method: "POST" });
      expect(r3.status).toBe(200);
      const body3 = await r3.json();
      expect(body3.embed_error).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("POST /items/:id/approve 与 /pages/:id/page-vlm：转发 internal，透传响应/错误", async () => {
    const { vi } = await import("vitest");
    const posts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" || url.includes("approve-item") || url.includes("page-vlm")) {
        posts.push(url);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("no route", { status: 404 });
    });
    const a = new Hono();
    a.route("/api/review", reviewRoutes(pool, {
      search: async () => [], pipelineUrl: "http://pipeline.test", storageRoot,
    }));
    try {
      const r1 = await a.request(`/api/review/items/${itemId}/approve`, { method: "POST" });
      expect(r1.status).toBe(200);
      expect(await r1.json()).toEqual({ ok: true });
      const r2 = await a.request(`/api/review/pages/${page1}/page-vlm`, { method: "POST" });
      expect(r2.status).toBe(200);
      expect(posts[0]).toBe("http://pipeline.test/internal/approve-item?item_id=" + itemId);
      expect(posts[1]).toBe("http://pipeline.test/internal/page-vlm");
      vi.stubGlobal("fetch", async () => { throw new Error("ECONNREFUSED"); });
      const r3 = await a.request(`/api/review/items/${itemId}/approve`, { method: "POST" });
      expect(r3.status).toBe(502);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GET /pages/:id/index-preview：转发 pipeline 切分预览", async () => {
    const { vi } = await import("vitest");
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ page_id: page1, chunks: [{ seq: 1, content_preview: "例 1" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request(`/api/review/pages/${page1}/index-preview`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ page_id: page1, chunks: [{ seq: 1 }] });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8766/internal/index-preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_id: page1 }),
    });
    vi.unstubAllGlobals();
  });
});
