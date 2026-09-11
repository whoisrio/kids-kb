/** 薄弱点自动出题 API（真库）：generate 对账 / 无弱 tag 409 / 非法输出 502 无残留 /
    pending 详情不含答案 / submit 判分+attempts+llm_calls / 重复 submit 409。
    LLM 走注入的假 callText（路由工厂 deps.callText），不打真模型。 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { Hono } from "hono";
import { resetDbForTest } from "../db.js";
import type { CallTextFn } from "../llm.js";
import { quizRoutes } from "./quizzes.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const CHILD = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

/** 假模型：出题返回固定 3 题（覆盖 string options / correctAnswer / 简答），判分返回固定 JSON。 */
const GEN_JSON = JSON.stringify([
  { id: "q1", type: "single", question: "23+49=?", options: ["62", "72", "82", "92"], correctAnswer: "B", analysis: "个位 3+9=12 进一", points: 10 },
  { id: "q2", type: "multiple", question: "下面哪些是偶数?", options: [{ label: "2", value: "A" }, { label: "3", value: "B" }, { label: "4", value: "C" }, { label: "5", value: "D" }], answer: ["A", "C"], analysis: "能被 2 整除", points: 10 },
  { id: "q3", type: "short_answer", question: "说说进位加法要注意什么", commentPrompt: "要点：数位对齐、满十进一", analysis: "参考答案", points: 10 },
]);
const fakeCallText: CallTextFn = async ({ system }) => {
  if (system.includes("教育评估专家")) {
    return { text: '{"score": 7, "comment": "基本答到要点"}', model: "fake", usage: { prompt_tokens: 5, completion_tokens: 6 } };
  }
  return { text: GEN_JSON, model: "fake", usage: { prompt_tokens: 10, completion_tokens: 20 } };
};

