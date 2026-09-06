# Phase 3-C3 统计 + 用量页 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统计页（孩子维度的错题/正确率/错因/薄弱点/趋势/待重练订正）+ 用量页（token/调用聚合与流水）落地为真实数据，Rail 占位转正，App 顶栏孩子切换接 `GET /api/children`。

**Architecture:** 依据 `docs/superpowers/specs/2026-09-05-phase3-c-design.md`（Workstream C）。后端两个纯读路由：`GET /api/stats/overview?child_id=`（attempts 按「题维度 = coalesce(paper_question_id, item_id)」聚合，已订正 = 曾错且最新一次 correct）与 `GET /api/usage/overview`（llm_calls 自然月聚合，modality 空计入文本）；订正写回复用现有路由（item 维度 `POST /api/attempts`、试卷题维度 `PUT /api/paper-questions/:id/confirm` 的 attempts upsert），不新增写路径。前端 StatsView/UsageView 纯 CSS 图表（条形/柱状/标签云，不引图表库），App 视图态扩展为 chat|review|stats|usage，孩子切换与 Rail 底部 chip 接真数据。

**Tech Stack:** backend：hono + pg + vitest（真库）；frontend：React + vitest(jsdom)；e2e：Playwright（真三服务，断言到 SQL 直查字段级一致）。

**执行顺序:** Task 1-2 后端 stats → Task 3 后端 usage → Task 4-6 前端 → Task 7 App/Rail 接线 → Task 8 E2E → Task 9 文档回写。严格按序。

**测试约定:**

- backend：`cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
- frontend：`cd frontend && npm test`
- E2E：`cd e2e && npx playwright test specs/stats-usage.spec.ts`

**Spec 偏差记录:**

- 「已订正」的口径在 spec 字面（「最新一次 attempt 为 correct」）上补「曾错」（`ever_wrong`）：否则首答即对的题也会计入「已订正」，与「待重练」构成的两个互补状态失去语义；两状态同覆盖「错题宇宙」（至少一次 wrong/partial 的题）。
- 错因分布把 `error_cause` 为空的 wrong/partial 计入「未归类」：否则条形图计数与 Hero 错题数对不上，家长侧不可解释。
- 订正写走两条既有路由（spec 只写了 `POST /api/attempts`，但该路由要求 `item_id`，试卷题维度进不去）：item 题 → `POST /api/attempts`；试卷题 → `PUT /api/paper-questions/:id/confirm`（其内部就是该题 attempt 的 upsert，改判不追加）。零新增写路径。
- StatsView 的孩子选择器按 spec 放 App 顶栏（聊天/统计两个视图共用），非 StatsView 内嵌。

---

## 文件结构（本计划涉及的全部文件）

- Create: `backend/src/routes/stats.ts` —— `GET /api/stats/overview?child_id=`
- Create: `backend/src/routes/stats.test.ts` —— 真库用例
- Create: `backend/src/routes/usage.ts` —— `GET /api/usage/overview`
- Create: `backend/src/routes/usage.test.ts` —— 真库用例
- Modify: `backend/src/index.ts` —— 挂载 `/api/stats`、`/api/usage`
- Create: `frontend/src/api/stats.ts` —— stats/usage client + 订正动作
- Create: `frontend/src/api/stats.test.ts`
- Create: `frontend/src/views/StatsView.tsx`
- Create: `frontend/src/views/StatsView.test.tsx`
- Create: `frontend/src/views/UsageView.tsx`
- Create: `frontend/src/views/UsageView.test.tsx`
- Modify: `frontend/src/components/Rail.tsx` —— 统计/用量转正
- Modify: `frontend/src/App.tsx` —— 视图态 + 孩子接真数据
- Modify: `frontend/src/App.test.tsx` —— 孩子下拉/视图切换用例
- Modify: `frontend/src/theme.css` —— 图表样式
- Create: `e2e/specs/stats-usage.spec.ts`
- Docs: `README.md`

---

### Task 1: backend stats 路由——hero/趋势/错因/薄弱点/待重练聚合

**Files:**

- Create: `backend/src/routes/stats.ts`
- Create: `backend/src/routes/stats.test.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: 写失败测试（stats.test.ts 全量）**

```ts
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
  /** 种子返回的 ids。 */
  let itemA = "";
  let itemB = "";
  let pq1 = "";
  let pq2 = "";

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    app = new Hono();
    app.route("/api/stats", statsRoutes(pool));
    await pool.query("INSERT INTO children (id, name, grade) VALUES ($1,'小宝','四年级'), ($2,'朵朵','二年级')", [CHILD, OTHER]);
    // 文档 + 两个条目（taxonomy/tags 供薄弱点）
    const doc = (await pool.query(
      `INSERT INTO documents (title, subject, doc_type, source_path) VALUES ('口算书','数学','workbook','/tmp/a.pdf')
       RETURNING id::text`)).rows[0].id;
    const mkItem = async (label: string, taxonomy: string, tags: string[]) =>
      (await pool.query(
        `INSERT INTO items (document_id, content_type, label, content_md, taxonomy, tags)
         VALUES ($1,'exercise',$2,$3,$4,$5) RETURNING id::text`,
        [doc, label, `${label} 内容`, taxonomy, tags])).rows[0].id;
    itemA = await mkItem("例 1", "计算类", ["口算", "进位加"]);
    itemB = await mkItem("例 2", "几何类", ["图形"]);
    // 试卷 + 两个试卷题（pq1 匹配 itemA；pq2 未匹配）
    const paper = (await pool.query(
      `INSERT INTO papers (child_id, title, subject, page_count, status)
       VALUES ($1,'期中卷','数学',1,'done') RETURNING id::text`, [CHILD])).rows[0].id;
    const mkPq = async (content: string, matched: string | null) =>
      (await pool.query(
        `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md, matched_item_id)
         VALUES ($1,1,$2,$3,$4) RETURNING id::text`,
        [paper, matched ? 1 : 2, content, matched])).rows[0].id;
    pq1 = await mkPq("被匹配的试卷题干", itemA);
    pq2 = await mkPq("未挂题库的试卷题干", null);
    // attempts：时间锚周/月边界（date_trunc），与被测 SQL 同口径
    const wk = "date_trunc('week', now())";
    // A：两周前错（方法不会）+ 本周对 → 已订正
    await pool.query(
      `INSERT INTO attempts (child_id, item_id, result, error_cause, created_at)
       VALUES ($1,$2,'wrong','方法不会', ${wk} - interval '13 days')`, [CHILD, itemA]);
    await pool.query(
      `INSERT INTO attempts (child_id, item_id, result, created_at)
       VALUES ($1,$2,'correct', ${wk} + interval '2 hours')`, [CHILD, itemA]);
    // B：本周错（粗心）→ 待重练
    await pool.query(
      `INSERT INTO attempts (child_id, item_id, result, error_cause, created_at)
       VALUES ($1,$2,'wrong','粗心', ${wk} + interval '3 hours')`, [CHILD, itemB]);
    // pq1（匹配 A）：本周半对（计算错）→ 待重练
    await pool.query(
      `INSERT INTO attempts (child_id, item_id, paper_question_id, result, error_cause, created_at)
       VALUES ($1,$2,$3,'partial','计算错', ${wk} + interval '4 hours')`, [CHILD, itemA, pq1]);
    // pq2（未匹配）：上周错（概念不清）→ 待重练，内容显示试卷题干
    await pool.query(
      `INSERT INTO attempts (child_id, paper_question_id, result, error_cause, created_at)
       VALUES ($1,$2,'wrong','概念不清', ${wk} - interval '6 days')`, [CHILD, pq2]);
    // 别的孩子的数据（不得混入）
    await pool.query(
      `INSERT INTO attempts (child_id, item_id, result, created_at)
       VALUES ($1,$2,'wrong', now())`, [OTHER, itemB]);
  });
  afterAll(async () => { await pool.end(); });

  async function overview(childId = CHILD) {
    const resp = await app.request(`/api/stats/overview?child_id=${childId}`);
    return { status: resp.status, body: await resp.json() };
  }

  it("hero：本周错题/正确率与环比/已订正/待重练", async () => {
    const { status, body } = await overview();
    expect(status).toBe(200);
    // 本周（周一 00:00 起）：A-correct、B-wrong、pq1-partial → total 3 / correct 1 / wrong+partial 2
    expect(body.hero).toMatchObject({ weekWrong: 2, weekTotal: 3 });
    expect(body.hero.weekRate).toBeCloseTo(1 / 3, 5);
    // 上周：pq2-wrong → total 1 / correct 0 → 环比 = 1/3 - 0 = +33.3pp
    expect(body.hero.lastWeekRate).toBe(0);
    expect(body.hero.rateDelta).toBeCloseTo(1 / 3, 5);
    // 错题宇宙：A（曾错最新对 → 已订正）、B、pq1、pq2（最新错/半对 → 待重练）
    expect(body.hero).toMatchObject({ corrected: 1, pending: 3 });
  });

  it("causes：近 30 天 wrong/partial 按错因（空 → 未归类）", async () => {
    const { body } = await overview();
    // 本种子 count 全为 1，按 cause 集合断言（返回序按 count DESC, cause 字典序）
    const got = (body.causes as { cause: string; count: number }[]).map((c) => c.cause).sort();
    expect(got).toEqual(["概念不清", "方法不会", "粗心", "计算错"].sort());
    expect((body.causes as { count: number }[]).every((c) => c.count === 1)).toBe(true);
  });

  it("weakTags：待重练的题经 item（含 pq.matched_item_id）join taxonomy/tags", async () => {
    const { body } = await overview();
    const tags = Object.fromEntries((body.weakTags as { tag: string; count: number }[]).map((t) => [t.tag, t.count]));
    // B（几何类/图形）+ pq1（匹配 itemA → 计算类/口算/进位加）；pq2 无 item 不计
    expect(tags).toEqual({ 几何类: 1, 图形: 1, 计算类: 1, 口算: 1, 进位加: 1 });
  });

  it("trend：近 8 周含当周，空周补零桶", async () => {
    const { body } = await overview();
    const trend = body.trend as { weekStart: string; total: number; correct: number; rate: number | null }[];
    expect(trend).toHaveLength(8);
    expect(trend[7].total).toBe(3); // 当周
    expect(trend[7].correct).toBe(1);
    expect(trend[6].total).toBe(1); // 上周（pq2）
    expect(trend[5].total).toBe(1); // 两周前（A 的 wrong，13 天前落在此桶或更早——见下条断言）
    // 空周 rate 为 null
    const empty = trend.filter((w) => w.total === 0);
    expect(empty.length).toBeGreaterThanOrEqual(4);
    expect(empty.every((w) => w.rate === null)).toBe(true);
    // 全部桶周一起始（周一 ISO）
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
```

