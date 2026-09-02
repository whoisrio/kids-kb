import { Hono } from "hono";
import type pg from "pg";

export function childrenRoutes(pool: pg.Pool): Hono {
  // strict: false —— 挂载后 /api/children 与 /api/children/ 都能匹配
  const app = new Hono({ strict: false });
  app.get("/", async (c) => {
    const { rows } = await pool.query("SELECT id, name, grade FROM children ORDER BY created_at");
    return c.json({ children: rows });
  });
  app.post("/", async (c) => {
    let body: { name?: string; grade?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体不是合法 JSON" }, 400);
    }
    const { name, grade } = body;
    if (!name?.trim()) return c.json({ error: "name 不能为空" }, 422);
    const { rows } = await pool.query(
      "INSERT INTO children (name, grade) VALUES ($1, $2) RETURNING id, name, grade",
      [name.trim(), grade ?? null],
    );
    return c.json(rows[0], 201);
  });
  return app;
}
