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
      `SELECT d.id::text, d.title, d.subject, d.doc_type, d.parse_status, d.struct_mode,
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
       WHERE p.parse_status = 'parsed' ${docFilter} AND ${having}
       ORDER BY d.title, p.page_no`, params);
    return c.json({ pages: rows.map((r) => ({ ...r, pending_reasons: r.reasons ?? [] })) });
  });

  app.get("/pages/:id", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
      `SELECT p.id::text, p.page_no, d.title AS doc_title, p.page_md, p.page_md_model, p.adopted_source,
              p.review_status, p.index_status, p.auto_review_status, p.manual_review_status,
              p.excluded_from_index, p.index_error
         FROM pages p JOIN documents d ON d.id = p.document_id WHERE p.id = $1`,
        [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      const { rows: blocks } = await pool.query(
        `SELECT id::text, block_type, bbox, content_md, source_model
         FROM blocks WHERE page_id = $1 ORDER BY created_at, id`, [page.id]);
      const blocksWithCrop = blocks.map((b) => ({ ...b, crop_url: `/api/review/blocks/${b.id}/crop` }));
      const blockIds = blocks.map((b) => b.id);
      const { rows: annotations } = blockIds.length ? await pool.query(
        `SELECT id::text, block_id::text, author, body, created_at, updated_at
         FROM block_annotations WHERE block_id = ANY($1::uuid[]) ORDER BY created_at`, [blockIds]) : { rows: [] };
      const { rows: itemMappings } = await pool.query(
        `SELECT ib.block_id::text, i.id::text, i.label, i.content_type, ib.role,
                i.content_md, i.qc_status
         FROM item_blocks ib
         JOIN items i ON i.id = ib.item_id
         WHERE ib.block_id = ANY($1::uuid[])`, [blockIds]);
      const itemsByBlock = new Map<string, { id: string; label: string | null; content_type: string; role: string; content_md: string | null; qc_status: string }[]>();
      for (const m of itemMappings) {
        if (!itemsByBlock.has(m.block_id)) itemsByBlock.set(m.block_id, []);
        itemsByBlock.get(m.block_id)!.push({ id: m.id, label: m.label, content_type: m.content_type, role: m.role });
      }
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
        blocks: blocksWithCrop.map((b) => ({
          ...b,
          pending: byBlock.get(b.id) ?? [],
          items: itemsByBlock.get(b.id) ?? [],
          annotations: annotations.filter((a) => a.block_id === b.id),
        })),
        review_status: page.review_status,
        auto_review_status: page.auto_review_status,
        manual_review_status: page.manual_review_status,
        excluded_from_index: page.excluded_from_index,
        index_status: page.index_status,
        index_error: page.index_error,
        page_pending: pagePending,
        items: [...new Map(itemMappings.map((m) => [m.id, { id: m.id, label: m.label, content_type: m.content_type, content_md: m.content_md, qc_status: m.qc_status, block_ids: itemMappings.filter((x) => x.id === m.id).map((x) => x.block_id), block_crops: itemMappings.filter((x) => x.id === m.id).map((x) => `/api/review/blocks/${x.block_id}/crop`) }])).values()],
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

  app.get("/chapters", async (c) => {
    const docId = c.req.query("doc_id");
    const params: unknown[] = [];
    let where = "";
    if (docId) {
      where = "WHERE c.document_id = $1::uuid";
      params.push(docId);
    }
    const { rows } = await pool.query(
      `SELECT c.id::text, c.document_id::text, d.title AS doc_title,
              c.chapter_no, c.title, c.content_md
       FROM chapters c JOIN documents d ON d.id = c.document_id
       ${where} ORDER BY d.title, c.chapter_no`,
      params,
    );
    return c.json({ chapters: rows });
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

  async function readJson(c: Context): Promise<Record<string, unknown> | null> {
    try { return await c.req.json(); } catch { return null; }
  }

  app.patch("/blocks/:id", async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
    if (typeof body.content_md !== "string") return c.json({ error: "content_md 必填" }, 422);
    try {
      const { rows: [b] } = await pool.query(
        "UPDATE blocks SET content_md=$2 WHERE id=$1 RETURNING id::text, content_md",
        [c.req.param("id"), body.content_md]);
      if (!b) return c.json({ error: "block 不存在" }, 404);
      const { rows: [page] } = await pool.query(
        `SELECT p.id::text, p.document_id::text, p.page_no
         FROM pages p WHERE p.id=(SELECT page_id FROM blocks WHERE id=$1)`, [c.req.param("id")]);
      if (page) {
        await pool.query("UPDATE pages SET index_status='stale', index_error=NULL WHERE id=$1", [page.id]);
        await pool.query(
          `DELETE FROM chunks WHERE document_id=$1 AND (
             source_block_ids && ARRAY[$2::uuid] OR page_no=$3)`,
          [page.document_id, c.req.param("id"), page.page_no]);
      }
      return c.json(b);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.patch("/pages/:id", async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
    if (typeof body.page_md !== "string") return c.json({ error: "page_md 必填" }, 422);
    try {
      const { rows: [page] } = await pool.query(
        `UPDATE pages SET page_md=$2, index_status='stale', index_error=NULL
         WHERE id=$1 RETURNING id::text, page_no, document_id::text, page_md, index_status`,
        [c.req.param("id"), body.page_md]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      await pool.query(
        `DELETE FROM chunks WHERE document_id=$1 AND (
           page_no=$2 OR source_block_ids && ARRAY(
             SELECT id FROM blocks WHERE page_id=$3))`,
        [page.document_id, page.page_no, page.id]);
      return c.json(page);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/blocks/:id/annotations", async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
    if (typeof body.body !== "string" || !body.body.trim()) return c.json({ error: "body 必填" }, 422);
    try {
      const { rows: [annotation] } = await pool.query(
        `INSERT INTO block_annotations (block_id, author, body)
         VALUES ($1, $2, $3) RETURNING id::text, block_id::text, author, body, created_at, updated_at`,
        [c.req.param("id"), typeof body.author === "string" && body.author.trim() ? body.author.trim() : "admin", body.body.trim()]);
      if (!annotation) return c.json({ error: "block 不存在" }, 404);
      return c.json(annotation, 201);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.patch("/block-annotations/:id", async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
    if (typeof body.body !== "string" || !body.body.trim()) return c.json({ error: "body 必填" }, 422);
    try {
      const { rows: [annotation] } = await pool.query(
        `UPDATE block_annotations SET body=$2, updated_at=now()
         WHERE id=$1 RETURNING id::text, block_id::text, author, body, created_at, updated_at`,
        [c.req.param("id"), body.body.trim()]);
      if (!annotation) return c.json({ error: "批注不存在" }, 404);
      return c.json(annotation);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.delete("/block-annotations/:id", async (c) => {
    try {
      const { rowCount } = await pool.query("DELETE FROM block_annotations WHERE id=$1", [c.req.param("id")]);
      if (!rowCount) return c.json({ error: "批注不存在" }, 404);
      return c.body(null, 204);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.patch("/items/:id", async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
    if (typeof body.content_md !== "string") return c.json({ error: "content_md 必填" }, 422);
    const id = c.req.param("id");
    try {
      const { rows: [item] } = await pool.query(
        "UPDATE items SET content_md=$2, updated_at=now() WHERE id=$1 RETURNING id::text, content_md",
        [id, body.content_md]);
      if (!item) return c.json({ error: "item 不存在" }, 404);
      await pool.query("DELETE FROM chunks WHERE item_id=$1", [id]);
      return c.json(item);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/pages/:id/reject", async (c) => {
    const body = await readJson(c);
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) return c.json({ error: "reason 必填" }, 422);
    try {
      const { rows: [page] } = await pool.query(
        "SELECT id::text FROM pages WHERE id=$1", [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      const { rows: [row] } = await pool.query(
        `INSERT INTO review_queue (page_id, reason) VALUES ($1,$2)
         RETURNING id::text, status`, [page.id, reason]);
      return c.json(row, 201);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/items/:id/reject", async (c) => {
    const body = await readJson(c);
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) return c.json({ error: "reason 必填" }, 422);
    try {
      const { rows: [item] } = await pool.query(
        "SELECT id::text FROM items WHERE id=$1", [c.req.param("id")]);
      if (!item) return c.json({ error: "item 不存在" }, 404);
      const { rows: [row] } = await pool.query(
        `INSERT INTO review_queue (item_id, reason) VALUES ($1,$2)
         RETURNING id::text, status`, [item.id, reason]);
      return c.json(row, 201);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/pages/:id/adopt", async (c) => {
    const body = await readJson(c);
    const source = body?.source;
    if (source !== "blocks" && source !== "page_md") {
      return c.json({ error: "source 取值: blocks|page_md" }, 422);
    }
    try {
      const { rows: [page] } = await pool.query(
        "SELECT id::text, page_md FROM pages WHERE id=$1", [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      if (source === "page_md" && !page.page_md) {
        return c.json({ error: "该页还没有整页转录" }, 409);
      }
      await pool.query("UPDATE pages SET adopted_source=$2 WHERE id=$1", [page.id, source]);
      return c.json({ page_id: page.id, adopted_source: source });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  async function forwardInternal(c: Context, path: string, body?: unknown): Promise<Response> {
    try {
      const resp = await fetch(`${deps.pipelineUrl}${path}`, {
        method: "POST",
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await resp.text();
      return new Response(text.length ? text : null, {
        status: resp.status,
        headers: { "Content-Type": resp.headers.get("content-type") ?? "application/json" },
      });
    } catch (err) {
      console.error("pipeline internal 调用失败", path, err);
      return c.json({ error: "内部服务不可达" }, 502);
    }
  }

  app.post("/pages/:id/approve", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
        `SELECT p.id::text, p.page_no, d.id::text AS doc_id, d.struct_mode
         FROM pages p JOIN documents d ON d.id = p.document_id WHERE p.id = $1`,
        [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      const { rows: closed } = await pool.query(
        `UPDATE review_queue SET status='approved' WHERE status='pending' AND (
           page_id=$1 OR block_id IN (SELECT id FROM blocks WHERE page_id=$1))
         RETURNING id`, [page.id]);
      if (page.struct_mode === "flat") {
        try {
          const resp = await fetch(`${deps.pipelineUrl}/internal/embed-flat-page`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ doc_id: page.doc_id, page_no: page.page_no }),
          });
          if (!resp.ok) throw new Error(await resp.text());
          const { chunks } = await resp.json() as { chunks: number };
          return c.json({ id: page.id, resolved: closed.length, embedded: chunks });
        } catch (err) {
          console.error("flat 页向量化失败", err);
          return c.json({ id: page.id, resolved: closed.length, embed_error: "向量化失败，可重新通过该页重试" });
        }
      }
      return c.json({ id: page.id, resolved: closed.length });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/items/:id/approve", async (c) => {
    try {
      const { rows: [item] } = await pool.query(
        "SELECT id::text FROM items WHERE id=$1", [c.req.param("id")]);
      if (!item) return c.json({ error: "item 不存在" }, 404);
      return forwardInternal(c, `/internal/approve-item?item_id=${encodeURIComponent(item.id)}`);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/pages/:id/page-vlm", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
        "SELECT id::text FROM pages WHERE id=$1", [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      return forwardInternal(c, "/internal/page-vlm", { page_id: page.id });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/pages/:id/index-preview", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
        "SELECT id::text FROM pages WHERE id=$1", [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      return forwardInternal(c, "/internal/index-preview", { page_id: page.id });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  return app;
}
