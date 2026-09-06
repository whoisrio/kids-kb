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

  return app;
}
