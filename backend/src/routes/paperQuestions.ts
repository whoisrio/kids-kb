/** 试卷题确认流:对错确认(attempts upsert)、题库匹配设置、实时候选、题图回传。 */
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { Context } from "hono";
import type pg from "pg";
import type { PaperJobDeps } from "../papers/jobs.js";
import { matchQuestion } from "../retrieval/match.js";
import { resolveStoragePath } from "../storagePath.js";

const RESULTS = new Set(["correct", "wrong", "partial"]);
const CAUSES = new Set(["粗心", "概念不清", "方法不会", "计算错"]);

async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** 路由级统一:id 参数非法(非 UUID)一律 422,不再 500。 */
function invalidId(c: Context, err: unknown): Response | null {
  return (err as { code?: string })?.code === "22P02"
    ? c.json({ error: "id 格式非法（须为 UUID）" }, 422)
    : null;
}

export function paperQuestionsRoutes(pool: pg.Pool, deps: PaperJobDeps, storageRoot: string): Hono {
  const app = new Hono({ strict: false });

  app.put("/:id/confirm", async (c) => {
    let body: { result?: string; error_cause?: string; note?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "请求体不是合法 JSON" }, 400); }
    const result = body.result ?? "";
    if (!RESULTS.has(result)) return c.json({ error: "result 取值: correct|wrong|partial" }, 422);
    if (body.error_cause != null && !CAUSES.has(body.error_cause)) {
      return c.json({ error: "error_cause 取值: 粗心/概念不清/方法不会/计算错" }, 422);
    }
    const qid = c.req.param("id");
    try {
      return await withTx(pool, async (client) => {
        const { rows: [q] } = await client.query(
          `SELECT pq.id::text, pq.matched_item_id, p.child_id, p.id::text AS paper_id
           FROM paper_questions pq JOIN papers p ON p.id = pq.paper_id WHERE pq.id=$1`, [qid]);
        if (!q) return c.json({ error: "题目不存在" }, 404);
        await client.query(
          `UPDATE paper_questions SET confirmed_result=$1, error_cause=$2, note=$3, updated_at=now()
           WHERE id=$4`, [result, body.error_cause ?? null, body.note ?? null, qid]);
        // 单语句 upsert:并发 confirm 也只会落到同一条 attempt(改判不追加),
        // 靠 0012 migration 的 attempts_paper_question_id_key 唯一约束兜底,取代 SELECT-then-INSERT 竞态
        await client.query(
          `INSERT INTO attempts (child_id, item_id, paper_question_id, result, error_cause, note)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (paper_question_id) DO UPDATE SET
             item_id=EXCLUDED.item_id, result=EXCLUDED.result,
             error_cause=EXCLUDED.error_cause, note=EXCLUDED.note`,
          [q.child_id, q.matched_item_id, qid, result, body.error_cause ?? null, body.note ?? null]);
        const { rows: [paper] } = await client.query(
          `UPDATE papers SET status = CASE
             WHEN NOT EXISTS (
               SELECT 1 FROM paper_questions WHERE paper_id=$1 AND confirmed_result IS NULL)
             THEN 'done' ELSE 'ready_for_review' END,
             updated_at=now()
           WHERE id=$1 RETURNING status`, [q.paper_id]);
        return c.json({
          id: qid, confirmed_result: result,
          error_cause: body.error_cause ?? null, note: body.note ?? null,
          paper_status: paper.status,
        });
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "22P02") return c.json({ error: "id 格式非法（须为 UUID）" }, 422);
      throw err;
    }
  });

  app.put("/:id/match", async (c) => {
    let body: { item_id?: string | null; score?: number };
    try { body = await c.req.json(); } catch { return c.json({ error: "请求体不是合法 JSON" }, 400); }
    const qid = c.req.param("id");
    const itemId = body.item_id ?? null;
    try {
      return await withTx(pool, async (client) => {
        const { rows: [q] } = await client.query(
          "SELECT id::text FROM paper_questions WHERE id=$1", [qid]);
        if (!q) return c.json({ error: "题目不存在" }, 404);
        if (itemId) {
          const { rows: item } = await client.query("SELECT 1 FROM items WHERE id=$1", [itemId]);
          if (!item.length) return c.json({ error: "item_id 不存在" }, 404);
        }
        await client.query(
          `UPDATE paper_questions
           SET matched_item_id=$1, match_score=$2, matched_at=CASE WHEN $1::uuid IS NULL THEN NULL ELSE now() END,
               updated_at=now()
           WHERE id=$3`, [itemId, itemId ? body.score ?? null : null, qid]);
        await client.query(
          "UPDATE attempts SET item_id=$1 WHERE paper_question_id=$2", [itemId, qid]);
        return c.json({ id: qid, matched_item_id: itemId, match_score: itemId ? body.score ?? null : null });
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "22P02") return c.json({ error: "id 格式非法（须为 UUID）" }, 422);
      if (code === "23503") return c.json({ error: "item_id 不存在" }, 404);
      throw err;
    }
  });

  app.get("/:id/candidates", async (c) => {
    try {
      const { rows: [q] } = await pool.query(
        `SELECT pq.content_md, p.subject FROM paper_questions pq
         JOIN papers p ON p.id = pq.paper_id WHERE pq.id=$1`, [c.req.param("id")]);
      if (!q) return c.json({ error: "题目不存在" }, 404);
      const { candidates } = await matchQuestion(
        pool, { embed: deps.embed, rerank: deps.rerank }, q.content_md, q.subject, deps.matchThreshold);
      return c.json({ candidates });
    } catch (err) {
      return invalidId(c, err) ?? ((err as { code?: string })?.code === "23503"
        ? c.json({ error: "item_id 不存在" }, 404) : (() => { throw err; })());
    }
  });

  app.get("/:id/image", async (c) => {
    try {
      const { rows: [q] } = await pool.query(
        "SELECT image_path FROM paper_questions WHERE id=$1", [c.req.param("id")]);
      if (!q) return c.json({ error: "题目不存在" }, 404);
      if (!q.image_path) return c.json({ error: "该题无裁图" }, 404);
      try {
        const buf = await readFile(resolveStoragePath(storageRoot, q.image_path));
        return c.body(new Uint8Array(buf), 200, { "Content-Type": "image/png" });
      } catch {
        return c.json({ error: "题图缺失" }, 404);
      }
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  return app;
}
