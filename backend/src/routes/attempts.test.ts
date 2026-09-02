import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { resetDbForTest } from "../db.js";
import { Hono } from "hono";
import { childrenRoutes } from "./children.js";
import { attemptsRoutes } from "./attempts.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("children/attempts API（真库）", () => {
  let pool: pg.Pool;
  let app: Hono;
  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    app = new Hono();
    app.route("/api/children", childrenRoutes(pool));
    app.route("/api/attempts", attemptsRoutes(pool));
    await pool.query(`
      INSERT INTO documents (id, title, source_path) VALUES
        ('11111111-1111-1111-1111-111111111111', '书', '/tmp/x.pdf');
      INSERT INTO items (id, document_id, content_type, label, content_md) VALUES
        ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'exercise', '1', '题');
    `);
  });
  afterAll(() => pool.end());

  it("建孩子 -> 标记做题 -> 查记录", async () => {
    const created = await app.request("/api/children", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "小宝", grade: "四年级" }),
    });
    expect(created.status).toBe(201);
    const child = await created.json();

    const marked = await app.request("/api/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        child_id: child.id,
        item_id: "22222222-2222-2222-2222-222222222222",
        result: "wrong", error_cause: "粗心", note: "竖式对位错",
      }),
    });
    expect(marked.status).toBe(201);

    const bad = await app.request("/api/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ child_id: child.id, item_id: "22222222-2222-2222-2222-222222222222", result: "unknown" }),
    });
    expect(bad.status).toBe(422);

    const list = await app.request(`/api/attempts?child_id=${child.id}`);
    const data = await list.json();
    expect(data.attempts).toHaveLength(1);
    expect(data.attempts[0].error_cause).toBe("粗心");
  });
});