（「未归类」口径由 causes SQL 的 `coalesce(error_cause,'未归类')` 保证，本种子四条 wrong/partial 均带错因故不出现；如需钉死可另加一条无错因的 wrong 用例，但注意它会改变 hero/pendingList 断言。trend 第 5 桶断言：13 天前必落「两周前」桶（周一锚点 -13 天 ≥ -14 天），若执行时因时区差一桶，以「非空桶合计 total=5」为准——`trend.filter(w=>w.total>0).reduce((s,w)=>s+w.total,0) === 5`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/stats.test.ts`
Expected: FAIL——`Cannot find module './stats.js'`。

- [ ] **Step 3: 实现（创建 stats.ts）**

```ts
/** 统计页聚合：attempts 按题维度（coalesce(paper_question_id, item_id)）。
    口径（spec Workstream C）：
    - 已订正 = 曾错（≥1 次 wrong/partial）且最新一次 correct；待重练 = 最新一次 wrong/partial。
    - 本周 = 本周一起（date_trunc('week')，PG 即周一）；趋势近 8 周含当周。
    - 正确率 = correct / 总次数（partial 计分母不计分子）；环比为百分点差。
    - 未挂题库的试卷题计入统计，内容显示试卷题干。 */
import { Hono } from "hono";
import type pg from "pg";

