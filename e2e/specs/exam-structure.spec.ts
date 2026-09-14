import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

/** 试卷拆题 + 资料库三视图 + chunk 粒度全链路。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline");
const STORAGE_ROOT = path.resolve(PIPELINE_DIR, "storage");

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const EXAM_TITLE = `E2E-${RUN}-期末卷`;
const MD_TITLE = `E2E-${RUN}-长文章`;
const KEYWORD = `E2E${RUN}魔法词`;

const pool = new pg.Pool({ connectionString: DB_URL });

test.describe.configure({ mode: "serial" });

let examDocId = "";
let mdDocId = "";

test.beforeAll(async () => {
  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path, parse_status)
     VALUES ($1,'英语','exam',$2,'parsed') RETURNING id::text`,
    [EXAM_TITLE, `/tmp/e2e-${RUN}-exam.pdf`],
  );
  examDocId = doc.id;
  const pagesDir = path.join(STORAGE_ROOT, examDocId, "pages");
  mkdirSync(pagesDir, { recursive: true });
  for (const [no, md] of [
    [1, `一、选择题\n\n1. ${KEYWORD}: He ___ to school by bus.\nA. go B. goes C. went`],
    [2, "参考答案\n\n1. B"],
  ] as [number, string][]) {
    writeFileSync(path.join(pagesDir, `p${String(no).padStart(4, "0")}.png`), PNG_1PX);
    const { rows: [page] } = await pool.query(
      `INSERT INTO pages (document_id, page_no, image_path, parse_status, adopted_source, page_md)
       VALUES ($1,$2,$3,'parsed','page_md',$4) RETURNING id::text`,
      [examDocId, no, `${examDocId}/pages/p${String(no).padStart(4, "0")}.png`, md],
    );
    if (no === 1) {
      const blocksDir = path.join(STORAGE_ROOT, examDocId, "blocks");
      mkdirSync(blocksDir, { recursive: true });
      writeFileSync(path.join(blocksDir, "b1.png"), PNG_1PX);
      await pool.query(
        `INSERT INTO blocks (page_id, block_type, bbox, crop_path, content_md, ordinal)
         VALUES ($1,'text',$2,$3,$4,1)`,
        [page.id, JSON.stringify([10, 20, 300, 120]),
         `${examDocId}/blocks/b1.png`, `一、选择题 ${KEYWORD}`],
      );
    }
  }
});

test("t1 试卷 structure 自动走拆题：items + 答案配对 + struct_mode", async () => {
  test.setTimeout(300_000);
  execSync(`uv run python -m kb.cli structure ${examDocId}`,
    { cwd: PIPELINE_DIR, encoding: "utf-8" });
  const { rows: items } = await pool.query(
    "SELECT content_type, label, page_start FROM items WHERE document_id=$1", [examDocId],
  );
  expect(items.length).toBeGreaterThanOrEqual(1);
  expect(items.some((item) => item.content_type === "exercise")).toBe(true);
  const { rows: [doc] } = await pool.query(
    "SELECT struct_mode FROM documents WHERE id=$1", [examDocId],
  );
  expect(doc.struct_mode).toBe("toc");
});

test("t2 md 入库 chunk 粒度 ~500 + overlap", async () => {
  test.setTimeout(120_000);
  const paragraph = `${KEYWORD}${"长".repeat(380)}`;
  const md = path.join(PIPELINE_DIR, ".tmp", `e2e-${RUN}.md`);
  mkdirSync(path.dirname(md), { recursive: true });
  writeFileSync(md, `# 长文\n\n${[paragraph, paragraph, paragraph].join("\n\n")}`);
  const out = execSync(
    `uv run python -m kb.cli ingest "${md}" --title "${MD_TITLE}" --subject 语文 --type workbook`,
    { cwd: PIPELINE_DIR, encoding: "utf-8" },
  );
  mdDocId = /document_id=([0-9a-f-]+)/.exec(out)?.[1] ?? "";
  expect(mdDocId).not.toBe("");
  const { rows: chunks } = await pool.query(
    "SELECT content_md FROM chunks WHERE document_id=$1 ORDER BY seg_no", [mdDocId],
  );
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  for (const chunk of chunks) {
    const segment = chunk.content_md.split("\n\n").slice(1).join("\n\n");
    expect(segment.length).toBeLessThanOrEqual(500);
  }
  const firstSegment = chunks[0].content_md.split("\n\n").slice(1).join("\n\n");
  const secondSegment = chunks[1].content_md.split("\n\n").slice(1).join("\n\n");
  expect(secondSegment.startsWith(firstSegment.slice(-50))).toBe(true);
});

test("t3 资料库三视图：全文(默认)/索引账页/OCR 分块", async ({ page }) => {
  await page.goto(`/?view=library&q=${encodeURIComponent(EXAM_TITLE)}`);
  await page.getByRole("button", { name: EXAM_TITLE, exact: true }).click();

  await expect(page.locator(".full-content")).toContainText(KEYWORD);

  await page.getByRole("button", { name: "页面表", exact: true }).click();
  await page.getByRole("button", { name: "查看" }).first().click();
  await expect(page.getByAltText("第 1 页")).toBeVisible();
  // 该页采用整页版，默认落在整页解析路线；切回分块解析才见 bbox 与块列表
  await expect(page.locator(".pd-image .bbox")).toHaveCount(0);
  await page.getByRole("button", { name: /分块解析/ }).click();
  await expect(page.locator(".pd-image .bbox")).toHaveCount(1);
  await expect(page.locator(".blockitem")).toContainText(KEYWORD);
  await page.getByRole("button", { name: "← 返回列表" }).click();

  await page.getByRole("button", { name: "整本入库" }).click();
  await expect(page.getByRole("status")).toContainText(/整本入库完成/);
  await page.getByRole("button", { name: "索引账页", exact: true }).click();
  await expect(page.locator(".chunk-line li").first()).toBeVisible();
  const { rows: chunks } = await pool.query(
    "SELECT count(*)::int AS n FROM chunks WHERE document_id=$1", [examDocId],
  );
  expect(chunks[0].n).toBeGreaterThanOrEqual(1);
});

test.afterAll(async () => {
  if (examDocId) await pool.query("DELETE FROM documents WHERE id=$1", [examDocId]);
  if (mdDocId) await pool.query("DELETE FROM documents WHERE id=$1", [mdDocId]);
  if (examDocId) {
    rmSync(path.join(STORAGE_ROOT, examDocId), { recursive: true, force: true });
  }
  if (mdDocId) {
    rmSync(path.join(STORAGE_ROOT, mdDocId), { recursive: true, force: true });
  }
  await pool.end();
});
