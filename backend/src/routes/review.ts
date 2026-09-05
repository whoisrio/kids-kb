/** 资料 API：旧静态复核页的 React 化。读路径直连 PostgreSQL，图片从 storageRoot 读盘回传。
    设计：docs/superpowers/specs/2026-09-05-phase3-c-design.md（Workstream B） */
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import type pg from "pg";
import type { SearchHit } from "../retrieval/search.js";

export interface ReviewDeps {
  search: (q: string, filters?: Record<string, string>) => Promise<SearchHit[]>;
  pipelineUrl: string;
  storageRoot: string;
}

function invalidId(c: Context, err: unknown): Response | null {
  return (err as { code?: string })?.code === "22P02"
    ? c.json({ error: "id 格式非法（须为 UUID）" }, 422)
    : null;
}

function resolveStoragePath(storageRoot: string, p: string): string {
  return isAbsolute(p) ? p : join(dirname(storageRoot), p);
}

export function reviewRoutes(pool: pg.Pool, deps: ReviewDeps): Hono {
  const app = new Hono({ strict: false });

  app.get("/docs", async (c) => {
    const { rows } = await pool.query(
      `SELECT d.id::text, d.title, d.subject, d.doc_type, d.status, d.struct_mode,
              count(p.id) FILTER (WHERE coalesce(pr.n, 0) > 0)::int AS pending_pages
       FROM documents d
       LEFT JOIN pages p ON p.document_id = d.id
       LEFT JOIN LATERAL (
         SELECT count(*) AS n FROM review_queue r
         WHERE r.status = 'pending' AND (
           r.page_id = p.id OR r.block_id IN (SELECT id FROM blocks WHERE page_id = p.id))
       ) pr ON true
       GROUP BY d.id ORDER BY d.created_at DESC`);
    return c.json(rows);
  });

  app.get("/pages", async (c) => {
    const status = c.req.query("status") ?? "pending";
    if (status !== "pending" && status !== "approved") {
      return c.json({ error: "status 取值: pending|approved" }, 422);
    }
    const docId = c.req.query("doc_id");
    const having = status === "pending" ? "coalesce(pr.n, 0) > 0" : "coalesce(pr.n, 0) = 0";
    const params: unknown[] = [];
    let docFilter = "";
    if (docId) { docFilter = "AND p.document_id = $1::uuid"; params.push(docId); }
    const { rows } = await pool.query(
      `SELECT p.id::text, p.page_no, d.title AS doc_title, pr.reasons
       FROM pages p
       JOIN documents d ON d.id = p.document_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS n, array_agg(r.reason ORDER BY r.created_at) AS reasons
         FROM review_queue r
         WHERE r.status = 'pending' AND (
           r.page_id = p.id OR r.block_id IN (SELECT id FROM blocks WHERE page_id = p.id))
       ) pr ON true
       WHERE p.status = 'parsed' ${docFilter} AND ${having}
       ORDER BY d.title, p.page_no`, params);
    return c.json({ pages: rows.map((r) => ({ ...r, pending_reasons: r.reasons ?? [] })) });
  });

  app.get("/pages/:id", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
        `SELECT p.id::text, p.page_no, d.title AS doc_title, p.page_md, p.page_md_model, p.adopted_source
         FROM pages p JOIN documents d ON d.id = p.document_id WHERE p.id = $1`,
        [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      const { rows: blocks } = await pool.query(
        `SELECT id::text, block_type, bbox, content_md, source_model
         FROM blocks WHERE page_id = $1 ORDER BY created_at, id`, [page.id]);
      const { rows: pendingRows } = await pool.query(
        `SELECT r.id::text, r.reason, r.block_id::text
         FROM review_queue r LEFT JOIN blocks b ON b.id = r.block_id
         WHERE r.status = 'pending' AND (r.page_id = $1 OR b.page_id = $1)
         ORDER BY r.created_at`, [page.id]);
      const byBlock = new Map<string, { id: string; reason: string }[]>();
      const pagePending: { id: string; reason: string }[] = [];
      for (const r of pendingRows) {
        if (r.block_id) (byBlock.get(r.block_id) ?? byBlock.set(r.block_id, []).get(r.block_id)!).push({ id: r.id, reason: r.reason });
        else pagePending.push({ id: r.id, reason: r.reason });
      }
      return c.json({
        id: page.id, page_no: page.page_no, doc_title: page.doc_title,
        image_url: `/api/review/pages/${page.id}/image`,
        page_md: page.page_md, page_md_model: page.page_md_model,
        adopted_source: page.adopted_source,
        blocks: blocks.map((b) => ({ ...b, pending: byBlock.get(b.id) ?? [] })),
        page_pending: pagePending,
      });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.get("/pages/:id/image", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
        "SELECT image_path FROM pages WHERE id = $1", [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      try {
        const buf = await readFile(resolveStoragePath(deps.storageRoot, page.image_path));
        return c.body(new Uint8Array(buf), 200, { "Content-Type": "image/png" });
      } catch {
        return c.json({ error: "页图缺失" }, 404);
      }
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.get("/blocks/:id/crop", async (c) => {
    try {
      const { rows: [block] } = await pool.query(
        "SELECT crop_path FROM blocks WHERE id = $1", [c.req.param("id")]);
      if (!block) return c.json({ error: "block 不存在" }, 404);
      try {
        const buf = await readFile(resolveStoragePath(deps.storageRoot, block.crop_path));
        return c.body(new Uint8Array(buf), 200, { "Content-Type": "image/png" });
      } catch {
        return c.json({ error: "裁图缺失" }, 404);
      }
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.get("/items", async (c) => {
    const docId = c.req.query("doc_id");
    const status = c.req.query("status");
    if (status !== undefined && status !== "pending") {
      return c.json({ error: "status 取值: pending" }, 422);
    }
    const params: unknown[] = [];
    let where = "";
    if (docId) { where = "WHERE i.document_id = $1::uuid"; params.push(docId); }
    if (status === "pending") {
      where += (where ? " AND " : "WHERE ") +
        "(i.qc_status = 'pending' OR pr.reasons IS NOT NULL)";
    }
    const { rows } = await pool.query(
      `SELECT i.id::text, i.content_type, i.label, i.chapter, i.qc_status, d.title AS doc_title,
              pr.reasons, i.content_md, i.source_model
       FROM items i
       JOIN documents d ON d.id = i.document_id
       LEFT JOIN LATERAL (
         SELECT array_agg(r.reason ORDER BY r.created_at) AS reasons
         FROM review_queue r WHERE r.item_id = i.id AND r.status = 'pending'
       ) pr ON true
       ${where} ORDER BY d.title, i.chapter, i.created_at`, params);
    return c.json({ items: rows.map((r) => ({ ...r, pending_reasons: r.reasons ?? [] })) });
  });

  app.get("/items/:id", async (c) => {
    try {
      const { rows: [item] } = await pool.query(
        `SELECT i.id::text, i.content_type, i.label, i.chapter, i.qc_status, i.content_md,
                i.taxonomy, i.tags, d.title AS doc_title, i.source_model
         FROM items i JOIN documents d ON d.id = i.document_id WHERE i.id = $1`,
        [c.req.param("id")]);
      if (!item) return c.json({ error: "item 不存在" }, 404);
      const { rows: blocks } = await pool.query(
        `SELECT b.id::text, ib.role, b.block_type, b.content_md, b.source_model
         FROM item_blocks ib JOIN blocks b ON b.id = ib.block_id
         WHERE ib.item_id = $1 ORDER BY b.created_at, b.id`, [item.id]);
      const { rows: reviews } = await pool.query(
        "SELECT id::text, reason, status FROM review_queue WHERE item_id = $1 ORDER BY created_at",
        [item.id]);
      return c.json({
        ...item,
        blocks: blocks.map((b) => ({ ...b, crop_url: `/api/review/blocks/${b.id}/crop` })),
        reviews,
      });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ error: "q 不能为空" }, 422);
    const subject = c.req.query("subject");
    const filters = subject ? { subject } : undefined;
    return c.json({ hits: await deps.search(q, filters) });
  });

  return app;
}
