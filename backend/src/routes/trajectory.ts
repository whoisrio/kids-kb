import type { Context } from "hono";
import { Hono } from "hono";
import type pg from "pg";

function invalidId(c: Context, err: unknown): Response | null {
  return (err as { code?: string })?.code === "22P02"
    ? c.json({ error: "id 格式非法（须为 UUID）" }, 422) : null;
}

const EVENT_COLS = `id, run_id::text, document_id::text, page_id::text, item_id::text,
  stage, event_type, summary, model, prompt_tokens, completion_tokens,
  duration_ms, status, actor, created_at`;

export function trajectoryRoutes(pool: pg.Pool): Hono {
  const app = new Hono();

  app.get("/documents/:id/trajectory", async (c) => {
    try {
      const docId = c.req.param("id");
      if (c.req.query("level") === "event") {
        const params: unknown[] = [docId];
        let conds = "document_id=$1";
        const runId = c.req.query("run_id");
        if (runId) { params.push(runId); conds += ` AND run_id=$${params.length}`; }
        const pageId = c.req.query("page_id");
        if (pageId) { params.push(pageId); conds += ` AND page_id=$${params.length}`; }
        const { rows } = await pool.query(
          `SELECT ${EVENT_COLS} FROM pipeline_events
           WHERE ${conds} ORDER BY id LIMIT 500`, params);
        return c.json({ events: rows });
      }
      const { rows } = await pool.query(
        `SELECT run_id::text,
                min(created_at) AS started_at, max(created_at) AS ended_at,
                count(*)::int AS event_count,
                count(*) FILTER (WHERE status='error')::int AS error_count,
                (array_agg(stage ORDER BY id))[1] AS first_stage,
                (array_agg(actor ORDER BY id))[1] AS actor,
                (array_agg(summary ORDER BY id))[1] AS first_summary
         FROM pipeline_events WHERE document_id=$1
         GROUP BY run_id ORDER BY started_at DESC LIMIT 100`, [docId]);
      return c.json({ runs: rows });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.get("/pages/:id/trajectory", async (c) => {
    try {
      const { rows } = await pool.query(
        `SELECT ${EVENT_COLS} FROM pipeline_events
         WHERE page_id=$1 ORDER BY id LIMIT 500`, [c.req.param("id")]);
      return c.json({ events: rows });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.get("/trajectory/events/:id", async (c) => {
    try {
      const { rows: [ev] } = await pool.query(
        `SELECT ${EVENT_COLS}, payload FROM pipeline_events WHERE id=$1`,
        [c.req.param("id")]);
      if (!ev) return c.json({ error: "事件不存在" }, 404);
      return c.json(ev);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  return app;
}
