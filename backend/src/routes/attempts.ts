import { Hono } from "hono";
import type pg from "pg";

// 词表与 migrations/0009 SQL CHECK 保持一致
const RESULTS = new Set(["correct", "wrong", "partial"]);
const CAUSES = new Set(["粗心", "概念不清", "方法不会", "计算错"]);

export function attemptsRoutes(pool: pg.Pool): Hono {
  // strict: false —— 挂载后 /api/attempts 与 /api/attempts/ 都能匹配
  const app = new Hono({ strict: false });
  app.post("/", async (c) => {
    const body = await c.req.json();
    if (!body.child_id || !body.item_id || !RESULTS.has(body.result)) {
      return c.json({ error: "child_id/item_id/result(correct|wrong|partial) 必填" }, 422);
    }
    if (body.error_cause != null && !CAUSES.has(body.error_cause)) {
      return c.json({ error: "error_cause 取值: 粗心/概念不清/方法不会/计算错" }, 422);
    }
    const { rows } = await pool.query(
      `INSERT INTO attempts (child_id, item_id, result, error_cause, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [body.child_id, body.item_id, body.result, body.error_cause ?? null, body.note ?? null],
    );
    return c.json(rows[0], 201);
  });
  app.get("/", async (c) => {
    const childId = c.req.query("child_id");
    if (!childId) return c.json({ error: "child_id 必填" }, 422);
    const { rows } = await pool.query(
      `SELECT a.id, a.result, a.error_cause, a.note, a.created_at,
              i.label, i.chapter, i.content_md
       FROM attempts a LEFT JOIN items i ON i.id = a.item_id
       WHERE a.child_id = $1 ORDER BY a.created_at DESC LIMIT 200`,
      [childId],
    );
    return c.json({ attempts: rows });
  });
  return app;
}
