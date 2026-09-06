/** 用量页聚合：llm_calls 本月（自然月）口径；modality 为空的历史行计入文本。
    纪律：token 统计不进统计页，两页分离。 */
import { Hono } from "hono";
import type pg from "pg";

const TOKENS = "(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0))";

export function usageRoutes(pool: pg.Pool): Hono {
  const app = new Hono({ strict: false });

  app.get("/overview", async (c) => {
    const month = "created_at >= date_trunc('month', now())";
    const { rows: [hero0] } = await pool.query(
      `SELECT
         coalesce(sum(coalesce(prompt_tokens, 0)), 0)::int AS "promptTokens",
         coalesce(sum(coalesce(completion_tokens, 0)), 0)::int AS "completionTokens",
         count(*)::int AS calls,
         coalesce(sum(CASE WHEN coalesce(modality, 'text') = 'text' THEN ${TOKENS} ELSE 0 END), 0)::int AS "textTokens",
         coalesce(sum(CASE WHEN coalesce(modality, 'text') = 'image' THEN ${TOKENS} ELSE 0 END), 0)::int AS "imageTokens"
       FROM llm_calls WHERE ${month}`,
    );
    const { rows: byPurpose } = await pool.query(
      `SELECT purpose, count(*)::int AS calls, coalesce(sum(${TOKENS}), 0)::int AS tokens
       FROM llm_calls WHERE ${month} GROUP BY purpose ORDER BY calls DESC, tokens DESC, purpose ASC`,
    );
    const { rows: byModel } = await pool.query(
      `SELECT model, count(*)::int AS calls, coalesce(sum(${TOKENS}), 0)::int AS tokens
       FROM llm_calls WHERE ${month} GROUP BY model ORDER BY calls DESC, tokens DESC, model ASC`,
    );
    const { rows: recent } = await pool.query(
      `SELECT id::text, created_at, purpose, model, coalesce(modality, 'text') AS modality,
              coalesce(prompt_tokens, 0)::int AS prompt_tokens,
              coalesce(completion_tokens, 0)::int AS completion_tokens
       FROM llm_calls ORDER BY created_at DESC LIMIT 50`,
    );
    return c.json({
      hero: { ...hero0, totalTokens: hero0.promptTokens + hero0.completionTokens },
      byPurpose,
      byModel,
      recent,
    });
  });

  return app;
}
