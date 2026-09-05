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

  return app;
}
