import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

/** 3-C2 资料复核全链路：页图 bbox/块编辑/页通过（flat 页级向量化）/条目 approve 即时可检索/试搜。
    真实栈（三服务 + ollama bge-m3 + PostgreSQL）；种子直插 DB + 落盘页图（不跑 VLM 渲染解析）。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline");
const STORAGE_ROOT = path.resolve(PIPELINE_DIR, "storage");

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const TITLE = `E2E-${RUN}-口算书`;
const FLAT_TITLE = `E2E-${RUN}-学霸卷`;
const KEYWORD = `E2E${RUN}魔法词`;

const pool = new pg.Pool({ connectionString: DB_URL });

test.describe.configure({ mode: "serial" });

let docId = "";
let flatDocId = "";
let blockId = "";
let itemId = "";

test.beforeAll(async () => {
  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path, status)
     VALUES ($1,'数学','workbook',$2,'parsed') RETURNING id::text`,
    [TITLE, `/tmp/e2e-${RUN}-a.pdf`]);
  docId = doc.id;
  const pagesDir = path.join(STORAGE_ROOT, docId, "pages");
  mkdirSync(pagesDir, { recursive: true });
  for (const [no, content] of [[1, `${KEYWORD} 24+37=`], [2, "第二页内容"]] as [number, string][]) {
    writeFileSync(path.join(pagesDir, `p${String(no).padStart(4, "0")}.png`), PNG_1PX);
    const { rows: [page] } = await pool.query(
      `INSERT INTO pages (document_id, page_no, image_path, status)
       VALUES ($1,$2,$3,'parsed') RETURNING id::text`,
      [docId, no, `storage/${docId}/pages/p${String(no).padStart(4, "0")}.png`]);
    if (no === 1) {
      const { rows: [b] } = await pool.query(
        `INSERT INTO blocks (page_id, block_type, bbox, crop_path, content_md)
         VALUES ($1,'text',$2,$3,$4) RETURNING id::text`,
        [page.id, JSON.stringify([10, 20, 300, 120]), `storage/${docId}/blocks/b1.png`, content]);
      blockId = b.id;
      const blocksDir = path.join(STORAGE_ROOT, docId, "blocks");
      mkdirSync(blocksDir, { recursive: true });
      writeFileSync(path.join(blocksDir, "b1.png"), PNG_1PX);
      await pool.query("INSERT INTO review_queue (block_id, reason) VALUES ($1,'empty')", [blockId]);
    }
  }
  const { rows: [item] } = await pool.query(
    `INSERT INTO items (document_id, content_type, label, content_md, chapter, qc_status)
     VALUES ($1,'exercise','例 1',$2,'第 1 讲 进位加','pending') RETURNING id::text`,
    [docId, `${KEYWORD} 24+37=61`]);
  itemId = item.id;
  await pool.query("INSERT INTO item_blocks (item_id, block_id, role) VALUES ($1,$2,'stem')", [itemId, blockId]);

  const { rows: [flatDoc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path, status, struct_mode)
     VALUES ($1,'数学','exam',$2,'parsed','flat') RETURNING id::text`,
    [FLAT_TITLE, `/tmp/e2e-${RUN}-b.pdf`]);
  flatDocId = flatDoc.id;
  const fDir = path.join(STORAGE_ROOT, flatDocId, "pages");
  mkdirSync(fDir, { recursive: true });
  writeFileSync(path.join(fDir, "p0001.png"), PNG_1PX);
  const { rows: [fp] } = await pool.query(
    `INSERT INTO pages (document_id, page_no, image_path, status, adopted_source, page_md)
     VALUES ($1,1,$2,'parsed','page_md',$3) RETURNING id::text`,
    [flatDocId, `storage/${flatDocId}/pages/p0001.png`, `${KEYWORD} 退位减法专项卷`]);
  await pool.query(
    "INSERT INTO chapters (document_id, chapter_no, title, content_md) VALUES ($1,1,$2,$3)",
    [flatDocId, FLAT_TITLE, `${KEYWORD} 退位减法专项卷`]);
});

test("t1 页复核：页卡/页图 bbox/块编辑/整页通过（flat 页级向量化）", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "资料库" }).click();
  await page.getByRole("button", { name: "资料", exact: true }).click();
  const docSelect = page.getByRole("combobox", { name: "选择文档" });
  await expect(docSelect).toContainText(TITLE);
  await docSelect.selectOption(docId);
  await expect(page.locator(".page-card")).toHaveCount(1);
  await expect(page.locator(".page-card .badge")).toContainText("empty");
  await page.locator(".page-card").click();
  await expect(page.getByAltText("第 1 页")).toBeVisible();
  await expect(page.locator(".pd-image .bbox.has-issue")).toHaveCount(1);
  await page.locator(".blockitem.has-issue").getByRole("button", { name: "✎ 编辑" }).click();
  await page.getByRole("textbox", { name: "编辑转录" }).fill(`${KEYWORD} 24+37=61（人工修正）`);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator(".blockitem .bc")).toContainText("人工修正");
  const dbBlock = await pool.query("SELECT content_md FROM blocks WHERE id=$1", [blockId]);
  expect(dbBlock.rows[0].content_md).toContain("人工修正");
  await page.getByRole("button", { name: "✓ 整页通过" }).click();
  await expect(page.getByRole("button", { name: "✓ 整页通过" })).toHaveCount(0);
  await expect(page.locator(".page-card")).toHaveCount(0);
  const rows = await pool.query(
    "SELECT count(*)::int AS n FROM review_queue WHERE block_id=$1 AND status='pending'", [blockId]);
  expect(rows.rows[0].n).toBe(0);

  await page.getByRole("button", { name: "已通过页" }).click();
  await page.getByRole("combobox", { name: "选择文档" }).selectOption(flatDocId);
  await expect(page.locator(".page-card")).toHaveCount(1);
  await page.locator(".page-card").click();
  await page.getByRole("button", { name: "✓ 整页通过" }).click();
  await expect(page.getByRole("button", { name: "✓ 整页通过" })).toHaveCount(0);
  const chunks = await pool.query(
    "SELECT seg_no, meta->>'page_no' AS page_no FROM chunks WHERE document_id=$1", [flatDocId]);
  expect(chunks.rows.map((c) => [c.seg_no, c.page_no])).toEqual([[1001, "1"]]);
});

test("t2 条目 approve 即时可检索 + 试搜", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "资料库" }).click();
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await page.getByRole("combobox", { name: "选择文档" }).selectOption(docId);
  await page.getByRole("button", { name: "条目" }).click();
  await expect(page.locator(".item-row")).toHaveCount(1);
  await page.locator(".item-row").click();
  await expect(page.getByAltText(`块 ${blockId}`)).toBeVisible();
  await page.getByRole("button", { name: "✓ 确认" }).click();
  await expect(page.locator(".item-row")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "✓ 确认" })).toHaveCount(0);
  const db = await pool.query(
    "SELECT qc_status, (SELECT count(*)::int FROM chunks WHERE item_id=i.id) AS chunks FROM items i WHERE i.id=$1",
    [itemId]);
  expect(db.rows[0]).toMatchObject({ qc_status: "approved", chunks: 1 });
  await page.getByRole("button", { name: "试搜" }).click();
  await page.getByPlaceholder(/语义检索/).fill(`${KEYWORD} 24+37`);
  await page.getByRole("button", { name: "检索" }).click();
  await expect(page.locator(".hits li").filter({ hasText: "24+37" }).first()).toBeVisible();
});

test.afterAll(async () => {
  if (process.env.KEEP_DB) return;
  if (docId || flatDocId) {
    await pool.query("DELETE FROM documents WHERE id = ANY($1)", [[docId, flatDocId]]);
  }
  for (const d of [docId, flatDocId]) {
    if (d) rmSync(path.join(STORAGE_ROOT, d), { recursive: true, force: true });
  }
  await pool.end();
});
