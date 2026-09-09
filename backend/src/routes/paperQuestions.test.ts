import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { Hono } from "hono";
import { resetDbForTest } from "../db.js";
import { paperQuestionsRoutes } from "./paperQuestions.js";
import type { PaperJobDeps } from "../papers/jobs.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const CHILD = "11111111-1111-1111-1111-111111111111";
const DOC = "33333333-3333-3333-3333-333333333333";
const ITEM = "22222222-2222-2222-2222-222222222222";
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

maybe("paper-questions API（真库）", () => {
  let pool: pg.Pool;
  let app: Hono;
  let paperId: string;
  let q1: string;
  let q2: string;
  let storageRoot: string;

  const deps: PaperJobDeps = {
    pipelineUrl: "http://x", matchThreshold: 0.88,
    // embed 指向 ITEM(向量 V1),candidates 接口会命中它
    embed: async () => [[1, ...new Array(1023).fill(0)]],
    rerank: async (_q: string, docs: string[]) => docs.map(() => 1),
  };

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    storageRoot = mkdtempSync(join(tmpdir(), "kb-pq-test-"));
    await pool.query("INSERT INTO children (id, name) VALUES ($1,'小宝')", [CHILD]);
    await pool.query(
      "INSERT INTO documents (id, title, subject, source_path) VALUES ($1,'数学书','数学','/tmp/a.pdf')", [DOC]);
    await pool.query(
      "INSERT INTO items (id, document_id, content_type, label, content_md) VALUES ($1,$2,'exercise','1','135 ÷ 5 =')",
      [ITEM, DOC]);
    await pool.query(
      `INSERT INTO chunks (item_id, document_id, content_md, meta, embedding) VALUES
        ($1,$2,'135 ÷ 5 =','{"subject":"数学","label":"1","doc_title":"数学书"}'::jsonb,
         '[${[1, ...new Array(1023).fill(0)].join(",")}]'::vector)`, [ITEM, DOC]);
    const { rows: [p] } = await pool.query(
      "INSERT INTO papers (child_id, title, subject, status, page_count) VALUES ($1,'卷','数学','ready_for_review',1) RETURNING id::text",
      [CHILD]);
    paperId = p.id;
    const { rows: [a] } = await pool.query(
      `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md, recognized_result)
       VALUES ($1,1,1,'135 ÷ 5 =','wrong') RETURNING id::text`, [paperId]);
    q1 = a.id;
    const { rows: [b] } = await pool.query(
      `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md)
       VALUES ($1,1,2,'画一画') RETURNING id::text`, [paperId]);
    q2 = b.id;
    app = new Hono();
    app.route("/api/paper-questions", paperQuestionsRoutes(pool, deps, storageRoot));
  });
  afterAll(async () => { await pool.end(); });

  it("confirm:写 confirmed + INSERT attempt;全确认推进 done", async () => {
    const r = await app.request(`/api/paper-questions/${q1}/confirm`, {
      method: "PUT", body: JSON.stringify({ result: "wrong", error_cause: "计算错", note: "对位错" }),
      headers: { "Content-Type": "application/json" } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.paper_status).toBe("ready_for_review");  // 还有 q2 未确认
    const attempt = (await pool.query(
      "SELECT child_id::text, item_id, paper_question_id::text, result, error_cause, note FROM attempts")).rows[0];
    expect(attempt).toMatchObject({
      child_id: CHILD, item_id: null, paper_question_id: q1,
      result: "wrong", error_cause: "计算错", note: "对位错",
    });
    await app.request(`/api/paper-questions/${q2}/confirm`, {
      method: "PUT", body: JSON.stringify({ result: "correct" }),
      headers: { "Content-Type": "application/json" } });
    const paper = (await pool.query("SELECT status FROM papers WHERE id=$1", [paperId])).rows[0];
    expect(paper.status).toBe("done");
  });

  it("改判 = UPDATE 同一条 attempt(不追加);匹配后同步 item_id", async () => {
    await app.request(`/api/paper-questions/${q1}/confirm`, {
      method: "PUT", body: JSON.stringify({ result: "partial", error_cause: "粗心" }),
      headers: { "Content-Type": "application/json" } });
    const n = (await pool.query("SELECT count(*)::int AS n FROM attempts")).rows[0].n;
    expect(n).toBe(2);  // q1 + q2 各一条,改判没加行
    // 人工匹配 q1 -> ITEM
    const m = await app.request(`/api/paper-questions/${q1}/match`, {
      method: "PUT", body: JSON.stringify({ item_id: ITEM, score: 0.93 }),
      headers: { "Content-Type": "application/json" } });
    expect(m.status).toBe(200);
    const attempt = (await pool.query(
      "SELECT item_id::text, result FROM attempts WHERE paper_question_id=$1", [q1])).rows[0];
    expect(attempt).toMatchObject({ item_id: ITEM, result: "partial" });
    // 清除匹配 -> item_id 回 NULL(paper_question_id 仍在,CHECK 满足)
    await app.request(`/api/paper-questions/${q1}/match`, {
      method: "PUT", body: JSON.stringify({ item_id: null }),
      headers: { "Content-Type": "application/json" } });
    const cleared = (await pool.query(
      "SELECT item_id FROM attempts WHERE paper_question_id=$1", [q1])).rows[0];
    expect(cleared.item_id).toBeNull();
  });

  it("attempts.paper_question_id 有唯一索引:同题第二条被 DB 拒绝", async () => {
    const idx = (await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename='attempts'
       AND indexdef ILIKE '%paper_question_id%'`)).rows;
    expect(idx.some((r) => /UNIQUE/.test(r.indexdef))).toBe(true);
    // 绕过 API 直接插同 paper_question_id 第二条 → 唯一约束报 23505
    await expect(pool.query(
      `INSERT INTO attempts (child_id, item_id, paper_question_id, result)
       VALUES ($1,NULL,$2,'wrong')`, [CHILD, q1])).rejects.toMatchObject({ code: "23505" });
  });

  it("校验:result 枚举 422;match 不存在 item 404;不存在题目 404", async () => {
    const bad = await app.request(`/api/paper-questions/${q1}/confirm`, {
      method: "PUT", body: JSON.stringify({ result: "对" }),
      headers: { "Content-Type": "application/json" } });
    expect(bad.status).toBe(422);
    const badItem = await app.request(`/api/paper-questions/${q1}/match`, {
      method: "PUT", body: JSON.stringify({ item_id: "99999999-9999-9999-9999-999999999999" }),
      headers: { "Content-Type": "application/json" } });
    expect(badItem.status).toBe(404);
    const missing = await app.request(`/api/paper-questions/88888888-8888-8888-8888-888888888888/confirm`, {
      method: "PUT", body: JSON.stringify({ result: "wrong" }),
      headers: { "Content-Type": "application/json" } });
    expect(missing.status).toBe(404);
  });

  it("candidates:实时检索返回 top 候选(带 doc_title/label)", async () => {
    const r = await app.request(`/api/paper-questions/${q1}/candidates`);
    expect(r.status).toBe(200);
    const { candidates } = await r.json();
    expect(candidates[0]).toMatchObject({
      item_id: ITEM, doc_title: "数学书", label: "1",
    });
    expect(candidates[0].vec_score).toBeGreaterThan(0.88);
  });

  it("GET /:id/image：相对路径经 resolveStoragePath 解析（不再读原始绝对路径）", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const rel = join("papers", paperId, "questions", "p0001_q01.png");
    mkdirSync(join(storageRoot, "papers", paperId, "questions"), { recursive: true });
    writeFileSync(join(storageRoot, rel), PNG_1PX);
    await pool.query("UPDATE paper_questions SET image_path=$1 WHERE id=$2", [rel, q1]);
    const a = new Hono();
    a.route("/api/paper-questions", paperQuestionsRoutes(pool, deps, storageRoot));
    const resp = await a.request(`/api/paper-questions/${q1}/image`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("image/png");
  });

  it("非 UUID id 统一 422(candidates/image)", async () => {
    expect((await app.request("/api/paper-questions/not-a-uuid/candidates")).status).toBe(422);
    expect((await app.request("/api/paper-questions/not-a-uuid/image")).status).toBe(422);
  });
});
