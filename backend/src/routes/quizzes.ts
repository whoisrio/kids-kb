/** 薄弱点自动出题：generate（弱知识点 → LLM 出题 → 落库）/ 列表 / 详情 / submit（判分入库）。
    弱知识点 SQL 与 stats.ts 同口径（QUESTION_WINDOW CTE + taxonomy/tags 混合计数），取 top 5。
    实得分随 attempts.note 落库（字符串整数），QuizSummary.earned_points 由其求和还原。 */
import { Hono } from "hono";
import type { Context } from "hono";
import type pg from "pg";
import { loadConfig } from "../config.js";
import { makeCallText, type CallTextFn } from "../llm.js";
import { gradeChoiceQuestions, isShortAnswer, toArray } from "../quiz/grading.js";
import { normalizeGeneratedQuestions } from "../quiz/normalize.js";
import { buildGeneratePrompts, buildShortAnswerGradePrompts, type Difficulty } from "../quiz/prompts.js";
import type { QuizQuestion, QuizSummary, QuestionResult } from "../quiz/types.js";

/** 与 stats.ts 同口径的题维度窗口（rn=1 最新一次）。 */
const QUESTION_WINDOW = `
  SELECT coalesce(a.paper_question_id::text, a.item_id::text) AS qid,
         a.item_id, a.paper_question_id, a.result, a.error_cause, a.created_at,
         row_number() OVER (PARTITION BY coalesce(a.paper_question_id::text, a.item_id::text)
                            ORDER BY a.created_at DESC, a.id DESC) AS rn
  FROM attempts a
  WHERE a.child_id = $1`;

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const QUESTION_TYPES = new Set(["single", "multiple", "short_answer"]);

export interface QuizRouteDeps {
  callText?: CallTextFn;
}

/** PG 错误码 → HTTP：22P02 非法 UUID；其他继续抛。 */
function mapPgError(c: Context, err: unknown): Response {
  const code = (err as { code?: string })?.code;
  if (code === "22P02") return c.json({ error: "id 格式非法（须为 UUID）" }, 422);
  throw err;
}

/** QuizSummary 行查询：question_count/total_points 聚合 quiz_questions；
    earned_points 仅 submitted 时由 attempts.note（实得分字符串）求和。 */
const SUMMARY_SELECT = `
  SELECT q.id::text, q.child_id::text, q.title, q.tags, q.status, q.created_at, q.submitted_at,
         count(qq.id)::int AS question_count,
         coalesce(sum(qq.points), 0)::int AS total_points,
         CASE WHEN q.status = 'submitted' THEN coalesce((
           SELECT sum(a.note::int) FROM attempts a
           JOIN quiz_questions qq2 ON qq2.id = a.quiz_question_id
           WHERE qq2.quiz_id = q.id), 0)::int
         END AS earned_points
  FROM quizzes q LEFT JOIN quiz_questions qq ON qq.quiz_id = q.id`;

async function summaryById(pool: pg.Pool, id: string): Promise<QuizSummary | null> {
  const { rows } = await pool.query(`${SUMMARY_SELECT} WHERE q.id = $1 GROUP BY q.id`, [id]);
  return (rows[0] as QuizSummary | undefined) ?? null;
}

async function recordLlmCall(
  pool: pg.Pool,
  r: { model: string; usage: { prompt_tokens: number; completion_tokens: number } },
): Promise<void> {
  await pool.query(
    `INSERT INTO llm_calls (document_id, purpose, model, modality, prompt_tokens, completion_tokens)
     VALUES (NULL, 'quiz', $1, 'text', $2, $3)`,
    [r.model, r.usage.prompt_tokens, r.usage.completion_tokens],
  );
}

/** score → result：满分的 80% 以上 correct，>0 partial，否则 wrong。 */
function resultOf(earned: number, points: number): "correct" | "partial" | "wrong" {
  if (earned >= points * 0.8) return "correct";
  if (earned > 0) return "partial";
  return "wrong";
}

/** 提取模型输出里的首个 JSON 数组并清洗；失败返回 null（→ 502）。 */
function parseGenerated(text: string): QuizQuestion[] | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return normalizeGeneratedQuestions(JSON.parse(match[0]));
  } catch {
    return null;
  }
}

