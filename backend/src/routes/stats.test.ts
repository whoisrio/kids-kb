/** 统计聚合：题维度（coalesce(paper_question_id, item_id)）、周口径（本周一起）、
    已订正 = 曾错且最新 correct。种子时间全部锚 date_trunc('week'/'month', now())，确定性。 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { Hono } from "hono";
import { resetDbForTest } from "../db.js";
import { statsRoutes } from "./stats.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const CHILD = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

maybe("stats API（真库）", () => {
  let pool: pg.Pool;
  let app: Hono;
  let itemA = "";
  let itemB = "";
  let pq1 = "";
  let pq2 = "";

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    app = new Hono();
    app.route("/api/stats", statsRoutes(pool));
    await pool.query(
      "INSERT INTO children (id, name, grade) VALUES ($1,'小宝','四年级'), ($2,'朵朵','二年级')",
      [CHILD, OTHER],
    );
    const doc = (await pool.query(
      `INSERT INTO documents (title, subject, doc_type, source_path) VALUES ('口算书','数学','workbook','/tmp/a.pdf')
       RETURNING id::text`,
    )).rows[0].id;
    const mkItem = async (label: string, taxonomy: string, tags: string[]) =>
      (await pool.query(
        `INSERT INTO items (document_id, content_type, label, content_md, taxonomy, tags)
         VALUES ($1,'exercise',$2,$3,$4,$5) RETURNING id::text`,
        [doc, label, `${label} 内容`, taxonomy, tags],
      )).rows[0].id;
    itemA = await mkItem("例 1", "计算类", ["口算", "进位加"]);
    itemB = await mkItem("例 2", "几何类", ["图形"]);
    const paper = (await pool.query(
      `INSERT INTO papers (child_id, title, subject, page_count, status)
       VALUES ($1,'期中卷','数学',1,'done') RETURNING id::text`,
      [CHILD],
    )).rows[0].id;
    const mkPq = async (content: string, matched: string | null) =>
      (await pool.query(
        `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md, matched_item_id)
         VALUES ($1,1,$2,$3,$4) RETURNING id::text`,
        [paper, matched ? 1 : 2, content, matched],
      )).rows[0].id;
    pq1 = await mkPq("被匹配的试卷题干", itemA);
    pq2 = await mkPq("未挂题库的试卷题干", null);
    const wk = "date_trunc('week', now())";
    await pool.query(
      `INSERT INTO attempts (child_id, item_id, result, error_cause, created_at)
       VALUES ($1,$2,'wrong','方法不会', ${wk} - interval '13 days')`,
      [CHILD, itemA],
    );
    await pool.query(
      `INSERT INTO attempts (child_id, item_id, result, created_at)
       VALUES ($1,$2,'correct', ${wk} + interval '2 hours')`,
      [CHILD, itemA],
    );
    await pool.query(
      `INSERT INTO attempts (child_id, item_id, result, error_cause, created_at)
       VALUES ($1,$2,'wrong','粗心', ${wk} + interval '3 hours')`,
      [CHILD, itemB],
    );
    await pool.query(
      `INSERT INTO attempts (child_id, item_id, paper_question_id, result, error_cause, created_at)
       VALUES ($1,$2,$3,'partial','计算错', ${wk} + interval '4 hours')`,
      [CHILD, itemA, pq1],
    );
    await pool.query(
      `INSERT INTO attempts (child_id, paper_question_id, result, error_cause, created_at)
       VALUES ($1,$2,'wrong','概念不清', ${wk} - interval '6 days')`,
      [CHILD, pq2],
    );
    await pool.query(
      `INSERT INTO attempts (child_id, item_id, result, created_at)
       VALUES ($1,$2,'wrong', now())`,
      [OTHER, itemB],
    );
  });
  afterAll(async () => { await pool.end(); });

  async function overview(childId = CHILD) {
    const resp = await app.request(`/api/stats/overview?child_id=${childId}`);
    return { status: resp.status, body: await resp.json() };
  }

  it("hero：本周错题/正确率与环比/已订正/待重练", async () => {
    const { status, body } = await overview();
    expect(status).toBe(200);
    expect(body.hero).toMatchObject({ weekWrong: 2, weekTotal: 3 });
    expect(body.hero.weekRate).toBeCloseTo(1 / 3, 5);
    expect(body.hero.lastWeekRate).toBe(0);
    expect(body.hero.rateDelta).toBeCloseTo(1 / 3, 5);
    expect(body.hero).toMatchObject({ corrected: 1, pending: 3 });
  });

  it("causes：近 30 天 wrong/partial 按错因（空 → 未归类）", async () => {
    const { body } = await overview();
    const got = (body.causes as { cause: string; count: number }[]).map((c) => c.cause).sort();
    expect(got).toEqual(["概念不清", "方法不会", "粗心", "计算错"].sort());
    expect((body.causes as { count: number }[]).every((c) => c.count === 1)).toBe(true);
  });

  it("weakTags：待重练的题经 item（含 pq.matched_item_id）join taxonomy/tags", async () => {
    const { body } = await overview();
    const tags = Object.fromEntries(
      (body.weakTags as { tag: string; count: number }[]).map((t) => [t.tag, t.count]),
    );
    expect(tags).toEqual({ 几何类: 1, 图形: 1, 计算类: 1, 口算: 1, 进位加: 1 });
  });

  it("trend：近 8 周含当周，空周补零桶", async () => {
    const { body } = await overview();
    const trend = body.trend as { weekStart: string; total: number; correct: number; rate: number | null }[];
    expect(trend).toHaveLength(8);
    expect(trend[7].total).toBe(3);
    expect(trend[7].correct).toBe(1);
    expect(trend[6].total).toBe(1);
    expect(trend[5].total).toBe(1);
    const empty = trend.filter((w) => w.total === 0);
    expect(empty.length).toBeGreaterThanOrEqual(4);
    expect(empty.every((w) => w.rate === null)).toBe(true);
    for (const w of trend) expect(new Date(w.weekStart).getDay()).toBe(1);
  });

  it("pendingList：内容/来源/错因，未挂题库显示试卷题干", async () => {
    const { body } = await overview();
    const list = body.pendingList as {
      id: string; kind: "item" | "paper"; content: string; source: string; errorCause: string | null;
    }[];
    expect(list).toHaveLength(3);
    const byId = Object.fromEntries(list.map((x) => [x.id, x]));
    expect(byId[itemB]).toMatchObject({ kind: "item", content: "例 2 内容", errorCause: "粗心" });
    expect(byId[itemB].source).toContain("口算书");
    expect(byId[pq1]).toMatchObject({ kind: "paper", content: "被匹配的试卷题干", errorCause: "计算错" });
    expect(byId[pq2]).toMatchObject({ kind: "paper", content: "未挂题库的试卷题干", errorCause: "概念不清" });
    expect(byId[pq2].source).toContain("期中卷");
  });

  it("校验：child_id 必填 422；不存在 404；别的孩子数据不混入", async () => {
    expect((await app.request("/api/stats/overview")).status).toBe(422);
    expect((await app.request("/api/stats/overview?child_id=33333333-3333-3333-3333-333333333333")).status).toBe(404);
    const { body } = await overview(OTHER);
    expect(body.hero.weekWrong).toBe(1);
    expect(body.pendingList).toHaveLength(1);
  });
});
