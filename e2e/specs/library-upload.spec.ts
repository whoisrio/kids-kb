import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

/** 资料库上传链路：UI 上传 md → 后端建档（pending）→ 自动驱动 pipeline 检测 → 章节落库。
    用 md 是因为它没有 pandoc/版面/OCR 依赖，秒级完成，状态流转可完整观测。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline");
const STORAGE_ROOT = path.resolve(PIPELINE_DIR, "storage");
const TITLE = `E2E-${RUN}-上传检测`;

const pool = new pg.Pool({ connectionString: DB_URL });

let docId = "";

test("上传 md：标题默认取文件名，检测状态流转，章节落库", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "资料库", exact: true }).click();
  await page.getByRole("button", { name: /上传新教辅/ }).click();
  const dialog = page.getByRole("dialog", { name: "上传资料" });
  const md = "# 第一讲 加法\n\n24+37=61。\n\n# 第二讲 减法\n\n61-37=24。\n";
  await dialog.getByLabel("文件").setInputFiles({
    name: `${TITLE}.md`, mimeType: "text/markdown", buffer: Buffer.from(md),
  });
  // 标题未手改时默认取文件名（去扩展名）
  await expect(dialog.getByLabel("标题")).toHaveValue(TITLE);
  await dialog.getByRole("button", { name: "提交" }).click();

  // 卡片以文件名出现在书架上
  await expect(page.getByRole("button", { name: TITLE }).first()).toBeVisible();

  // DB 口径验证状态流转：预插 pending（或已进 parsing/parsed）→ 终态 parsed
  const { rows: [doc] } = await pool.query(
    "SELECT id::text, parse_status FROM documents WHERE title=$1", [TITLE]);
  docId = doc.id;
  expect(["pending", "parsing", "parsed"]).toContain(doc.parse_status);
  await expect.poll(async () => (await pool.query(
    "SELECT parse_status FROM documents WHERE id=$1", [docId])).rows[0].parse_status,
    { timeout: 60_000, intervals: [1_000] }).toBe("parsed");

  // 检测完成后章节落库（md 入库即章节向量化；embed 失败不阻断落库）
  const chapters = await pool.query(
    "SELECT title FROM chapters WHERE document_id=$1 ORDER BY chapter_no", [docId]);
  expect(chapters.rows.map((r) => r.title)).toEqual(["第一讲 加法", "第二讲 减法"]);

  // 前端轮询把终态带回：检测态徽标消失
  await expect(page.getByText(/检测中|待检测|检测失败/)).toHaveCount(0, { timeout: 15_000 });
});

test.afterAll(async () => {
  if (process.env.KEEP_DB) return;
  if (docId) await pool.query("DELETE FROM documents WHERE id=$1", [docId]);
  if (docId) rmSync(path.join(STORAGE_ROOT, docId), { recursive: true, force: true });
  await pool.end();
});