/** 题维度窗口：qid + 最新一次（rn=1）+ 是否曾错。各聚合块共用。 */
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

      // Hero：本周/上周次数（单行聚合）
      const { rows: [hero0] } = await pool.query(
        `SELECT
           count(*) FILTER (WHERE created_at >= date_trunc('week', now()))::int AS week_total,
           count(*) FILTER (WHERE created_at >= date_trunc('week', now()) AND result='correct')::int AS week_correct,
           count(*) FILTER (WHERE created_at >= date_trunc('week', now()) AND result IN ('wrong','partial'))::int AS week_wrong,
           count(*) FILTER (WHERE created_at >= date_trunc('week', now()) - interval '1 week'
                            AND created_at < date_trunc('week', now()))::int AS last_total,
           count(*) FILTER (WHERE created_at >= date_trunc('week', now()) - interval '1 week'
                            AND created_at < date_trunc('week', now()) AND result='correct')::int AS last_correct
         FROM attempts WHERE child_id = $1`, [childId]);
      const rate = (correct: number, total: number) => (total === 0 ? null : correct / total);
      const weekRate = rate(hero0.week_correct, hero0.week_total);
      const lastWeekRate = rate(hero0.last_correct, hero0.last_total);

      // 错题宇宙：已订正 / 待重练 + 待重练清单
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
         WHERE q.rn = 1 AND q.ever_wrong`, [childId]);
      const pendingRows = latest.filter((r) => r.result === "wrong" || r.result === "partial");
      const corrected = latest.length - pendingRows.length;

      // 错因分布：近 30 天 wrong/partial（空 → 未归类）
      const { rows: causes } = await pool.query(
        `SELECT coalesce(error_cause, '未归类') AS cause, count(*)::int AS count
         FROM attempts
         WHERE child_id = $1 AND result IN ('wrong','partial') AND created_at >= now() - interval '30 days'
         GROUP BY 1 ORDER BY 2 DESC, 1`, [childId]);

      // 薄弱知识点：待重练的题经 item（attempt.item_id 或 pq.matched_item_id）join taxonomy/tags
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
         ) s WHERE tag IS NOT NULL GROUP BY tag ORDER BY 2 DESC, 1 LIMIT 20`, [childId]);

      // 趋势：近 8 周（含当周），空周在 TS 补桶
      const { rows: trendRows } = await pool.query(
        `SELECT date_trunc('week', created_at) AS week, count(*)::int AS total,
                count(*) FILTER (WHERE result='correct')::int AS correct
         FROM attempts
         WHERE child_id = $1 AND created_at >= date_trunc('week', now()) - interval '7 weeks'
         GROUP BY 1`, [childId]);
      const byWeek = new Map(trendRows.map((r) => [new Date(r.week).toISOString().slice(0, 10), r]));
      const trend: { weekStart: string; total: number; correct: number; rate: number | null }[] = [];
      for (let i = 7; i >= 0; i--) {
        const { rows: [bucket] } = await pool.query(
          `SELECT to_char(date_trunc('week', now()) - ($2::text || ' days')::interval, 'YYYY-MM-DD') AS ws`, [0, i * 7]);
        const row = byWeek.get(bucket.ws);
        const total = row?.total ?? 0;
        const correct = row?.correct ?? 0;
        trend.push({ weekStart: bucket.ws, total, correct, rate: rate(correct, total) });
      }

      return c.json({
        hero: {
          weekWrong: hero0.week_wrong, weekTotal: hero0.week_total,
          weekRate, lastWeekRate,
          rateDelta: weekRate === null || lastWeekRate === null ? null : weekRate - lastWeekRate,
          corrected, pending: pendingRows.length,
        },
        causes,
        weakTags,
        trend,
        pendingList: pendingRows.map((r) => ({
          id: r.qid,
          kind: r.paper_question_id ? "paper" : "item",
          content: r.item_content ?? r.pq_content ?? "",
          source: r.doc_title
            ? `《${r.doc_title}》${r.chapter ? ` ${r.chapter}` : ""}${r.label ? ` · ${r.label}` : ""}`
            : `《${r.paper_title ?? "试卷"}》`,
          errorCause: r.error_cause,
          lastAt: r.created_at,
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
```

（趋势补桶的逐桶 SQL 简单直接；8 次轻查询对家庭规模无感，换来与 `date_trunc` 完全同口径、免 JS 时区运算。）

`index.ts` 挂载（usage Task 3 一并挂，此处先挂 stats）：

```ts
import { statsRoutes } from "./routes/stats.js";
// createApp 内：
  app.route("/api/stats", statsRoutes(pool));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/stats.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/stats.ts backend/src/routes/stats.test.ts backend/src/index.ts
git commit -m "feat(backend): /api/stats/overview——错题/正确率/错因/薄弱点/趋势/待重练聚合"
```

---

### Task 2: backend usage 路由——token/调用聚合与流水

**Files:**

- Create: `backend/src/routes/usage.ts`
- Create: `backend/src/routes/usage.test.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: 写失败测试（usage.test.ts）**

```ts
/** 用量聚合：本月自然月口径；modality 空的历史行计入文本；纪律：token 统计不进统计页。 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { Hono } from "hono";
import { resetDbForTest } from "../db.js";
import { usageRoutes } from "./usage.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("usage API（真库）", () => {
  let pool: pg.Pool;
  let app: Hono;

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    app = new Hono();
    app.route("/api/usage", usageRoutes(pool));
    const ins = async (cols: string, vals: unknown[]) =>
      pool.query(`INSERT INTO llm_calls (${cols}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(",")})`, vals);
    // 本月：2 条文本（chat / qwen3.5:4b）+ 1 条图像（vlm / qwen3.8-27b）+ 1 条历史无 modality
    await ins("purpose, model, modality, prompt_tokens, completion_tokens, created_at",
      ["chat", "qwen3.5:4b", "text", 100, 50, "date_trunc('month', now()) + interval '1 hour'"]);
    await ins("purpose, model, modality, prompt_tokens, completion_tokens, created_at",
      ["chat", "qwen3.5:4b", "text", 60, 40, "date_trunc('month', now()) + interval '2 hours'"]);
    await ins("purpose, model, modality, prompt_tokens, completion_tokens, created_at",
      ["vlm", "qwen3.8-27b", "image", 200, 100, "date_trunc('month', now()) + interval '3 hours'"]);
    await ins("purpose, model, prompt_tokens, completion_tokens, created_at",
      ["parse", "qwen3.5:2b", 10, 5, "date_trunc('month', now()) + interval '4 hours'"]); // modality 空 → 文本
    // 上月（不计入 hero，但出现在流水里？——流水取最新 50 条不限月份）
    await ins("purpose, model, modality, prompt_tokens, completion_tokens, created_at",
      ["chat", "qwen3.5:4b", "text", 999, 999, "date_trunc('month', now()) - interval '10 days'"]);
  });
  afterAll(async () => { await pool.end(); });

  it("hero：本月 token 总量/文本图像分列/调用次数（modality 空计入文本）", async () => {
    const resp = await app.request("/api/usage/overview");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.hero).toEqual({
      promptTokens: 370, completionTokens: 195, totalTokens: 565, calls: 4,
      textTokens: 265, imageTokens: 300,
    });
  });

  it("byPurpose / byModel：本月聚合", async () => {
    const { byPurpose, byModel } = await (await app.request("/api/usage/overview")).json();
    expect(byPurpose).toEqual([
      { purpose: "chat", calls: 2, tokens: 250 },
      { purpose: "vlm", calls: 1, tokens: 300 },
      { purpose: "parse", calls: 1, tokens: 15 },
    ]);
    expect(byModel).toEqual([
      { model: "qwen3.5:4b", calls: 2, tokens: 250 },
      { model: "qwen3.8-27b", calls: 1, tokens: 300 },
      { model: "qwen3.5:2b", calls: 1, tokens: 15 },
    ]);
  });

  it("recent：最新 50 条流水（含上月行，按时间倒序）", async () => {
    const { recent } = await (await app.request("/api/usage/overview")).json();
    expect(recent).toHaveLength(5);
    expect(recent[0].purpose).toBe("parse"); // 本月 +4h 最新
    expect(recent[4].prompt_tokens).toBe(999); // 上月行最后
    expect(recent[0]).toMatchObject({ model: "qwen3.5:2b", modality: "text", prompt_tokens: 10, completion_tokens: 5 });
  });
});
```

（`modality` 读出时空值在 SQL 侧 `coalesce(modality,'text')` 归一为 `text`，断言按 `text` 写死。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/usage.test.ts`
Expected: FAIL——`Cannot find module './usage.js'`。

- [ ] **Step 3: 实现（创建 usage.ts）**

```ts
/** 用量页聚合：llm_calls 本月（自然月）口径；modality 为空的历史行计入文本。
    纪律：token 统计不进统计页，两页分离（spec Workstream C2）。 */
import { Hono } from "hono";
import type pg from "pg";

const TOKENS = "(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0))";

export function usageRoutes(pool: pg.Pool): Hono {
  const app = new Hono({ strict: false });

  app.get("/overview", async (c) => {
    const month = "created_at >= date_trunc('month', now())";
    const { rows: [hero0] } = await pool.query(
      `SELECT
         coalesce(sum(coalesce(prompt_tokens, 0)), 0)::int AS prompt_tokens,
         coalesce(sum(coalesce(completion_tokens, 0)), 0)::int AS completion_tokens,
         count(*)::int AS calls,
         coalesce(sum(CASE WHEN coalesce(modality, 'text') = 'text' THEN ${TOKENS} ELSE 0 END), 0)::int AS text_tokens,
         coalesce(sum(CASE WHEN coalesce(modality, 'text') = 'image' THEN ${TOKENS} ELSE 0 END), 0)::int AS image_tokens
       FROM llm_calls WHERE ${month}`);
    const { rows: byPurpose } = await pool.query(
      `SELECT purpose, count(*)::int AS calls, coalesce(sum(${TOKENS}), 0)::int AS tokens
       FROM llm_calls WHERE ${month} GROUP BY purpose ORDER BY tokens DESC`);
    const { rows: byModel } = await pool.query(
      `SELECT model, count(*)::int AS calls, coalesce(sum(${TOKENS}), 0)::int AS tokens
       FROM llm_calls WHERE ${month} GROUP BY model ORDER BY tokens DESC`);
    const { rows: recent } = await pool.query(
      `SELECT id::text, created_at, purpose, model, coalesce(modality, 'text') AS modality,
              coalesce(prompt_tokens, 0)::int AS prompt_tokens,
              coalesce(completion_tokens, 0)::int AS completion_tokens
       FROM llm_calls ORDER BY created_at DESC LIMIT 50`);
    return c.json({
      hero: { ...hero0, totalTokens: hero0.prompt_tokens + hero0.completion_tokens },
      byPurpose, byModel, recent,
    });
  });

  return app;
}
```

`index.ts` 补挂载：

```ts
import { usageRoutes } from "./routes/usage.js";
// createApp 内：
  app.route("/api/usage", usageRoutes(pool));
```

- [ ] **Step 4: 跑测试确认通过 + backend 全量**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/usage.ts backend/src/routes/usage.test.ts backend/src/index.ts
git commit -m "feat(backend): /api/usage/overview——本月 token/调用聚合与流水"
```

---

### Task 3: 前端 api/stats.ts——client + 类型 + 订正动作

**Files:**

- Create: `frontend/src/api/stats.ts`
- Create: `frontend/src/api/stats.test.ts`

- [ ] **Step 1: 写失败测试（stats.test.ts）**

```ts
import { describe, expect, it } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { fetchStatsOverview, fetchUsageOverview, recordCorrection } from "./stats";

describe("api/stats", () => {
  it("fetchStatsOverview 拼 child_id；fetchUsageOverview 无参", async () => {
    let seen = "";
    const fetchImpl = async (input: RequestInfo | URL) => { seen = String(input); return jsonResponse({ hero: {}, causes: [], weakTags: [], trend: [], pendingList: [] }); };
    await fetchStatsOverview("c1", fetchImpl);
    expect(seen).toBe("/api/stats/overview?child_id=c1");
    await fetchUsageOverview(fetchImpl);
    expect(seen).toBe("/api/usage/overview");
  });

  it("recordCorrection：item 题 → POST /api/attempts；试卷题 → PUT confirm", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return jsonResponse({ id: "x" });
    };
    await recordCorrection({ id: "i1", kind: "item", content: "", source: "", errorCause: null, lastAt: "" }, "c1", fetchImpl);
    await recordCorrection({ id: "pq1", kind: "paper", content: "", source: "", errorCause: null, lastAt: "" }, "c1", fetchImpl);
    expect(calls).toEqual([
      { method: "POST", url: "/api/attempts", body: { child_id: "c1", item_id: "i1", result: "correct" } },
      { method: "PUT", url: "/api/paper-questions/pq1/confirm", body: { result: "correct" } },
    ]);
  });

  it("非 2xx 抛错（message 取 body.error）", async () => {
    const fetchImpl = fetchRouter({
      "/api/stats/overview?child_id=nope": () => jsonResponse({ error: "child_id 不存在" }, 404),
    });
    await expect(fetchStatsOverview("nope", fetchImpl)).rejects.toThrow("child_id 不存在");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/api/stats.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现（api/stats.ts）**

```ts
/** 统计/用量 API（frontend 视角）：类型与 backend routes/stats.ts、usage.ts 对齐。
    订正写回复用既有路由：item 题 POST /api/attempts；试卷题 PUT confirm（内部即该题 attempt 的 upsert）。 */

export interface StatsHero {
  weekWrong: number;
  weekTotal: number;
  weekRate: number | null;
  lastWeekRate: number | null;
  rateDelta: number | null;
  corrected: number;
  pending: number;
}

export interface PendingEntry {
  id: string;
  kind: "item" | "paper";
  content: string;
  source: string;
  errorCause: string | null;
  lastAt: string;
}

export interface StatsOverview {
  hero: StatsHero;
  causes: { cause: string; count: number }[];
  weakTags: { tag: string; count: number }[];
  trend: { weekStart: string; total: number; correct: number; rate: number | null }[];
  pendingList: PendingEntry[];
}

export interface UsageOverview {
  hero: {
    promptTokens: number; completionTokens: number; totalTokens: number;
    calls: number; textTokens: number; imageTokens: number;
  };
  byPurpose: { purpose: string; calls: number; tokens: number }[];
  byModel: { model: string; calls: number; tokens: number }[];
  recent: {
    id: string; created_at: string; purpose: string; model: string;
    modality: string; prompt_tokens: number; completion_tokens: number;
  }[];
}

type FetchLike = typeof fetch;

async function getJson<T>(url: string, fetchImpl: FetchLike): Promise<T> {
  const resp = await fetchImpl(url);
  if (!resp.ok) {
    let msg = `请求失败: ${resp.status}`;
    try { msg = ((await resp.json()) as { error?: string }).error ?? msg; } catch { /* 非 JSON 错误体 */ }
    throw new Error(msg);
  }
  return (await resp.json()) as T;
}

export function fetchStatsOverview(childId: string, fetchImpl: FetchLike = fetch): Promise<StatsOverview> {
  return getJson(`/api/stats/overview?child_id=${encodeURIComponent(childId)}`, fetchImpl);
}

export function fetchUsageOverview(fetchImpl: FetchLike = fetch): Promise<UsageOverview> {
  return getJson("/api/usage/overview", fetchImpl);
}

/** 「已订正」：给该题记一条 correct。
    item 题 → POST /api/attempts（追加历史）；试卷题 → PUT confirm（唯一 attempt 的改判 upsert）。 */
export async function recordCorrection(entry: PendingEntry, childId: string, fetchImpl: FetchLike = fetch): Promise<void> {
  if (entry.kind === "item") {
    const resp = await fetchImpl("/api/attempts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ child_id: childId, item_id: entry.id, result: "correct" }),
    });
    if (!resp.ok) {
      let msg = `请求失败: ${resp.status}`;
      try { msg = ((await resp.json()) as { error?: string }).error ?? msg; } catch { /* 非 JSON */ }
      throw new Error(msg);
    }
    return;
  }
  const resp = await fetchImpl(`/api/paper-questions/${encodeURIComponent(entry.id)}/confirm`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result: "correct" }),
  });
  if (!resp.ok) {
    let msg = `请求失败: ${resp.status}`;
    try { msg = ((await resp.json()) as { error?: string }).error ?? msg; } catch { /* 非 JSON */ }
    throw new Error(msg);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/api/stats.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/stats.ts frontend/src/api/stats.test.ts
git commit -m "feat(frontend): stats/usage client + 已订正动作（双路由分发）"
```

---

### Task 4: 前端 StatsView——Hero/错因/薄弱点/趋势/待重练清单

**Files:**

- Create: `frontend/src/views/StatsView.tsx`
- Create: `frontend/src/views/StatsView.test.tsx`
- Modify: `frontend/src/theme.css`

- [ ] **Step 1: 写失败测试（StatsView.test.tsx）**

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { StatsView } from "./StatsView";

const OVERVIEW = {
  hero: { weekWrong: 2, weekTotal: 3, weekRate: 1 / 3, lastWeekRate: 0, rateDelta: 1 / 3, corrected: 1, pending: 3 },
  causes: [{ cause: "粗心", count: 3 }, { cause: "概念不清", count: 1 }],
  weakTags: [{ tag: "计算类", count: 2 }, { tag: "口算", count: 1 }],
  trend: Array.from({ length: 8 }, (_, i) => ({ weekStart: `2026-09-0${i + 1}`, total: 0, correct: 0, rate: null })),
  pendingList: [
    { id: "i1", kind: "item" as const, content: "例 2 内容", source: "《口算书》 第 1 讲 · 例 2", errorCause: "粗心", lastAt: "2026-09-05T00:00:00Z" },
    { id: "pq1", kind: "paper" as const, content: "未挂题库的试卷题干", source: "《期中卷》", errorCause: null, lastAt: "2026-09-04T00:00:00Z" },
  ],
};

function stub(over: Record<string, (init?: RequestInit) => Response> = {}) {
  return fetchRouter({
    "/api/stats/overview?child_id=c1": () => jsonResponse({ ...OVERVIEW, ...over }),
    ...over,
  });
}

describe("StatsView", () => {
  it("无孩子：空态提示", async () => {
    render(<StatsView childId={null} onToast={vi.fn()} />);
    expect(screen.getByText(/先在复核页上传试卷时添加孩子/)).toBeInTheDocument();
  });

  it("Hero 四卡 + 环比符号 + 错因条形 + 薄弱标签 + 趋势柱", async () => {
    render(<StatsView childId="c1" onToast={vi.fn()} fetchImpl={stub()} />);
    expect(await screen.findByText("2", { selector: ".hero-card[data-k=week-wrong] .num" })).toBeInTheDocument();
    expect(screen.getByText("1", { selector: ".hero-card[data-k=corrected] .num" })).toBeInTheDocument();
    expect(screen.getByText("3", { selector: ".hero-card[data-k=pending] .num" })).toBeInTheDocument();
    // 正确率 33% 与环比 +33.3pp
    expect(screen.getByText(/33%/)).toBeInTheDocument();
    expect(screen.getByText(/\+33\.3pp/)).toBeInTheDocument();
    // 错因条形（宽度按最大值比例）
    const bars = screen.getAllByTestId("cause-bar");
    expect(bars[0]).toHaveStyle({ width: "100%" });
    expect(bars[1]).toHaveStyle({ width: "33.33333333333333%" });
    expect(screen.getByText("粗心")).toBeInTheDocument();
    // 薄弱标签云
    expect(screen.getByText("计算类")).toBeInTheDocument();
    // 趋势 8 桶
    expect(screen.getAllByTestId("trend-col")).toHaveLength(8);
  });

  it("待重练清单 + 已订正：item 题 POST /api/attempts；试卷题 PUT confirm；订正后刷新", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/stats")) return jsonResponse({ ...OVERVIEW, pendingList: OVERVIEW.pendingList.slice(1) });
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return jsonResponse({ id: "x" });
    };
    render(<StatsView childId="c1" onToast={vi.fn()} fetchImpl={fetchImpl} />);
    const first = await screen.findByText("例 2 内容");
    expect(first).toBeInTheDocument();
    expect(screen.getByText("未挂题库的试卷题干")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "已订正" })[0]);
    await waitFor(() => expect(calls).toContainEqual(
      { method: "POST", url: "/api/attempts", body: { child_id: "c1", item_id: "i1", result: "correct" } }));
    await waitFor(() => expect(screen.queryByText("例 2 内容")).toBeNull()); // 刷新后少一条
    fireEvent.click(screen.getAllByRole("button", { name: "已订正" })[0]);
    await waitFor(() => expect(calls).toContainEqual({ method: "PUT", url: "/api/paper-questions/pq1/confirm", body: { result: "correct" } }));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/views/StatsView.test.tsx`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现（StatsView.tsx）**

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  fetchStatsOverview, recordCorrection, type PendingEntry, type StatsOverview,
} from "../api/stats";

const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);
const pp = (d: number | null) =>
  d === null ? "" : `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}pp`;