export function quizRoutes(pool: pg.Pool, deps: QuizRouteDeps = {}): Hono {
  const app = new Hono({ strict: false });
  // 测试注入假 callText；缺省惰性构造（避免无配置环境下仅挂载就抛错）
  let callText: CallTextFn | undefined = deps.callText;
  const getCallText = () => (callText ??= makeCallText(loadConfig()));

  app.post("/generate", async (c) => {
    let body: { child_id?: string; count?: number; difficulty?: string; types?: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体不是合法 JSON" }, 400);
    }
    if (!body.child_id) return c.json({ error: "child_id 必填" }, 422);
    const count = body.count ?? 5;
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      return c.json({ error: "count 须为 1..20 的整数" }, 422);
    }
    const difficulty = body.difficulty ?? "medium";
    if (!DIFFICULTIES.has(difficulty)) return c.json({ error: "difficulty 取值: easy|medium|hard" }, 422);
    const types = body.types ?? ["single", "multiple", "short_answer"];
    if (!Array.isArray(types) || types.length === 0 || types.some((t) => !QUESTION_TYPES.has(t))) {
      return c.json({ error: "types 取值: single|multiple|short_answer 的非空子集" }, 422);
    }

    try {
      const child = await pool.query("SELECT 1 FROM children WHERE id=$1", [body.child_id]);
      if (!child.rows.length) return c.json({ error: "child_id 不存在" }, 404);

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
         ) s WHERE tag IS NOT NULL GROUP BY tag ORDER BY 2 DESC, 1 LIMIT 5`,
        [body.child_id],
      );
      const tags = weakTags.map((r: { tag: string }) => r.tag);
      if (!tags.length) return c.json({ error: "no_weak_tags" }, 409);

      // 参考例题：每个弱 tag 取 ≤3 条已 approved 的题库内容，总量封顶 15
      const examples: string[] = [];
      for (const tag of tags) {
        if (examples.length >= 15) break;
        const { rows } = await pool.query(
          `SELECT content_md FROM items
           WHERE qc_status='approved' AND content_md IS NOT NULL
             AND (taxonomy = $1 OR $1 = ANY(tags))
           ORDER BY updated_at DESC LIMIT 3`,
          [tag],
        );
        for (const r of rows) {
          if (examples.length < 15) examples.push(String(r.content_md).slice(0, 500));
        }
      }

      const prompts = buildGeneratePrompts({
        tags, count, difficulty: difficulty as Difficulty, types, examples,
      });
      const llm = await getCallText()(prompts);
      const questions = parseGenerated(llm.text);
      if (!questions) return c.json({ error: "invalid_model_output" }, 502);

      const title = `薄弱点强化：${tags.join("、")}`;
      const client = await pool.connect();
      let quizId: string;
      try {
        await client.query("BEGIN");
        quizId = (await client.query(
          "INSERT INTO quizzes (child_id, title, tags) VALUES ($1, $2, $3) RETURNING id::text",
          [body.child_id, title, tags],
        )).rows[0].id;
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          await client.query(
            `INSERT INTO quiz_questions (quiz_id, seq, type, question, options, answer, analysis, comment_prompt, points)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              quizId, i + 1, q.type, q.question,
              q.options ? JSON.stringify(q.options) : null,
              q.answer ?? null, q.analysis ?? null, q.commentPrompt ?? null, q.points ?? 10,
            ],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      await recordLlmCall(pool, llm);
      return c.json({ quiz: await summaryById(pool, quizId) });
    } catch (err) {
      return mapPgError(c, err);
    }
  });

  app.get("/", async (c) => {
    const childId = c.req.query("child_id");
    if (!childId) return c.json({ error: "child_id 必填" }, 422);
    try {
      const { rows } = await pool.query(
        `${SUMMARY_SELECT} WHERE q.child_id = $1 GROUP BY q.id ORDER BY q.created_at DESC`,
        [childId],
      );
      return c.json({ quizzes: rows });
    } catch (err) {
      return mapPgError(c, err);
    }
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const quiz = await summaryById(pool, id);
      if (!quiz) return c.json({ error: "quiz 不存在" }, 404);
      const { rows } = await pool.query(
        `SELECT id::text, seq, type, question, options, points, answer, analysis
         FROM quiz_questions WHERE quiz_id=$1 ORDER BY seq`,
        [id],
      );
      const pending = quiz.status === "pending";
      // submitted 时从 attempts 还原逐题结果，供回顾页渲染对错徽标（comment 未持久化，恒为 null）
      let results: QuestionResult[] | undefined;
      if (!pending) {
        const { rows: attemptRows } = await pool.query(
          `SELECT a.quiz_question_id::text AS question_id, a.result, a.note
           FROM attempts a JOIN quiz_questions qq ON qq.id = a.quiz_question_id
           WHERE qq.quiz_id = $1`,
          [id],
        );
        const byQid = new Map(attemptRows.map((r) => [r.question_id, r]));
        results = rows.map((r) => {
          const a = byQid.get(r.id);
          return {
            question_id: r.id,
            result: (a?.result ?? "wrong") as QuestionResult["result"],
            earned: a?.note != null ? Number(a.note) || 0 : 0,
            points: r.points,
            comment: null,
          };
        });
      }
      return c.json({
        quiz: {
          ...quiz,
          questions: rows.map((r) => ({
            id: r.id,
            seq: r.seq,
            type: r.type,
            question: r.question,
            options: r.options ?? null,
            points: r.points,
            // pending 不透出答案与解析（防偷看）
            answer: pending ? null : (r.answer ?? null),
            analysis: pending ? null : (r.analysis ?? null),
          })),
          ...(results ? { results } : {}),
        },
      });
    } catch (err) {
      return mapPgError(c, err);
    }
  });

  app.post("/:id/submit", async (c) => {
    const id = c.req.param("id");
    let body: { answers?: Record<string, string | string[]> };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体不是合法 JSON" }, 400);
    }
    const answers = body.answers ?? {};
    try {
      const { rows: quizRows } = await pool.query(
        "SELECT id::text, child_id::text, status FROM quizzes WHERE id=$1", [id],
      );
      const quiz = quizRows[0];
      if (!quiz) return c.json({ error: "quiz 不存在" }, 404);
      if (quiz.status !== "pending") return c.json({ error: "already_submitted" }, 409);

      const { rows } = await pool.query(
        `SELECT id::text, type, question, answer, comment_prompt, points
         FROM quiz_questions WHERE quiz_id=$1 ORDER BY seq`,
        [id],
      );
      const questions: QuizQuestion[] = rows.map((r) => ({
        id: r.id,
        type: r.type,
        question: r.question,
        answer: r.answer ?? null,
        commentPrompt: r.comment_prompt,
        points: r.points,
      }));

      const results: QuestionResult[] = [];
      const llmCalls: { model: string; usage: { prompt_tokens: number; completion_tokens: number } }[] = [];
      for (const g of gradeChoiceQuestions(questions, answers)) {
        results.push({
          question_id: g.questionId,
          result: g.correct ? "correct" : "wrong",
          earned: g.earned,
          points: g.points,
          comment: null,
        });
      }
      for (const q of questions.filter(isShortAnswer)) {
        const pts = q.points ?? 1;
        const userAnswer = toArray(answers[q.id]).join("\n").trim();
        let earned = 0;
        let comment: string | null = null;
        if (userAnswer) {
          const prompts = buildShortAnswerGradePrompts({
            question: q.question, userAnswer, points: pts, commentPrompt: q.commentPrompt,
          });
          const llm = await getCallText()(prompts);
          llmCalls.push(llm);
          try {
            const match = llm.text.match(/\{[\s\S]*\}/);
            if (!match) throw new Error("no json");
            const parsed = JSON.parse(match[0]);
            earned = Math.max(0, Math.min(pts, Math.round(Number(parsed.score))));
            comment = String(parsed.comment || "");
          } catch {
            // 解析失败半分兜底
            earned = Math.round(pts * 0.5);
            comment = "已作答，请参考标准答案。";
          }
        }
        results.push({ question_id: q.id, result: resultOf(earned, pts), earned, points: pts, comment });
      }

      for (const r of results) {
        await pool.query(
          "INSERT INTO attempts (child_id, quiz_question_id, result, note) VALUES ($1, $2, $3, $4)",
          [quiz.child_id, r.question_id, r.result, String(r.earned)],
        );
      }
      await pool.query(
        "UPDATE quizzes SET status='submitted', submitted_at=now() WHERE id=$1", [id],
      );
      for (const call of llmCalls) await recordLlmCall(pool, call);

      const ordered = questions.map((q) => results.find((r) => r.question_id === q.id)!);
      return c.json({ quiz: await summaryById(pool, id), results: ordered });
    } catch (err) {
      return mapPgError(c, err);
    }
  });

  return app;
}