maybe("quizzes API（真库）", () => {
  let pool: pg.Pool;
  let app: Hono;
  let quizId = "";
  let questionIds: string[] = [];

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    app = new Hono();
    app.route("/api/quizzes", quizRoutes(pool, { callText: fakeCallText }));
    await pool.query(
      "INSERT INTO children (id, name, grade) VALUES ($1,'小宝','四年级'), ($2,'朵朵','二年级')",
      [CHILD, OTHER],
    );
    const doc = (await pool.query(
      `INSERT INTO documents (title, subject, doc_type, source_path) VALUES ('口算书','数学','workbook','/tmp/a.pdf')
       RETURNING id::text`,
    )).rows[0].id;
    const mkItem = async (label: string, content: string) =>
      (await pool.query(
        `INSERT INTO items (document_id, content_type, label, content_md, taxonomy, tags, qc_status)
         VALUES ($1,'exercise',$2,$3,'计算类',ARRAY['口算'],'approved') RETURNING id::text`,
        [doc, label, content],
      )).rows[0].id;
    const item1 = await mkItem("例 1", "例题：23+49 的进位加法");
    await mkItem("例 2", "例题：78-29 的退位减法");
    // 弱知识点来源：item1 最新一次 wrong
    await pool.query(
      "INSERT INTO attempts (child_id, item_id, result) VALUES ($1,$2,'wrong')",
      [CHILD, item1],
    );
  });
  afterAll(async () => { await pool.end(); });

  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("generate：落库字段逐一对账 + llm_calls 计量", async () => {
    const resp = await post("/api/quizzes/generate", { child_id: CHILD, count: 3 });
    expect(resp.status).toBe(200);
    const { quiz } = await resp.json();
    quizId = quiz.id;
    expect(quiz).toMatchObject({
      child_id: CHILD,
      status: "pending",
      question_count: 3,
      total_points: 30,
      earned_points: null,
      submitted_at: null,
    });
    expect(quiz.title).toContain("薄弱点强化");
    expect(quiz.title).toContain("计算类");
    expect([...quiz.tags].sort()).toEqual(["口算", "计算类"]);

    const { rows: qrows } = await pool.query(
      "SELECT * FROM quizzes WHERE id=$1", [quizId],
    );
    expect(qrows).toHaveLength(1);
    expect(qrows[0].status).toBe("pending");

    const { rows: qs } = await pool.query(
      "SELECT * FROM quiz_questions WHERE quiz_id=$1 ORDER BY seq", [quizId],
    );
    expect(qs).toHaveLength(3);
    questionIds = qs.map((r) => r.id);
    expect(qs.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(qs[0].type).toBe("single");
    expect(qs[0].options).toEqual([
      { value: "A", label: "62" }, { value: "B", label: "72" },
      { value: "C", label: "82" }, { value: "D", label: "92" },
    ]);
    expect(qs[0].answer).toEqual(["B"]);
    expect(qs[0].analysis).toContain("进一");
    expect(qs[1].type).toBe("multiple");
    expect(qs[1].answer).toEqual(["A", "C"]);
    expect(qs[2].type).toBe("short_answer");
    expect(qs[2].options).toBeNull();
    expect(qs[2].answer).toBeNull();
    expect(qs[2].comment_prompt).toContain("满十进一");

    const { rows: calls } = await pool.query(
      "SELECT * FROM llm_calls WHERE purpose='quiz' ORDER BY created_at",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      document_id: null, modality: "text", model: "fake",
      prompt_tokens: 10, completion_tokens: 20,
    });
  });

  it("generate 校验：缺 child_id 422；非法 UUID 422；不存在 404；无弱 tag 409", async () => {
    expect((await post("/api/quizzes/generate", {})).status).toBe(422);
    expect((await post("/api/quizzes/generate", { child_id: "not-a-uuid" })).status).toBe(422);
    expect((await post("/api/quizzes/generate", { child_id: "33333333-3333-3333-3333-333333333333" })).status).toBe(404);
    const resp = await post("/api/quizzes/generate", { child_id: OTHER });
    expect(resp.status).toBe(409);
    expect((await resp.json()).error).toBe("no_weak_tags");
  });

  it("generate：LLM 输出非法 → 502 且 quizzes 表无残留", async () => {
    const bad = new Hono();
    const badCall: CallTextFn = async () => ({
      text: "抱歉，我无法生成。", model: "fake", usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    bad.route("/api/quizzes", quizRoutes(pool, { callText: badCall }));
    const { rows: [{ c: before }] } = await pool.query(
      "SELECT count(*)::int AS c FROM quizzes WHERE child_id=$1", [CHILD],
    );
    const resp = await bad.request("/api/quizzes/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ child_id: CHILD }),
    });
    expect(resp.status).toBe(502);
    expect((await resp.json()).error).toBe("invalid_model_output");
    const { rows: [{ c: after }] } = await pool.query(
      "SELECT count(*)::int AS c FROM quizzes WHERE child_id=$1", [CHILD],
    );
    expect(after).toBe(before);
  });

  it("GET 列表按 created_at DESC；GET 详情 pending 不含 answer/analysis", async () => {
    const list = await (await app.request(`/api/quizzes?child_id=${CHILD}`)).json();
    expect(list.quizzes).toHaveLength(1);
    expect(list.quizzes[0]).toMatchObject({ id: quizId, question_count: 3, earned_points: null });

    const resp = await app.request(`/api/quizzes/${quizId}`);
    expect(resp.status).toBe(200);
    const { quiz } = await resp.json();
    expect(quiz.questions).toHaveLength(3);
    expect(quiz.questions[0]).toMatchObject({
      seq: 1, type: "single", question: "23+49=?",
      options: [{ value: "A", label: "62" }, { value: "B", label: "72" }, { value: "C", label: "82" }, { value: "D", label: "92" }],
      points: 10, answer: null, analysis: null,
    });
    expect(quiz.questions[2]).toMatchObject({ type: "short_answer", options: null, answer: null, analysis: null });
    expect((await app.request(`/api/quizzes/${OTHER}`)).status).toBe(404);
  });

  it("submit：选择本地判分 + 简答 AI 判分，attempts/result/earned 精确断言", async () => {
    const resp = await post(`/api/quizzes/${quizId}/submit`, {
      answers: { [questionIds[0]]: "B", [questionIds[1]]: ["A"], [questionIds[2]]: "要满十进一" },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.quiz).toMatchObject({ id: quizId, status: "submitted", earned_points: 17 });
    expect(body.quiz.submitted_at).toBeTruthy();

    const byQid = Object.fromEntries(
      (body.results as { question_id: string }[]).map((r) => [r.question_id, r]),
    );
    expect(byQid[questionIds[0]]).toMatchObject({ result: "correct", earned: 10, points: 10, comment: null });
    expect(byQid[questionIds[1]]).toMatchObject({ result: "wrong", earned: 0, points: 10 });
    expect(byQid[questionIds[2]]).toMatchObject({
      result: "partial", earned: 7, points: 10, comment: "基本答到要点",
    });

    const { rows: attempts } = await pool.query(
      "SELECT * FROM attempts WHERE quiz_question_id IS NOT NULL ORDER BY created_at",
    );
    expect(attempts).toHaveLength(3);
    const byQ = Object.fromEntries(attempts.map((a) => [a.quiz_question_id, a]));
    expect(byQ[questionIds[0]]).toMatchObject({ child_id: CHILD, result: "correct", error_cause: null });
    expect(byQ[questionIds[1]].result).toBe("wrong");
    expect(byQ[questionIds[2]].result).toBe("partial");

    // 简答判分也计量（generate 1 次 + 简答 1 次）
    const { rows: [{ c }] } = await pool.query("SELECT count(*)::int AS c FROM llm_calls WHERE purpose='quiz'");
    expect(c).toBe(2);
  });

  it("submit 后详情全量返回 answer/analysis + 逐题 results；重复 submit 409", async () => {
    const { quiz } = await (await app.request(`/api/quizzes/${quizId}`)).json();
    expect(quiz.questions[0].answer).toEqual(["B"]);
    expect(quiz.questions[0].analysis).toContain("进一");
    expect(quiz.earned_points).toBe(17);

    // 回顾用逐题结果：从 attempts 还原（comment 未持久化，恒为 null）
    expect(quiz.results).toHaveLength(3);
    const resByQid = Object.fromEntries(
      (quiz.results as { question_id: string }[]).map((r) => [r.question_id, r]),
    );
    expect(resByQid[questionIds[0]]).toMatchObject({ result: "correct", earned: 10, points: 10, comment: null });
    expect(resByQid[questionIds[1]]).toMatchObject({ result: "wrong", earned: 0, points: 10 });
    expect(resByQid[questionIds[2]]).toMatchObject({ result: "partial", earned: 7, points: 10 });

    const resp = await post(`/api/quizzes/${quizId}/submit`, { answers: {} });
    expect(resp.status).toBe(409);
    expect((await resp.json()).error).toBe("already_submitted");
    expect((await post(`/api/quizzes/${OTHER}/submit`, { answers: {} })).status).toBe(404);
  });
});