/** 统计页：Hero 四卡 + 错因条形 + 薄弱标签云 + 近 8 周柱状 + 待重练清单（已订正）。 */
export function StatsView({ childId, onToast, fetchImpl = fetch }: {
  childId: string | null;
  onToast?: (text: string) => void;
  fetchImpl?: typeof fetch;
}) {
  const [data, setData] = useState<StatsOverview | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!childId) return;
    setError("");
    try { setData(await fetchStatsOverview(childId, fetchImpl)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [childId, fetchImpl]);
  useEffect(() => { void load(); }, [load]);

  const correct = async (entry: PendingEntry) => {
    if (!childId || busyId) return;
    setBusyId(entry.id);
    try {
      await recordCorrection(entry, childId, fetchImpl);
      onToast?.("已记录订正");
      await load();
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : "记录失败");
    } finally {
      setBusyId(null);
    }
  };

  if (!childId) {
    return <div className="stats-empty chat-empty">还没有孩子档案——先在复核页上传试卷时添加孩子。</div>;
  }
  if (error) return <div className="form-error" role="alert">{error}</div>;
  if (!data) return <div className="chat-empty">加载中…</div>;

  const maxCause = Math.max(1, ...data.causes.map((c) => c.count));
  const maxTag = Math.max(1, ...data.weakTags.map((t) => t.count));
  const maxTrend = Math.max(1, ...data.trend.map((w) => w.total));

  return (
    <div className="stats">
      <div className="hero-cards">
        <div className="hero-card" data-k="week-wrong">
          <div className="num">{data.hero.weekWrong}</div>
          <div className="lbl">本周错题</div>
        </div>
        <div className="hero-card" data-k="rate">
          <div className="num">{pct(data.hero.weekRate)}</div>
          <div className="lbl">本周正确率 {pp(data.hero.rateDelta) && <span className={(
            data.hero.rateDelta ?? 0) >= 0 ? "up" : "down"}>{pp(data.hero.rateDelta)}</span>}</div>
        </div>
        <div className="hero-card" data-k="corrected">
          <div className="num">{data.hero.corrected}</div>
          <div className="lbl">已订正</div>
        </div>
        <div className="hero-card" data-k="pending">
          <div className="num">{data.hero.pending}</div>
          <div className="lbl">待重练</div>
        </div>
      </div>

      <div className="stats-grid">
        <section className="panel">
          <h3>错因分布 <span className="sub">近 30 天</span></h3>
          {data.causes.length === 0 && <div className="hint">近 30 天没有错题</div>}
          <div className="bars">
            {data.causes.map((c) => (
              <div key={c.cause} className="bar-row">
                <span className="bar-label">{c.cause}</span>
                <div className="bar-track">
                  <div data-testid="cause-bar" className="bar-fill"
                       style={{ width: `${(c.count / maxCause) * 100}%` }} />
                </div>
                <span className="bar-num">{c.count}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <h3>薄弱知识点 <span className="sub">待重练的题</span></h3>
          {data.weakTags.length === 0 && <div className="hint">暂无薄弱知识点</div>}
          <div className="tag-cloud">
            {data.weakTags.map((t) => (
              <span key={t.tag} className="tag" style={{ fontSize: `${12 + (t.count / maxTag) * 10}px`, opacity: 0.65 + (t.count / maxTag) * 0.35 }}>
                {t.tag}<sub>{t.count}</sub>
              </span>
            ))}
          </div>
        </section>

        <section className="panel">
          <h3>正确率趋势 <span className="sub">近 8 周</span></h3>
          <div className="trend">
            {data.trend.map((w) => (
              <div key={w.weekStart} data-testid="trend-col" className="trend-col"
                   title={`${w.weekStart} · ${w.total} 次 · ${pct(w.rate)}`}>
                <div className="trend-bar" style={{ height: `${(w.total / maxTrend) * 100}%` }} />
                <span className="trend-rate">{pct(w.rate)}</span>
                <span className="trend-week">{w.weekStart.slice(5)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <h3>待重练清单 <span className="sub">{data.pendingList.length} 题</span></h3>
          {data.pendingList.length === 0 && <div className="hint">没有待重练的题</div>}
          <div className="pending-list">
            {data.pendingList.map((p) => (
              <div key={p.id} className="pending-card">
                <div className="pc-content">{p.content}</div>
                <div className="pc-meta">
                  <span className="src">{p.source}</span>
                  {p.errorCause && <span className="badge">{p.errorCause}</span>}
                  <button className="primary" disabled={busyId === p.id}
                          onClick={() => void correct(p)}>已订正</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
```

`theme.css` 追加：

```css
/* ---- 3-C3 统计/用量 ---- */
.stats, .usage { display: flex; flex-direction: column; gap: 14px; overflow-y: auto; padding: 2px 4px 16px; }
.hero-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.hero-card { border: 1px solid var(--line); border-radius: 12px; background: var(--card);
  padding: 14px 16px; box-shadow: 0 1px 3px rgba(43,43,38,.06); }
.hero-card .num { font-family: var(--serif); font-size: 30px; font-weight: 700; line-height: 1.1; }
.hero-card .lbl { font-size: 12px; color: var(--pencil); margin-top: 2px; }
.hero-card .lbl .up { color: #2f7d4f; font-family: var(--mono); font-size: 11px; }
.hero-card .lbl .down { color: var(--redpen); font-family: var(--mono); font-size: 11px; }
.stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.stats-grid .panel:nth-child(3), .stats-grid .panel:nth-child(4) { grid-column: 1 / -1; }
.panel { border: 1px solid var(--line); border-radius: 12px; background: var(--card); padding: 12px 14px; }
.panel h3 { margin: 0 0 10px; font-size: 14px; font-family: var(--serif); }
.panel .sub { font-size: 11.5px; color: var(--pencil); font-weight: 400; margin-left: 6px; }
.panel .hint { color: var(--pencil); font-size: 12.5px; }
.bars { display: flex; flex-direction: column; gap: 6px; }
.bar-row { display: grid; grid-template-columns: 64px 1fr 28px; gap: 8px; align-items: center; }
.bar-label { font-size: 12.5px; text-align: right; }
.bar-track { height: 14px; border-radius: 7px; background: rgba(43,43,38,.07); overflow: hidden; }
.bar-fill { height: 100%; border-radius: 7px; background: var(--redpen); opacity: .8; }
.bar-num { font-size: 12px; color: var(--pencil); font-family: var(--mono); }
.tag-cloud { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: baseline; }
.tag-cloud .tag { color: var(--ink); }
.tag-cloud sub { font-size: 10px; color: var(--pencil); margin-left: 1px; }
.trend { display: flex; gap: 8px; align-items: flex-end; height: 120px; }
.trend-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; height: 100%; justify-content: flex-end; }
.trend-bar { width: 70%; max-width: 34px; background: var(--ink); opacity: .78;
  border-radius: 4px 4px 0 0; min-height: 2px; }
.trend-rate { font-size: 10px; color: var(--pencil); font-family: var(--mono); }
.trend-week { font-size: 10px; color: var(--pencil); font-family: var(--mono); }
.pending-list { display: flex; flex-direction: column; gap: 8px; }
.pending-card { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.pc-content { font-size: 13.5px; }
.pc-meta { display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
.pc-meta .src { font-size: 12px; color: var(--pencil); }
.pc-meta .primary { margin-left: auto; align-self: auto; }
.usage .usage-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.usage .usage-table th, .usage .usage-table td { border-bottom: 1px solid var(--line);
  padding: 6px 8px; text-align: left; }
.usage .usage-table th { color: var(--pencil); font-weight: 400; font-size: 11.5px; }
.usage .usage-table td.num, .usage .usage-table th.num { text-align: right; font-family: var(--mono); }
.usage .modality-tag { font-size: 11px; border-radius: 999px; padding: 1px 8px;
  border: 1px solid var(--line); color: var(--pencil); }
.usage .modality-tag.image { border-color: #8a6d3b; color: #8a6d3b; }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/views/StatsView.test.tsx`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/StatsView.tsx frontend/src/views/StatsView.test.tsx frontend/src/theme.css
git commit -m "feat(frontend): StatsView——Hero/错因/薄弱点/趋势/待重练（已订正）"
```

---

### Task 5: 前端 UsageView——Hero/按用途/按模型/流水

**Files:**

- Create: `frontend/src/views/UsageView.tsx`
- Create: `frontend/src/views/UsageView.test.tsx`

- [ ] **Step 1: 写失败测试（UsageView.test.tsx）**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { UsageView } from "./UsageView";

const OVERVIEW = {
  hero: { promptTokens: 370, completionTokens: 195, totalTokens: 565, calls: 4, textTokens: 265, imageTokens: 300 },
  byPurpose: [{ purpose: "chat", calls: 2, tokens: 250 }, { purpose: "vlm", calls: 1, tokens: 300 }],
  byModel: [{ model: "qwen3.5:4b", calls: 2, tokens: 250 }],
  recent: [
    { id: "1", created_at: "2026-09-05T01:00:00Z", purpose: "chat", model: "qwen3.5:4b", modality: "text", prompt_tokens: 100, completion_tokens: 50 },
    { id: "2", created_at: "2026-09-05T02:00:00Z", purpose: "vlm", model: "qwen3.8-27b", modality: "image", prompt_tokens: 200, completion_tokens: 100 },
  ],
};

describe("UsageView", () => {
  it("Hero 数字、分列表、聚合条、流水表（模态标签）", async () => {
    render(<UsageView fetchImpl={fetchRouter({
      "/api/usage/overview": () => jsonResponse(OVERVIEW),
    })} />);
    expect(await screen.findByText("565")).toBeInTheDocument(); // token 总量
    expect(screen.getByText("4")).toBeInTheDocument(); // 调用次数
    expect(screen.getByText(/文本 265/)).toBeInTheDocument();
    expect(screen.getByText(/图像 300/)).toBeInTheDocument();
    expect(screen.getByText("chat")).toBeInTheDocument();
    expect(screen.getByText("qwen3.5:4b")).toBeInTheDocument();
    expect(screen.getByText("qwen3.8-27b")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // 表头 + 2 行
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/views/UsageView.test.tsx`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现（UsageView.tsx）**

```tsx
import { useEffect, useState } from "react";
import { fetchUsageOverview, type UsageOverview } from "../api/stats";

const fmt = (n: number) => n.toLocaleString("zh-CN");

/** 用量页：本月 token 总量/文本图像分列/调用次数 + 按用途/按模型聚合 + 最近 50 条流水。 */
export function UsageView({ fetchImpl = fetch }: { fetchImpl?: typeof fetch }) {
  const [data, setData] = useState<UsageOverview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchUsageOverview(fetchImpl).then(setData).catch((e) =>
      setError(e instanceof Error ? e.message : String(e)));
  }, [fetchImpl]);

  if (error) return <div className="usage"><div className="form-error" role="alert">{error}</div></div>;
  if (!data) return <div className="usage"><div className="chat-empty">加载中…</div></div>;
  const maxPurpose = Math.max(1, ...data.byPurpose.map((x) => x.tokens));
  const maxModel = Math.max(1, ...data.byModel.map((x) => x.tokens));

  return (
    <div className="usage">
      <div className="hero-cards">
        <div className="hero-card">
          <div className="num">{fmt(data.hero.totalTokens)}</div>
          <div className="lbl">本月 token 总量</div>
        </div>
        <div className="hero-card">
          <div className="num">{fmt(data.hero.textTokens)}</div>
          <div className="lbl">文本 token</div>
        </div>
        <div className="hero-card">
          <div className="num">{fmt(data.hero.imageTokens)}</div>
          <div className="lbl">图像 token</div>
        </div>
        <div className="hero-card">
          <div className="num">{fmt(data.hero.calls)}</div>
          <div className="lbl">本月调用次数</div>
        </div>
      </div>
      <div className="stats-grid">
        <section className="panel">
          <h3>按用途 <span className="sub">本月</span></h3>
          <div className="bars">
            {data.byPurpose.map((x) => (
              <div key={x.purpose} className="bar-row">
                <span className="bar-label">{x.purpose}</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${(x.tokens / maxPurpose) * 100}%` }} />
                </div>
                <span className="bar-num">{fmt(x.tokens)}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <h3>按模型 <span className="sub">本月</span></h3>
          <div className="bars">
            {data.byModel.map((x) => (
              <div key={x.model} className="bar-row">
                <span className="bar-label" title={x.model}>{x.model.length > 10 ? x.model.slice(0, 10) + "…" : x.model}</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${(x.tokens / maxModel) * 100}%` }} />
                </div>
                <span className="bar-num">{fmt(x.tokens)}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="panel" style={{ gridColumn: "1 / -1" }}>
          <h3>最近调用 <span className="sub">最新 50 条</span></h3>
          <table className="usage-table">
            <thead>
              <tr><th>时间</th><th>用途</th><th>模型</th><th>模态</th><th className="num">输入</th><th className="num">输出</th></tr>
            </thead>
            <tbody>
              {data.recent.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.created_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                  <td>{r.purpose}</td>
                  <td>{r.model}</td>
                  <td><span className={`modality-tag ${r.modality}`}>{r.modality === "image" ? "图像" : "文本"}</span></td>
                  <td className="num">{fmt(r.prompt_tokens)}</td>
                  <td className="num">{fmt(r.completion_tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/views/UsageView.test.tsx`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/UsageView.tsx frontend/src/views/UsageView.test.tsx
git commit -m "feat(frontend): UsageView——本月聚合与调用流水"
```

---

### Task 6: App/Rail 接线——四视图 + 孩子切换接真数据

**Files:**

- Modify: `frontend/src/components/Rail.tsx`、`frontend/src/App.tsx`
- Test: `frontend/src/App.test.tsx`（追加用例）

- [ ] **Step 1: 写失败测试（App.test.tsx 追加）**

```tsx
describe("App 视图与孩子接线", () => {
  it("Rail 统计/用量可点；统计页随孩子加载；顶栏孩子切换为真数据", async () => {
    stubFetch({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([]),
      "/api/children": () => jsonResponse({ children: [
        { id: "c1", name: "小宝", grade: "四年级" },
        { id: "c2", name: "朵朵", grade: "二年级" },
      ] }),
      "/api/stats/overview?child_id=c1": () => jsonResponse({
        hero: { weekWrong: 0, weekTotal: 0, weekRate: null, lastWeekRate: null, rateDelta: null, corrected: 0, pending: 0 },
        causes: [], weakTags: [], trend: [], pendingList: [],
      }),
      "/api/stats/overview?child_id=c2": () => jsonResponse({
        hero: { weekWrong: 7, weekTotal: 0, weekRate: null, lastWeekRate: null, rateDelta: null, corrected: 0, pending: 7 },
        causes: [], weakTags: [], trend: [], pendingList: [],
      }),
    });
    render(<App />);
    // Rail：统计/用量可点
    await fireEvent.click(screen.getByRole("button", { name: "统计" }));
    await waitFor(() => expect(screen.getByText("本周错题")).toBeInTheDocument());
    // 默认选中第一个孩子
    expect(screen.getByText("0", { selector: ".hero-card[data-k=week-wrong] .num" })).toBeInTheDocument();
    // 顶栏孩子切换（统计视图也渲染 kid-switch）
    await fireEvent.click(screen.getByRole("button", { name: "朵朵" }));
    await waitFor(() => expect(screen.getByText("7", { selector: ".hero-card[data-k=week-wrong] .num" })).toBeInTheDocument());
    // Rail 底部 chip 显示当前孩子
    expect(screen.getByText(/朵朵 · 二年级/)).toBeInTheDocument();
    // 用量视图
    stubFetch({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([]),
      "/api/children": () => jsonResponse({ children: [{ id: "c1", name: "小宝", grade: "四年级" }] }),
      "/api/usage/overview": () => jsonResponse({
        hero: { promptTokens: 1, completionTokens: 1, totalTokens: 2, calls: 1, textTokens: 2, imageTokens: 0 },
        byPurpose: [], byModel: [], recent: [],
      }),
    });
    render(<App />);
    await fireEvent.click(screen.getByRole("button", { name: "用量" }));
    await waitFor(() => expect(screen.getByText("本月 token 总量")).toBeInTheDocument());
  });
});
```

（既有 App 用例的 fetchRouter 需补 `"/api/children": () => jsonResponse({ children: [] })` 桩，避免 404 噪音。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/App.test.tsx`
Expected: FAIL——「统计」按钮 disabled（getByRole 点不到）。

- [ ] **Step 3: 实现**

`Rail.tsx` 整体替换：

```tsx
interface RailProps {
  activeView: "chat" | "review" | "stats" | "usage";
  onSelect: (view: "chat" | "review" | "stats" | "usage") => void;
  kidChip?: string;
}

export function Rail({ activeView, onSelect, kidChip }: RailProps) {
  const nav = (view: RailProps["activeView"], label: string) => (
    <button className={activeView === view ? "active" : ""} onClick={() => onSelect(view)}>
      <span className="dot"></span>
      <span className="txt">{label}</span>
    </button>
  );
  return (
    <nav className="rail">
      <div className="brand">
        <span className="logo">
          知
          <svg viewBox="0 0 48 48">
            <path
              d="M8 24 C8 12, 40 10, 41 23 C42 36, 12 40, 8 27"
              fill="none" stroke="#E03C28" strokeWidth="2.2" strokeLinecap="round" opacity=".9"
            />
          </svg>
        </span>
        <span>
          <div className="name">作业本</div>
          <div className="sub">家庭学习知识库</div>
        </span>
      </div>
      <div className="nav">
        {nav("chat", "聊天")}
        {nav("review", "复核")}
        {nav("stats", "统计")}
        <button disabled>
          <span className="dot"></span>
          <span className="txt">资料库</span>
          <span className="todo">待建设</span>
        </button>
        <div className="sep">系统</div>
        {nav("usage", "用量")}
      </div>
      <div className="rail-foot">
        <span className="kid-chip">{kidChip ?? "未选择孩子"}</span>
      </div>
    </nav>
  );
}
```

`App.tsx` 改造（在 3-C1 完成后的版本基础上；若 3-C1 未执行，按当前 main 版本同构修改）：

```tsx
type View = "chat" | "review" | "stats" | "usage";

export function App() {
  const [view, setView] = useState<View>("chat");
  const [children, setChildren] = useState<{ id: string; name: string; grade: string | null }[]>([]);
  const [childId, setChildId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const chat = useChat();

  useEffect(() => {
    fetch("/api/children").then((r) => r.json())
      .then((d: { children?: { id: string; name: string; grade: string | null }[] }) => {
        const list = Array.isArray(d?.children) ? d.children : [];
        setChildren(list);
        setChildId((cur) => cur ?? list[0]?.id ?? null);
      }).catch(() => {});
  }, []);

  const selectedChild = children.find((c) => c.id === childId) ?? null;
  // …toast/confirmDelete/copyAll 等 3-C1 逻辑保持不变…

  const titles: Record<View, string> = { chat: "聊天", review: "复核", stats: "统计", usage: "用量" };

  return (
    <div className="app">
      <Rail activeView={view} onSelect={setView}
            kidChip={selectedChild ? `${selectedChild.name} · ${selectedChild.grade ?? ""}` : undefined} />
      {view === "chat" && (/* SessionsSidebar 同 3-C1 */)}
      <main>
        <div className="topbar">
          <div>
            <span className="date">{today()}</span>
            <h1>{titles[view]}</h1>
          </div>
          {view === "chat" ? (
            <>
              <span className="hint">问孩子学习情况，或找题、看讲解</span>
              {chat.activeSessionId && <button className="ghost" onClick={() => void copyAll()}>复制全文</button>}
              <ModelPicker models={chat.models} value={chat.model} onChange={chat.selectModel} />
              {children.length > 0 && (
                <div className="kid-switch">
                  {children.map((k) => (
                    <button key={k.id} className={childId === k.id ? "on" : ""} onClick={() => setChildId(k.id)}>
                      {k.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : view === "stats" ? (
            <>
              <span className="hint">错题、错因与订正</span>
              {children.length > 0 && (
                <div className="kid-switch">
                  {children.map((k) => (
                    <button key={k.id} className={childId === k.id ? "on" : ""} onClick={() => setChildId(k.id)}>
                      {k.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : view === "review" ? (
            <span className="hint">确认试卷对错与题库匹配</span>
          ) : (
            <span className="hint">模型 token 消耗与调用流水</span>
          )}
        </div>
        {view === "chat" ? <ChatView /* 同 3-C1 props */ /> : null}
        {view === "review" ? <ReviewView /> : null}
        {view === "stats" ? <StatsView childId={childId} onToast={showToast} /> : null}
        {view === "usage" ? <UsageView /> : null}
      </main>
      {/* toast / ConfirmDialog 同 3-C1 */}
    </div>
  );
}
```

（import 区补 `import { StatsView } from "./views/StatsView"; import { UsageView } from "./views/UsageView";`；`kid` 旧 state 与写死的 `["小宝","朵朵"]` 删除。）

- [ ] **Step 4: 跑前端全量确认通过**

Run: `cd frontend && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Rail.tsx frontend/src/App.tsx frontend/src/App.test.tsx
git commit -m "feat(frontend): 统计/用量转正 + 顶栏孩子切换接 GET /api/children"
```

---

### Task 7: E2E——统计用量（断言到 SQL 直查字段级一致）

**Files:**

- Create: `e2e/specs/stats-usage.spec.ts`

- [ ] **Step 1: 写 spec（种子时间锚 date_trunc，期望值由 spec 内 SQL 直查计算）**

```typescript
import pg from "pg";
import { expect, test } from "@playwright/test";

/** 3-C3 统计/用量全链路：种子（children/items/papers/attempts/llm_calls，时间锚周/月边界）
    → UI 数字与 SQL 直查逐字段一致 → 已订正写回（attempts 追加 / confirm upsert）。
    真实栈（三服务 + PostgreSQL）。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";

const pool = new pg.Pool({ connectionString: DB_URL });

test.describe.configure({ mode: "serial" });

let childId = "";
let itemId = "";

test.beforeAll(async () => {
  // 孩子 + 文档 + 条目 + 试卷两题（一匹配一未匹配）
  childId = (await pool.query(
    `INSERT INTO children (name, grade) VALUES ($1,'四年级') RETURNING id::text`, [`E2E宝${RUN}`])).rows[0].id;
  const docId = (await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path) VALUES ($1,'数学','workbook',$2) RETURNING id::text`,
    [`E2E${RUN}口算书`, `/tmp/e2e-${RUN}.pdf`])).rows[0].id;
  itemId = (await pool.query(
    `INSERT INTO items (document_id, content_type, label, content_md, taxonomy, tags)
     VALUES ($1,'exercise','例 1',$2,'计算类',ARRAY['口算']) RETURNING id::text`,
    [docId, `E2E${RUN} 24+37=61`])).rows[0].id;
  const paperId = (await pool.query(
    `INSERT INTO papers (child_id, title, subject, page_count, status) VALUES ($1,$2,'数学',1,'done') RETURNING id::text`,
    [childId, `E2E${RUN}期中卷`])).rows[0].id;
  const pqMatched = (await pool.query(
    `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md, matched_item_id)
     VALUES ($1,1,1,$2,$3) RETURNING id::text`,
    [paperId, `E2E${RUN} 被匹配题干`, itemId])).rows[0].id;
  const pqFree = (await pool.query(
    `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md)
     VALUES ($1,1,2,$2) RETURNING id::text`,
    [paperId, `E2E${RUN} 未挂题库题干`])).rows[0].id;

  // attempts（周口径锚 date_trunc('week')）：
  // 本周：item-correct、pqMatched-partial；上周：pqFree-wrong；两周前：item-wrong（→ 已订正）
  const wk = "date_trunc('week', now())";
  await pool.query(
    `INSERT INTO attempts (child_id, item_id, result, error_cause, created_at)
     VALUES ($1,$2,'wrong','方法不会', ${wk} - interval '13 days')`, [childId, itemId]);
  await pool.query(
    `INSERT INTO attempts (child_id, item_id, result, created_at)
     VALUES ($1,$2,'correct', ${wk} + interval '1 hour')`, [childId, itemId]);
  await pool.query(
    `INSERT INTO attempts (child_id, item_id, paper_question_id, result, error_cause, created_at)
     VALUES ($1,$2,$3,'partial','计算错', ${wk} + interval '2 hours')`, [childId, itemId, pqMatched]);
  await pool.query(
    `INSERT INTO attempts (child_id, paper_question_id, result, error_cause, created_at)
     VALUES ($1,$2,'wrong','粗心', ${wk} - interval '6 days')`, [childId, pqFree]);

  // llm_calls：本月 2 文本 + 1 图像；上月 1 条（只进流水不进聚合）
  const mo = "date_trunc('month', now())";
  await pool.query(
    `INSERT INTO llm_calls (purpose, model, modality, prompt_tokens, completion_tokens, created_at) VALUES
     ('chat','qwen3.5:4b','text',100,50, ${mo} + interval '1 hour'),
     ('chat','qwen3.5:4b','text',60,40, ${mo} + interval '2 hours'),
     ('vlm','qwen3.8-27b','image',200,100, ${mo} + interval '3 hour'),
     ('chat','qwen3.5:4b','text',999,999, ${mo} - interval '10 days')`);
});

test("t1 统计页数字与 SQL 直查一致；已订正写回", async ({ page }) => {
  // SQL 直查期望值（与 UI 同库同时点）
  const q = async (sql: string) => (await pool.query(sql, [childId])).rows[0];
  const hero = await q(`SELECT
      count(*) FILTER (WHERE created_at >= date_trunc('week', now()) AND result IN ('wrong','partial'))::int AS week_wrong,
      count(*) FILTER (WHERE created_at >= date_trunc('week', now()))::int AS week_total
    FROM attempts WHERE child_id=$1`);
  const pending = await q(`WITH q AS (
      SELECT coalesce(paper_question_id::text, item_id::text) AS qid, result,
             row_number() OVER (PARTITION BY coalesce(paper_question_id::text, item_id::text)
                                ORDER BY created_at DESC, id DESC) AS rn,
             bool_or(result IN ('wrong','partial')) OVER (PARTITION BY coalesce(paper_question_id::text, item_id::text)) AS ever
      FROM attempts WHERE child_id=$1)
    SELECT count(*) FILTER (WHERE rn=1 AND ever AND result IN ('wrong','partial'))::int AS pending,
           count(*) FILTER (WHERE rn=1 AND ever AND result='correct')::int AS corrected FROM q`);

  await page.goto("/");
  await page.getByRole("button", { name: "统计" }).click();
  // Hero：本周错题 / 待重练 / 已订正 与 SQL 一致
  await expect(page.locator(".hero-card[data-k=week-wrong] .num")).toHaveText(String(hero.week_wrong));
  await expect(page.locator(".hero-card[data-k=pending] .num")).toHaveText(String(pending.pending));
  await expect(page.locator(".hero-card[data-k=corrected] .num")).toHaveText(String(pending.corrected));
  // 趋势 8 桶、错因含「方法不会」、薄弱标签含「计算类」
  await expect(page.getByTestId("trend-col")).toHaveCount(8);
  await expect(page.locator(".bar-label").filter({ hasText: "方法不会" })).toBeVisible();
  await expect(page.locator(".tag-cloud .tag").filter({ hasText: "计算类" })).toBeVisible();
  // 待重练清单：两题（pqMatched、pqFree），未挂题库显示试卷题干
  await expect(page.locator(".pending-card")).toHaveCount(pending.pending);
  await expect(page.locator(".pending-card").filter({ hasText: "未挂题库题干" })).toHaveCount(1);

  // 已订正（item 维度的题不在清单——item 最新 correct；点 pqFree 的已订正 → confirm upsert）
  await page.locator(".pending-card").filter({ hasText: "未挂题库题干" })
    .getByRole("button", { name: "已订正" }).click();
  await expect(page.locator(".pending-card")).toHaveCount(pending.pending - 1);
  const after = await q(`SELECT result FROM attempts WHERE paper_question_id=(
    SELECT id FROM paper_questions WHERE content_md LIKE ${"E2E" + RUN + " 未挂题库题干%"})`);
  expect(after.result).toBe("correct"); // confirm 的 upsert 改判为 correct
  // UI 待重练数同步减一
  await expect(page.locator(".hero-card[data-k=pending] .num")).toHaveText(String(pending.pending - 1));
});

test("t2 用量页与 llm_calls 对账", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "用量" }).click();
  // 本月种子固定 3 行：总量 550、文本 250、图像 300（chat 计量行的 purpose 也是 chat——
  // 为避免与三服务真实计量的行混淆，断言用「≥ 种子值」加流水表首行字段校验）
  await expect(page.locator(".hero-card").first().locator(".num")).not.toBeEmpty();
  const text = await page.locator(".hero-card").nth(1).locator(".num").textContent();
  const image = await page.locator(".hero-card").nth(2).locator(".num").textContent();
  expect(Number((text ?? "0").replace(/,/g, ""))).toBeGreaterThanOrEqual(250);
  expect(Number((image ?? "0").replace(/,/g, ""))).toBeGreaterThanOrEqual(300);
  // 流水表有行且字段渲染
  await expect(page.locator(".usage-table tbody tr").first()).toBeVisible();
  await expect(page.locator(".modality-tag.image").first()).toBeVisible();
});

test.afterAll(async () => {
  // 级联清种子（attempts/papers/items/documents 各自级联）
  if (childId) await pool.query("DELETE FROM children WHERE id=$1", [childId]);
  await pool.query(
    "DELETE FROM llm_calls WHERE purpose IN ('vlm') OR (purpose='chat' AND prompt_tokens IN (100, 60, 999))");
  await pool.end();
});
```

（三服务运行产生的真实 chat 计量行会让等值断言不稳定，t2 用「≥ 种子值」的稳健断言 + 模态标签/流水表字段校验；字段级等值由 backend 真库测试（Task 2）钉死。）

- [ ] **Step 2: 跑 E2E 确认通过**

Run: `cd e2e && npx playwright test specs/stats-usage.spec.ts`
Expected: 2 passed。

- [ ] **Step 3: Commit**

```bash
git add e2e/specs/stats-usage.spec.ts
git commit -m "test(e2e): 统计用量——Hero 与 SQL 直查一致/已订正写回/用量对账"
```

---

### Task 8: 文档回写 + 全量回归

**Files:**

- Modify: `README.md`

- [ ] **Step 1: README 补统计与用量章节（「## 检索期」之前或功能列表处，按现有结构插入）**

```markdown
## 统计与用量

- **统计页**：孩子维度的本周错题/正确率（含环比）、错因分布（近 30 天）、薄弱知识点
  （待重练的题挂到的分类/标签）、近 8 周正确率趋势、待重练清单（一键「已订正」）。
  已订正 = 曾错且最新一次 correct；未挂题库的试卷题计入统计并显示试卷题干。
- **用量页**：本月 token 总量（文本/图像分列）、调用次数、按用途/按模型聚合、最近 50 条流水。
  `llm_calls.modality` 为空的历史行计入文本；token 统计不进统计页，两页分离。
```

- [ ] **Step 2: 全量回归（三侧 + E2E 全量）**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
Expected: 全部 PASS。

Run: `cd frontend && npm test`
Expected: 全部 PASS。

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 全部 PASS（本计划 pipeline 零改动，守护无回归）。

Run: `cd e2e && npm test`
Expected: 全部 passed。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: 统计与用量页说明"
```

---

## Self-Review 记录

- **Spec 覆盖**：C1 StatsView 全部块（Hero/错因/薄弱点/趋势/待重练+已订正/口径/API：Task 1、3、4）、C2 UsageView 全部块（Hero/按用途/按模型/流水/口径/API：Task 2、3、5）、孩子选择器接真数据（Task 6）、Rail 转正（Task 6）、e2e（Task 7）——Workstream C 全条目有对应任务。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码；App.tsx 的改造以锚点描述 + 完整新结构给出（3-C1 完成后叠加，若并行执行按当前版本同构修改）。
- **类型一致性**：`StatsOverview`/`UsageOverview`（Task 3）与 Task 1/2 的响应字段逐一对应（hero.weekRate/lastWeekRate/rateDelta 可空、pendingList 五字段）；`recordCorrection` 的双路由分发与 attempts 路由（要求 item_id）和 confirm 路由（body.result）签名一致；Rail 的 `activeView` 联合类型与 App 的 `View` 一致。
- **已知取舍**：趋势补桶用 8 次轻 SQL（`date_trunc` 同口径，免 JS 时区运算）；e2e 用量对账用「≥ 种子值」而非等值（三服务真实计量行干扰），字段级等值由 backend 真库测试钉死；`已订正` 对试卷题经 confirm 改判会覆盖该题 attempt 的 error_cause/note（confirm 既有语义，改判不追加历史）。
