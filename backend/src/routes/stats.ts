/** 统计页聚合：attempts 按题维度（coalesce(paper_question_id, item_id)）。
    已订正 = 曾错（≥1 次 wrong/partial）且最新一次 correct；待重练 = 最新一次 wrong/partial。
    本周 = 本周一起（date_trunc('week')，PG 即周一）；趋势近 8 周含当周。
    正确率 = correct / 总次数（partial 计分母不计分子）；环比为百分点差。
    未挂题库的试卷题计入统计，内容显示试卷题干。 */
import { Hono } from "hono";
import type pg from "pg";

const QUESTION_WINDOW = `
  SELECT coalesce(a.paper_question_id::text, a.item_id::text) AS qid,
         a.item_id, a.paper_question_id, a.result, a.error_cause, a.created_at,
         row_number() OVER (PARTITION BY coalesce(a.paper_question_id::text, a.item_id::text)
                            ORDER BY a.created_at DESC, a.id DESC) AS rn,
         bool_or(a.result IN ('wrong', 'partial'))
           OVER (PARTITION BY coalesce(a.paper_question_id::text, a.item_id::text)) AS ever_wrong
  FROM attempts a
  WHERE a.child_id = $1`;

export function statsRoutes(pool: pg.Pool): Hono {
  const app = new Hono({ strict: false });

  app.get("/overview", async (c) => {
    const childId = c.req.query("child_id");
    if (!childId) return c.json({ error: "child_id 必填" }, 422);
    try {
      const child = await pool.query("SELECT 1 FROM children WHERE id=$1", [childId]);
      if (!child.rows.length) return c.json({ error: "child_id 不存在" }, 404);

      const { rows: [hero0] } = await pool.query(
        `SELECT
           count(*) FILTER (WHERE created_at >= date_trunc('week', now()))::int AS week_total,
           count(*) FILTER (WHERE created_at >= date_trunc('week', now()) AND result='correct')::int AS week_correct,
           count(*) FILTER (WHERE created_at >= date_trunc('week', now()) AND result IN ('wrong','partial'))::int AS week_wrong,
           count(*) FILTER (WHERE created_at >= date_trunc('week', now()) - interval '1 week'
                            AND created_at < date_trunc('week', now()))::int AS last_total,
           count(*) FILTER (WHERE created_at >= date_trunc('week', now()) - interval '1 week'
                            AND created_at < date_trunc('week', now()) AND result='correct')::int AS last_correct
         FROM attempts WHERE child_id = $1`,
        [childId],
      );
      const rate = (correct: number, total: number) => (total === 0 ? null : correct / total);
      const weekRate = rate(hero0.week_correct, hero0.week_total);
      const lastWeekRate = rate(hero0.last_correct, hero0.last_total);

      const { rows: latest } = await pool.query(
        `WITH q AS (${QUESTION_WINDOW})
         SELECT q.qid, q.item_id::text, q.paper_question_id::text, q.result, q.error_cause, q.created_at,
                q.ever_wrong,
                i.content_md AS item_content, i.label, i.chapter, d.title AS doc_title,
                pq.content_md AS pq_content, p.title AS paper_title,
                row_number() OVER (ORDER BY q.created_at DESC) AS list_rn
         FROM q
         LEFT JOIN items i ON i.id = q.item_id
         LEFT JOIN documents d ON d.id = i.document_id
         LEFT JOIN paper_questions pq ON pq.id = q.paper_question_id
         LEFT JOIN papers p ON p.id = pq.paper_id
         WHERE q.rn = 1 AND q.ever_wrong`,
        [childId],
      );
      const pendingRows = latest.filter((row) => row.result === "wrong" || row.result === "partial");
      const corrected = latest.length - pendingRows.length;

      const { rows: causes } = await pool.query(
        `SELECT coalesce(error_cause, '未归类') AS cause, count(*)::int AS count
         FROM attempts
         WHERE child_id = $1 AND result IN ('wrong','partial') AND created_at >= now() - interval '30 days'
         GROUP BY 1 ORDER BY 2 DESC, 1`,
        [childId],
      );

      const { rows: weakTags } = await pool.query(
        `WITH q AS (${QUESTION_WINDOW}),
         weak AS (
           SELECT coalesce(q.item_id, pq.matched_item_id) AS item_id
           FROM q LEFT JOIN paper_questions pq ON pq.id = q.paper_question_id
           WHERE q.rn = 1 AND q.result IN ('wrong','partial')
         )
         SELECT tag, count(*)::int AS count FROM (
           SELECT i.taxonomy AS tag FROM weak w JOIN items i ON i.id = w.item_id WHERE i.taxonomy IS NOT NULL
           UNION ALL
           SELECT unnest(i.tags) AS tag FROM weak w JOIN items i ON i.id = w.item_id
         ) s WHERE tag IS NOT NULL GROUP BY tag ORDER BY 2 DESC, 1 LIMIT 20`,
        [childId],
      );

      const { rows: trendRows } = await pool.query(
        `SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week, count(*)::int AS total,
                count(*) FILTER (WHERE result='correct')::int AS correct
         FROM attempts
         WHERE child_id = $1 AND created_at >= date_trunc('week', now()) - interval '7 weeks'
         GROUP BY 1`,
        [childId],
      );
      const byWeek = new Map(trendRows.map((row) => [row.week, row]));
      const trend: { weekStart: string; total: number; correct: number; rate: number | null }[] = [];
      for (let index = 7; index >= 0; index--) {
        const { rows: [bucket] } = await pool.query(
          `SELECT to_char(date_trunc('week', now()) - ($1::text || ' days')::interval, 'YYYY-MM-DD') AS ws`,
          [index * 7],
        );
        const row = byWeek.get(bucket.ws);
        const total = row?.total ?? 0;
        const correct = row?.correct ?? 0;
        trend.push({ weekStart: bucket.ws, total, correct, rate: rate(correct, total) });
      }

      return c.json({
        hero: {
          weekWrong: hero0.week_wrong,
          weekTotal: hero0.week_total,
          weekRate,
          lastWeekRate,
          rateDelta: weekRate === null || lastWeekRate === null ? null : weekRate - lastWeekRate,
          corrected,
          pending: pendingRows.length,
        },
        causes,
        weakTags,
        trend,
        pendingList: pendingRows.map((row) => ({
          id: row.qid,
          kind: row.paper_question_id ? "paper" : "item",
          content: row.paper_question_id
            ? row.pq_content ?? row.item_content ?? ""
            : row.item_content ?? row.pq_content ?? "",
          source: row.doc_title
            ? `《${row.doc_title}》${row.chapter ? ` ${row.chapter}` : ""}${row.label ? ` · ${row.label}` : ""}`
            : `《${row.paper_title ?? "试卷"}》`,
          errorCause: row.error_cause,
          lastAt: row.created_at,
        })),
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "22P02") return c.json({ error: "child_id 格式非法（须为 UUID）" }, 422);
      throw err;
    }
  });

  return app;
}
