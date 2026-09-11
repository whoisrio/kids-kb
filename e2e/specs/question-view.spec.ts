import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const STORAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline/storage");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const pool = new pg.Pool({ connectionString: DB_URL });

let docId = "";
let pageId = "";
let stemBlockId = "";

test.beforeAll(async () => {
  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path, parse_status)
     VALUES ($1,'数学','workbook',$2,'parsed') RETURNING id::text`,
    [`E2E-${RUN}-题目视图`, `/tmp/e2e-${RUN}.pdf`]);
  docId = doc.id;
  const pageDir = path.join(STORAGE_ROOT, docId, "pages");
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(path.join(pageDir, "p0001.png"), PNG);
  const { rows: [page] } = await pool.query(
    `INSERT INTO pages (document_id, page_no, image_path, parse_status)
     VALUES ($1,1,$2,'parsed') RETURNING id::text`,
    [docId, `${docId}/pages/p0001.png`]);
  pageId = page.id;
  const blocksDir = path.join(STORAGE_ROOT, docId, "blocks");
  mkdirSync(blocksDir, { recursive: true });
  const mkBlock = async (content: string, bbox: number[], ordinal: number) => {
    const cropPath = `${docId}/blocks/qv-${ordinal}.png`;
    writeFileSync(path.join(STORAGE_ROOT, cropPath), PNG);
    const { rows: [block] } = await pool.query(
      `INSERT INTO blocks (page_id, block_type, bbox, crop_path, content_md, ordinal)
       VALUES ($1,'text',$2,$3,$4,$5) RETURNING id::text`,
      [pageId, JSON.stringify(bbox), cropPath, content, ordinal]);
    return block.id;
  };
  stemBlockId = await mkBlock("题干：24+37=61", [10, 10, 300, 80], 1);
  const answerBlockId = await mkBlock("解析：61", [10, 100, 300, 160], 2);
  const { rows: [question] } = await pool.query(
    `INSERT INTO items (document_id, content_type, label, content_md, qc_status)
     VALUES ($1,'exercise','例 1','题干：24+37=61','pending') RETURNING id::text`,
    [docId]);
  const { rows: [answer] } = await pool.query(
    `INSERT INTO items (document_id, content_type, label, content_md, paired_item_id, qc_status)
     VALUES ($1,'answer','例 1','解析：61',$2,'pending') RETURNING id::text`,
    [docId, question.id]);
  await pool.query(
    `INSERT INTO item_blocks (item_id, block_id, role)
     VALUES ($1,$2,'stem'),($3,$4,'solution')`,
    [question.id, stemBlockId, answer.id, answerBlockId]);
  await pool.query("INSERT INTO review_queue (page_id, reason) VALUES ($1,'题目视图')", [pageId]);
});

test.afterAll(async () => {
  if (!process.env.KEEP_DB && docId) {
    await pool.query("DELETE FROM documents WHERE id=$1", [docId]);
    rmSync(path.join(STORAGE_ROOT, docId), { recursive: true, force: true });
  }
  await pool.end();
});

test("题目视图聚合题干与解析；条目标签只在选中块显示", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核", exact: true }).click();
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await page.getByRole("combobox", { name: "选择文档" }).selectOption(docId);
  await expect(page.locator(".page-card")).toHaveCount(1);
  await page.locator(".page-card").click();
  await expect(page.getByAltText("第 1 页")).toBeVisible();

  await expect(page.locator(".bbox-tag.role-stem")).toHaveCount(0);
  await page.getByRole("button", { name: `块 ${stemBlockId}` }).click();
  await expect(page.getByText("#例 1")).toBeVisible();

  await page.getByRole("button", { name: "题目视图" }).click();
  const card = page.locator(".itemcard");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("题目 · 例 1");
  await expect(card).toContainText("题干：24+37=61");
  await expect(card.locator(".question-answer")).toContainText("解析：61");

  const db = await pool.query(
    `SELECT q.content_md, a.content_md AS answer_md, a.paired_item_id
     FROM items q JOIN items a ON a.paired_item_id = q.id
     WHERE q.document_id=$1`, [docId]);
  expect(db.rows[0]).toMatchObject({
    content_md: "题干：24+37=61", answer_md: "解析：61",
    paired_item_id: db.rows[0].paired_item_id,
  });
});
