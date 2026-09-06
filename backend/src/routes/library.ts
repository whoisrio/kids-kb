/** 资料库 API：列表/删除/上传。 */
import { Hono } from "hono";
import type pg from "pg";
import type { BackendConfig } from "../config.js";

export interface LibraryDeps {
  pipelineUrl: string;
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

  return app;
}
