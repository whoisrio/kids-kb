/** 资料库 API：列表/删除/上传。 */
import { Hono } from "hono";
import type pg from "pg";
import type { BackendConfig } from "../config.js";

export interface LibraryDeps {
  pipelineUrl: string;
  search: (q: string, filters?: Record<string, string>) => Promise<{ doc_id: string; doc_title: string; content_md: string; page_no?: number; chapter_no?: number }[]>;
}

export function libraryRoutes(pool: pg.Pool, deps: LibraryDeps, cfg: BackendConfig): Hono {
  const app = new Hono({ strict: false });

  app.get("/", async (c) => {
    const { rows } = await pool.query(
      `SELECT d.id::text, d.title, d.subject,
              CASE WHEN d.source_path LIKE '%%.pdf' THEN 'pdf'
                   WHEN d.source_path LIKE '%%.docx' THEN 'docx'
                   ELSE 'md' END AS file_type,
              d.parse_status, d.review_status, d.uploaded_by, d.created_at,
              count(p.id)::int AS total_pages,
              count(p.id) FILTER (WHERE p.review_status = 'pending')::int AS pending_pages,
              count(p.id) FILTER (WHERE p.index_status = 'indexed')::int AS indexed_pages
       FROM documents d
       LEFT JOIN pages p ON p.document_id = d.id
       GROUP BY d.id ORDER BY d.created_at DESC`);
    return c.json({ documents: rows });
  });

  app.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ error: "q 不能为空" }, 422);
    const docId = c.req.query("doc_id");
    const filters: Record<string, string> = {};
    if (docId) filters.doc_id = docId;
    return c.json({ hits: await deps.search(q, filters) });
  });

  app.delete("/:id", async (c) => {
    try {
      const { rowCount } = await pool.query(
        "DELETE FROM documents WHERE id=$1", [c.req.param("id")]);
      if (!rowCount) return c.json({ error: "文档不存在" }, 404);
      return c.body(null, 204);
    } catch (err) {
      if ((err as { code?: string }).code === "22P02") {
        return c.json({ error: "id 格式非法" }, 422);
      }
      throw err;
    }
  });

  app.post("/:id/reindex", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.type || !body?.id) return c.json({ error: "type/id 必填" }, 422);
    try {
      const resp = await fetch(`${deps.pipelineUrl}/internal/reindex`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: c.req.param("id"), type: body.type, id: body.id }),
      });
      return c.json(await resp.json(), resp.status as 200);
    } catch {
      return c.json({ error: "pipeline 不可达" }, 502);
    }
  });

  app.get("/:id", async (c) => {
    try {
      const { rows: [doc] } = await pool.query(
        `SELECT d.id::text, d.title, d.subject, d.parse_status, d.review_status,
                d.uploaded_by, d.created_at, d.struct_mode,
                CASE WHEN d.source_path LIKE '%%.pdf' THEN 'pdf'
                     WHEN d.source_path LIKE '%%.docx' THEN 'docx'
                     ELSE 'md' END AS file_type
         FROM documents d WHERE d.id=$1`, [c.req.param("id")]);
      if (!doc) return c.json({ error: "文档不存在" }, 404);
      if (doc.file_type === "pdf") {
        const { rows: pages } = await pool.query(
          `SELECT id::text, page_no, review_status, index_status
           FROM pages WHERE document_id=$1 ORDER BY page_no`, [doc.id]);
        return c.json({ ...doc, pages });
      }
      const { rows: chapters } = await pool.query(
        `SELECT id::text, chapter_no, title, content_md, review_status, index_status
         FROM chapters WHERE document_id=$1 ORDER BY chapter_no`, [doc.id]);
      return c.json({ ...doc, chapters });
    } catch (err) {
      if ((err as { code?: string }).code === "22P02") {
        return c.json({ error: "id 格式非法" }, 422);
      }
      throw err;
    }
  });

  return app;
}
