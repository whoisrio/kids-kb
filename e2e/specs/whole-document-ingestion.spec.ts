import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

/** 整本入库 E2E：UI 触发 -> backend 转发 -> pipeline 批准/向量化 -> PostgreSQL 状态一致。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const TITLE = `E2E-${RUN}-整本入库`;
const pool = new pg.Pool({ connectionString: DB_URL });

let docId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path, parse_status, struct_mode)
     VALUES ($1,'数学','exam',$2,'parsed','flat') RETURNING id::text`,
    [TITLE, `/tmp/e2e-whole-doc-${RUN}.pdf`],
  );
  docId = doc.id;
  for (const [pageNo, content] of [
    [1, `第一页 ${RUN}魔法词`], [2, "第二页 口算 24+37="],
  ] as const) {
    await pool.query(
      `INSERT INTO pages (document_id, page_no, image_path, parse_status, adopted_source, page_md)
       VALUES ($1,$2,'/tmp/x.png','parsed','page_md',$3)`,
      [docId, pageNo, content],
    );
  }
});

test("library UI approves a flat document and indexes every page", async ({ page }) => {
  await page.goto(`/?view=library&q=${encodeURIComponent(TITLE)}`);
  await page.getByRole("button", { name: TITLE, exact: true }).click();
  const approveButton = page.getByRole("button", { name: "整本入库" });
  await expect(approveButton).toBeVisible();
  const approveResponse = page.waitForResponse(
    (response) => response.url().includes(`/api/library/${docId}/approve`),
  );
  await approveButton.click();
  const response = await approveResponse;
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByRole("button", { name: "整本入库" })).toBeVisible({
    timeout: 120_000,
  });

  const pages = await pool.query(
    `SELECT page_no, manual_review_status, index_status
     FROM pages WHERE document_id=$1 ORDER BY page_no`, [docId],
  );
  expect(pages.rows).toEqual([
    { page_no: 1, manual_review_status: "approved", index_status: "indexed" },
    { page_no: 2, manual_review_status: "approved", index_status: "indexed" },
  ]);
  const chunks = await pool.query(
    `SELECT seg_no, meta->>'page_no' AS page_no
     FROM chunks WHERE document_id=$1 ORDER BY seg_no`, [docId],
  );
  expect(chunks.rows).toEqual([
    { seg_no: 1001, page_no: "1" },
    { seg_no: 2001, page_no: "2" },
  ]);
});

test.afterAll(async () => {
  if (docId) await pool.query("DELETE FROM documents WHERE id=$1", [docId]);
  await pool.end();
});
