import pg from "pg";
import { expect, test } from "@playwright/test";

/** 3-C3 统计/用量全链路：种子 → UI 数字与 SQL 直查逐字段一致 → 已订正写回。
    真实栈（三服务 + PostgreSQL）。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";

const pool = new pg.Pool({ connectionString: DB_URL });

test.describe.configure({ mode: "serial" });

let childId = "";
let itemId = "";
let llmCallIds: string[] = [];

test.beforeAll(async () => {
  await pool.query("DELETE FROM children WHERE name=$1", [`E2E宝${RUN}`]);
  childId = (await pool.query(
    `INSERT INTO children (name, grade) VALUES ($1,'四年级') RETURNING id::text`,
    [`E2E宝${RUN}`],
  )).rows[0].id;
  const docId = (await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path) VALUES ($1,'数学','workbook',$2) RETURNING id::text`,
    [`E2E${RUN}口算书`, `/tmp/e2e-${RUN}.pdf`],
  )).rows[0].id;
  itemId = (await pool.query(
    `INSERT INTO items (document_id, content_type, label, content_md, taxonomy, tags)
     VALUES ($1,'exercise','例 1',$2,'计算类',ARRAY['口算']) RETURNING id::text`,
    [docId, `E2E${RUN} 24+37=61`],
  )).rows[0].id;
  const paperId = (await pool.query(
    `INSERT INTO papers (child_id, title, subject, page_count, status) VALUES ($1,$2,'数学',1,'done') RETURNING id::text`,
    [childId, `E2E${RUN}期中卷`],
  )).rows[0].id;
  const pqMatched = (await pool.query(
    `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md, matched_item_id)
     VALUES ($1,1,1,$2,$3) RETURNING id::text`,
    [paperId, `E2E${RUN} 被匹配题干`, itemId],
  )).rows[0].id;
  const pqFree = (await pool.query(
    `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md)
     VALUES ($1,1,2,$2) RETURNING id::text`,
    [paperId, `E2E${RUN} 未挂题库题干`],
  )).rows[0].id;

  const wk = "date_trunc('week', now())";
  await pool.query(
    `INSERT INTO attempts (child_id, item_id, result, error_cause, created_at)
     VALUES ($1,$2,'wrong','方法不会', ${wk} - interval '13 days')`,
    [childId, itemId],
  );
  await pool.query(
    `INSERT INTO attempts (child_id, item_id, result, created_at)
     VALUES ($1,$2,'correct', ${wk} + interval '1 hour')`,
    [childId, itemId],
  );
  await pool.query(
    `INSERT INTO attempts (child_id, item_id, paper_question_id, result, error_cause, created_at)
     VALUES ($1,$2,$3,'partial','计算错', ${wk} + interval '2 hours')`,
    [childId, itemId, pqMatched],
  );
  await pool.query(
    `INSERT INTO attempts (child_id, paper_question_id, result, error_cause, created_at)
     VALUES ($1,$2,'wrong','粗心', ${wk} - interval '6 days')`,
    [childId, pqFree],
  );

  const month = "date_trunc('month', now())";
  const { rows: llmCalls } = await pool.query(
    `INSERT INTO llm_calls (purpose, model, modality, prompt_tokens, completion_tokens, created_at) VALUES
     ('chat','qwen3.5:4b','text',100,50, ${month} + interval '1 hour'),
     ('chat','qwen3.5:4b','text',60,40, ${month} + interval '2 hours'),
     ('vlm','qwen3.8-27b','image',200,100, ${month} + interval '3 hours'),
     ('chat','qwen3.5:4b','text',999,999, ${month} - interval '10 days') RETURNING id::text`,
  );
  llmCallIds = llmCalls.map((row) => row.id);
});

test("t1 统计页数字与 SQL 直查一致；已订正写回", async ({ page }) => {
  const query = async (sql: string) => (await pool.query(sql, [childId])).rows[0];
  const hero = await query(`SELECT
      count(*) FILTER (WHERE created_at >= date_trunc('week', now()) AND result IN ('wrong','partial'))::int AS week_wrong,
      count(*) FILTER (WHERE created_at >= date_trunc('week', now()))::int AS week_total
    FROM attempts WHERE child_id=$1`);
  const pending = await query(`WITH question AS (
      SELECT coalesce(paper_question_id::text, item_id::text) AS qid, result,
             row_number() OVER (PARTITION BY coalesce(paper_question_id::text, item_id::text)
                                ORDER BY created_at DESC, id DESC) AS rn,
             bool_or(result IN ('wrong','partial')) OVER (PARTITION BY coalesce(paper_question_id::text, item_id::text)) AS ever
      FROM attempts WHERE child_id=$1)
    SELECT count(*) FILTER (WHERE rn=1 AND ever AND result IN ('wrong','partial'))::int AS pending,
           count(*) FILTER (WHERE rn=1 AND ever AND result='correct')::int AS corrected
    FROM question`);

  await page.goto("/");
  await page.getByRole("button", { name: "统计" }).click();
  await page.getByRole("button", { name: `E2E宝${RUN}` }).click();
  await expect(page.locator(".hero-card[data-k=week-wrong] .num")).toHaveText(String(hero.week_wrong));
  await expect(page.locator(".hero-card[data-k=pending] .num")).toHaveText(String(pending.pending));
  await expect(page.locator(".hero-card[data-k=corrected] .num")).toHaveText(String(pending.corrected));
  await expect(page.getByTestId("trend-col")).toHaveCount(8);
  await expect(page.locator(".bar-label").filter({ hasText: "方法不会" })).toBeVisible();
  await expect(page.locator(".tag-cloud .tag").filter({ hasText: "计算类" })).toBeVisible();
  await expect(page.locator(".pending-card")).toHaveCount(pending.pending);
  await expect(page.locator(".pending-card").filter({ hasText: "未挂题库题干" })).toHaveCount(1);

  await page.locator(".pending-card").filter({ hasText: "未挂题库题干" })
    .getByRole("button", { name: "已订正" }).click();
  await expect(page.locator(".pending-card")).toHaveCount(pending.pending - 1);
  const { rows: [after] } = await pool.query(
    `SELECT result FROM attempts WHERE paper_question_id=(
       SELECT id FROM paper_questions WHERE content_md=$1
     )`,
    [`E2E${RUN} 未挂题库题干`],
  );
  expect(after.result).toBe("correct");
  await expect(page.locator(".hero-card[data-k=pending] .num")).toHaveText(String(pending.pending - 1));
});

test("t2 用量页与 llm_calls 对账", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "用量" }).click();
  await expect(page.locator(".hero-card").first().locator(".num")).not.toBeEmpty();
  const text = await page.locator(".hero-card").nth(1).locator(".num").textContent();
  const image = await page.locator(".hero-card").nth(2).locator(".num").textContent();
  expect(Number((text ?? "0").replace(/,/g, ""))).toBeGreaterThanOrEqual(250);
  expect(Number((image ?? "0").replace(/,/g, ""))).toBeGreaterThanOrEqual(300);
  await expect(page.locator(".usage-table tbody tr").first()).toBeVisible();
  await expect(page.locator(".modality-tag.image").first()).toBeVisible();
});

test.afterAll(async () => {
  if (childId) await pool.query("DELETE FROM children WHERE id=$1", [childId]);
  if (llmCallIds.length > 0) {
    await pool.query("DELETE FROM llm_calls WHERE id = ANY($1::uuid[])", [llmCallIds]);
  }
  await pool.end();
});
