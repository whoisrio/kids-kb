import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const TITLE = `E2E-${RUN}-资料库管理`;
const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline");
const pool = new pg.Pool({ connectionString: DB_URL });

let docId = "";
let excludedPageId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path, parse_status, struct_mode)
     VALUES ($1,'数学','exam',$2,'parsed','flat') RETURNING id::text`,
    [TITLE, `/tmp/e2e-library-${RUN}.pdf`],
  );
  docId = doc.id;
  for (const [pageNo, content] of [[1, `第一页 ${RUN}魔法词`], [2, "第二页 口算 24+37="]] as const) {
    const { rows: [page] } = await pool.query(
      `INSERT INTO pages (document_id, page_no, image_path, parse_status, adopted_source, page_md)
       VALUES ($1,$2,'/tmp/x.png','parsed','page_md',$3) RETURNING id::text`,
      [docId, pageNo, content],
    );
    if (pageNo === 1) excludedPageId = page.id;
  }
});

test("library list, detail status, exclusion and DB chunks agree", async ({ page }) => {
  execSync(`uv run python -m kb.cli structure ${docId}`, { cwd: PIPELINE_DIR, encoding: "utf-8" });
  execSync(`uv run python -m kb.cli approve ${docId}`, { cwd: PIPELINE_DIR, encoding: "utf-8" });
  await pool.query(
    `UPDATE pages SET manual_review_status='approved', auto_review_status='passed', index_status='indexed'
     WHERE document_id=$1`, [docId],
  );
  await pool.query(
    `UPDATE chapters SET manual_review_status='approved', auto_review_status='passed', index_status='indexed'
     WHERE document_id=$1`, [docId],
  );

  await page.goto(`/?view=library&index_status=stale`);
  await expect(page.getByRole("heading", { name: "数字书架与资料库" })).toBeVisible();
  // 默认书架视图，先切到明细表格再断言
  await page.getByRole("button", { name: "明细表格" }).click();
  await expect(page.locator(".library-table")).toBeVisible();
  await expect(page.getByText(TITLE)).toHaveCount(0);

  await page.goto(`/?view=library&q=${encodeURIComponent(TITLE)}`);
  await page.getByRole("button", { name: "明细表格" }).click();
  await expect(page.getByText(TITLE)).toBeVisible();
  await expect(page.getByText("2 已索引")).toBeVisible();
  await page.getByRole("button", { name: "查看" }).click();
  await expect(page.getByText("自动 2/2")).toBeVisible();
  await expect(page.getByText("索引 2/2")).toBeVisible();
  await page.getByRole("button", { name: "索引账页" }).click();
  await expect(page.locator(".chunk-line li")).toHaveCount(2);

  await page.getByRole("button", { name: "页面表" }).click();
  await page.getByLabel("排除 第 1 页").click();
  await expect(page.locator("tr.excluded")).toBeVisible();
  await expect(page.getByText("自动 1/2")).toBeVisible();
  await page.getByRole("button", { name: "索引账页" }).click();
  await expect(page.locator(".chunk-line li")).toHaveCount(1);

  const { rows } = await pool.query(
    `SELECT page_no FROM chunks WHERE document_id=$1 ORDER BY page_no`, [docId],
  );
  expect(rows.map((row) => row.page_no)).toEqual([2]);
  const { rows: pageState } = await pool.query(
    `SELECT excluded_from_index, index_status FROM pages WHERE id=$1`, [excludedPageId],
  );
  expect(pageState[0]).toEqual({ excluded_from_index: true, index_status: "not_indexed" });
});

test.afterAll(async () => {
  if (docId) await pool.query("DELETE FROM documents WHERE id=$1", [docId]);
  await pool.end();
});
