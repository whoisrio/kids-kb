import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

/** 分块修正全链路：合并/拆分/删除保护/调框/补画。真实三服务 + PostgreSQL + rapidocr。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline");
const STORAGE_ROOT = path.resolve(PIPELINE_DIR, "storage");
const TITLE = `E2E-${RUN}-块编辑`;

const pool = new pg.Pool({ connectionString: DB_URL });
test.describe.configure({ mode: "serial" });

let docId = "";
let pageId = "";
let blockA = "";
let blockB = "";
let itemId = "";

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 600, height: 400 } });
  const page = await context.newPage();
  await page.setContent(`<body style="margin:0"><div style="font:32px sans-serif;color:black">
    <div style="height:30px">第一行文字</div>
    <div style="height:30px">第二行文字</div>
    <div style="height:30px">第三行文字</div>
    <div style="height:30px">中文内容</div>
  </div></body>`);
  const image = await page.screenshot();
  await context.close();

  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path, parse_status)
     VALUES ($1,'数学','workbook',$2,'parsed') RETURNING id::text`,
    [TITLE, `/tmp/e2e-${RUN}.pdf`]);
  docId = doc.id;
  const pageDir = path.join(STORAGE_ROOT, docId, "pages");
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(path.join(pageDir, "p0001.png"), image);
  const { rows: [seedPage] } = await pool.query(
    `INSERT INTO pages (document_id, page_no, image_path, parse_status)
     VALUES ($1,1,$2,'parsed') RETURNING id::text`,
    [docId, `${docId}/pages/p0001.png`]);
  pageId = seedPage.id;
  const blocksDir = path.join(STORAGE_ROOT, docId, "blocks");
  mkdirSync(blocksDir, { recursive: true });
  const mkBlock = async (bbox: number[], content: string, ordinal: number) => {
    const cropRel = `${docId}/blocks/b${ordinal}.png`;
    writeFileSync(path.join(STORAGE_ROOT, cropRel), image);
    const { rows: [block] } = await pool.query(
      `INSERT INTO blocks (page_id, block_type, bbox, crop_path, content_md, ordinal)
       VALUES ($1,'text',$2,$3,$4,$5) RETURNING id::text`,
      [pageId, JSON.stringify(bbox), cropRel, content, ordinal]);
    return block.id;
  };
  blockA = await mkBlock([0, 0, 600, 160], "第一行\n第二行\n第三行", 1);
  blockB = await mkBlock([0, 240, 600, 360], "中文内容", 2);
  const { rows: [item] } = await pool.query(
    `INSERT INTO items (document_id, content_type, content_md, qc_status)
     VALUES ($1,'exercise','第一行 第二行 第三行 中文内容','pending') RETURNING id::text`,
    [docId]);
  itemId = item.id;
  await pool.query(
    "INSERT INTO item_blocks (item_id, block_id, role) VALUES ($1,$2,'stem'),($1,$3,'stem')",
    [itemId, blockA, blockB]);
  const vector = `[${"1,".repeat(1023)}1]`;
  await pool.query(
    `INSERT INTO chunks (document_id, item_id, content_md, embedding, source_block_ids)
     VALUES ($1,$2,$3,$4::vector,ARRAY[$5::uuid,$6::uuid])`,
    [docId, itemId, "块编辑检索", vector, blockA, blockB]);
  await pool.query("INSERT INTO review_queue (page_id, reason) VALUES ($1,'块编辑')", [pageId]);
});

async function openPage(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "复核", exact: true }).click();
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await page.getByRole("combobox", { name: "选择文档" }).selectOption(docId);
  await expect(page.locator(".page-card")).toHaveCount(1);
  await page.locator(".page-card").click();
  await expect(page.getByAltText("第 1 页")).toBeVisible();
}

test("t1 合并并拆分，引用重定向且不触发模型", async ({ page }) => {
  await openPage(page);
  await page.getByRole("button", { name: `块 ${blockA}` }).click({ modifiers: ["ControlOrMeta"] });
  await page.getByRole("button", { name: `块 ${blockB}` }).click({ modifiers: ["ControlOrMeta"] });
  await page.getByRole("button", { name: "合并选中块" }).click();
  await expect(page.getByText("合并 2 块成功")).toBeVisible();
  const merged = await pool.query(
    `SELECT id::text, bbox, content_md, ordinal, origin, parent_block_ids
     FROM blocks WHERE page_id=$1 ORDER BY ordinal`, [pageId]);
  expect(merged.rows).toHaveLength(1);
  expect(merged.rows[0]).toMatchObject({
    bbox: [0, 0, 600, 360], ordinal: 1, origin: "merged",
    parent_block_ids: [blockA, blockB],
  });
  const links = await pool.query(
    "SELECT count(*)::int AS n FROM item_blocks WHERE item_id=$1", [itemId]);
  expect(links.rows[0].n).toBe(1);
  const chunks = await pool.query(
    "SELECT state, source_block_ids FROM chunks WHERE item_id=$1", [itemId]);
  expect(chunks.rows[0]).toMatchObject({ state: "stale", source_block_ids: [merged.rows[0].id] });

  const before = await pool.query("SELECT count(*)::int AS n FROM llm_calls");
  await page.getByRole("button", { name: "✎ 编辑" }).click();
  const textarea = page.getByRole("textbox", { name: "编辑转录" });
  await expect(textarea).toHaveValue("第一行\n第二行\n第三行\n\n中文内容");
  await textarea.evaluate((element) => element.setSelectionRange(7, 7));
  await page.getByRole("button", { name: "拆分块" }).click();
  await expect(page.getByText("已按光标行拆分")).toBeVisible();
  const halves = await pool.query(
    `SELECT content_md, bbox, ordinal, origin, parent_block_ids FROM blocks
     WHERE page_id=$1 ORDER BY ordinal`, [pageId]);
  expect(halves.rows.map((row) => row.content_md)).toEqual(["第一行\n第二行", "第三行\n\n中文内容"]);
  expect(halves.rows[0]).toMatchObject({ bbox: [0, 0, 600, 144], origin: "split" });
  const after = await pool.query("SELECT count(*)::int AS n FROM llm_calls");
  expect(after.rows[0].n).toBe(before.rows[0].n);
});

test("t2 删除保护：复核行阻止，解除后删除并置 item needs_review", async ({ page }) => {
  await openPage(page);
  const { rows: [block] } = await pool.query(
    "SELECT id::text FROM blocks WHERE page_id=$1 ORDER BY ordinal LIMIT 1", [pageId]);
  await pool.query("INSERT INTO review_queue (block_id, reason) VALUES ($1,'empty')", [block.id]);
  await page.locator(".blockitem").first().getByRole("button", { name: "删除块" }).click();
  await expect(page.locator(".pd-edit-bar")).toContainText("该块有复核记录");
  await pool.query("DELETE FROM review_queue WHERE block_id=$1", [block.id]);
  await page.locator(".blockitem").first().getByRole("button", { name: "删除块" }).click();
  await expect(page.getByText("块已删除")).toBeVisible();
  const item = await pool.query("SELECT qc_status FROM items WHERE id=$1", [itemId]);
  expect(item.rows[0].qc_status).toBe("needs_review");
});

test("t3 键盘调框走 preview/commit，geometry_revision 增加", async ({ page }) => {
  await openPage(page);
  await page.getByAltText("第 1 页").waitFor();
  const remaining = await pool.query(
    "SELECT id::text FROM blocks WHERE page_id=$1 ORDER BY ordinal LIMIT 1", [pageId]);
  const focusedBox = page.getByRole("button", { name: `块 ${remaining.rows[0].id}` });
  await focusedBox.click();
  expect(await focusedBox.locator(".geometry-handle").count()).toBe(8);
  await focusedBox.press("ArrowRight");
  await expect(focusedBox).toHaveAttribute("style", /left: 0\.166/);
  await page.getByRole("button", { name: "预览新框识别" }).click();
  await expect(page.getByText("重裁 + 重识别中…")).toBeVisible();
  await expect(page.getByText("原文本", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "采用新文本" }).click();
  await expect(page.getByText("已应用调框结果")).toBeVisible();
  const db = await pool.query(
    "SELECT geometry_revision, crop_pad FROM blocks WHERE id=$1", [remaining.rows[0].id]);
  expect(db.rows[0].geometry_revision).toBe(2);
  expect(db.rows[0].crop_pad).toEqual([
    Math.round(0.8 / 25.4 * 200), Math.round(0.5 / 25.4 * 200),
  ]);
  const stale = await pool.query(
    "SELECT state FROM chunks WHERE $1 = ANY(source_block_ids)", [remaining.rows[0].id]);
  expect(stale.rows[0]?.state).toBe("stale");
});

test("t4 补画新框，manual 块入库并可见", async ({ page }) => {
  await openPage(page);
  await page.getByRole("button", { name: "补画新框" }).click();
  const image = page.getByAltText("第 1 页");
  const bounds = await image.boundingBox();
  if (!bounds) throw new Error("页图不可见");
  await page.mouse.move(bounds.x + bounds.width * 0.1, bounds.y + bounds.height * 0.75);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.8);
  // 拖拽未松手时橡皮筋实时呈现
  await expect(page.getByTestId("creating-bbox")).toBeVisible();
  await page.mouse.move(bounds.x + bounds.width * 0.9, bounds.y + bounds.height * 0.9);
  await page.mouse.up();
  await expect(page.getByText("已补画新块")).toBeVisible();
  await expect(page.locator(".bbox.manual")).toBeVisible();
  await expect(page.locator(".bbox-tag.manual-tag")).toBeVisible();
  // 新块在右栏出现并处于选中联动状态
  await expect(page.locator(".blockitem.selected")).toBeVisible();
  const created = await pool.query(
    `SELECT bbox, content_md, origin, crop_path, crop_pad FROM blocks WHERE page_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [pageId]);
  expect(created.rows[0]).toMatchObject({ origin: "manual" });
  expect(created.rows[0].content_md).not.toBeNull();
  expect(created.rows[0].crop_pad).toEqual([Math.round(0.8 / 25.4 * 200), 0]);
  // 画框坐标必须换算成页图自然像素（种子图 600×400，画 10%,75% → 90%,90%）——
  // 识别范围不对就是这里换算错了
  const [x0, y0, x1, y1] = created.rows[0].bbox as number[];
  expect(Math.abs(x0 - 60)).toBeLessThan(8);
  expect(Math.abs(y0 - 300)).toBeLessThan(8);
  expect(Math.abs(x1 - 540)).toBeLessThan(8);
  expect(Math.abs(y1 - 360)).toBeLessThan(8);
});

test("t5 左图选块右栏联动高亮，删除选中块移除补画块", async ({ page }) => {
  await openPage(page);
  // 点左图补画框 → 右栏对应块进入选中态并滚进视口
  await page.locator(".bbox.manual").click();
  const selectedCard = page.locator(".blockitem.selected");
  await expect(selectedCard).toBeVisible();
  await expect(selectedCard).toBeInViewport();
  await expect(selectedCard).toContainText("manual");
  // 删除选中块：右栏卡片与 DB 同步移除
  await page.getByRole("button", { name: "删除选中块" }).click();
  await expect(page.getByText("块已删除")).toBeVisible();
  await expect(page.locator(".bbox.manual")).toHaveCount(0);
  const remaining = await pool.query(
    "SELECT count(*)::int AS n FROM blocks WHERE page_id=$1 AND origin='manual'", [pageId]);
  expect(remaining.rows[0].n).toBe(0);
});

test.afterAll(async () => {
  if (process.env.KEEP_DB) return;
  if (docId) await pool.query("DELETE FROM documents WHERE id=$1", [docId]);
  if (docId) rmSync(path.join(STORAGE_ROOT, docId), { recursive: true, force: true });
  await pool.end();
});
