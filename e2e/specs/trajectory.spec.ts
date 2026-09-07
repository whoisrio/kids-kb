import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline");
const STORAGE_ROOT = path.resolve(PIPELINE_DIR, "storage");
const TITLE = `traj-${RUN}`;
const pool = new pg.Pool({ connectionString: DB_URL });
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let docId: string;
let pageId: string;
let itemId: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  execFileSync("uv", ["run", "python", "-m", "kb.cli", "migrate"], { cwd: PIPELINE_DIR });
  docId = crypto.randomUUID();
  pageId = crypto.randomUUID();
  itemId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO documents (id, title, subject, source_path, parse_status) VALUES ($1,$2,$3,$4,'parsed')",
    [docId, TITLE, "数学", `/tmp/traj-${RUN}.pdf`]);
  const pagesDir = path.join(STORAGE_ROOT, docId, "pages");
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(path.join(pagesDir, "p0001.png"), PNG_1PX);
  await pool.query(
    `INSERT INTO pages (id, document_id, page_no, image_path, parse_status)
     VALUES ($1,$2,1,$3,'parsed')`,
    [pageId, docId, `storage/${docId}/pages/p0001.png`]);
  await pool.query(
    "INSERT INTO review_queue (page_id, reason) VALUES ($1,'trajectory-e2e')", [pageId]);
  await pool.query(
    `INSERT INTO items (id, document_id, content_type, label, content_md, qc_status)
     VALUES ($1,$2,'exercise','1','1+1=?','pending')`,
    [itemId, docId]);

  execFileSync("uv", ["run", "python", "-c", `
from kb.config import load_config
from kb.db import connect
from kb.traj import Recorder
cfg = load_config()
conn = connect(cfg.database_url)
rec = Recorder(conn, cfg, "${docId}")
t = rec.start("parse", "区块转录", page_id="${pageId}")
rec.llm_call("parse", "transcribe qwen3:4b", page_id="${pageId}",
             model="qwen3:4b", usage=(10, 5), prompt="e2e prompt", output="e2e output")
rec.end("parse", "区块转录完成", started=t, page_id="${pageId}")
print(rec.run_id)
`], { cwd: PIPELINE_DIR, env: { ...process.env, KB_TRAJECTORY_LEVEL: "verbose" } });
});

test.afterAll(async () => {
  if (process.env.KEEP_DB) return;
  await pool.query("DELETE FROM documents WHERE id=$1", [docId]);
  rmSync(path.join(STORAGE_ROOT, docId), { recursive: true, force: true });
  await pool.end();
});

test("t1 文档级：处理日志 tab 展示 run 时间线与事件流", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核", exact: true }).click();
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await expect(page.getByRole("option", { name: TITLE })).toBeAttached();
  await page.getByLabel("选择文档").selectOption(docId);
  await page.getByRole("button", { name: "处理日志" }).click();
  const runBtn = page.getByRole("button", { name: /parse · pipeline · 3 事件/ });
  await expect(runBtn).toBeVisible();
  await runBtn.click();
  await expect(page.getByText("transcribe qwen3:4b")).toBeVisible();

  const apiResp = await page.request.get(
    `http://127.0.0.1:8787/api/documents/${docId}/trajectory?level=event`);
  const { events } = await apiResp.json();
  expect(events).toHaveLength(3);
  expect(events[1]).toMatchObject({
    stage: "parse", event_type: "llm_call", model: "qwen3:4b",
    prompt_tokens: 10, completion_tokens: 5, page_id: pageId,
  });
});

test("t2 JSONL 镜像存在且行数与 DB 一致", async () => {
  const { rows } = await pool.query(
    `SELECT run_id::text AS run_id, count(*)::int AS count
     FROM pipeline_events WHERE document_id=$1 GROUP BY run_id`,
    [docId]);
  expect(rows).toHaveLength(1);
  const mirror = path.join(STORAGE_ROOT, docId, "trajectory", `${rows[0].run_id}.jsonl`);
  expect(existsSync(mirror)).toBe(true);
  expect(readFileSync(mirror, "utf8").trim().split("\n")).toHaveLength(rows[0].count);
});

test("t3 用户编辑条目产生 user_edit 事件并在 UI 可见", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核", exact: true }).click();
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await expect(page.getByRole("option", { name: TITLE })).toBeAttached();
  await page.getByLabel("选择文档").selectOption(docId);
  await page.getByRole("button", { name: "条目" }).click();
  await page.getByRole("button", { name: /1\+1=\?/ }).click();
  await page.getByRole("button", { name: /编辑/ }).click();
  await page.getByLabel("编辑条目").fill("1+1=2（人工修正）");
  await page.getByRole("button", { name: "保存" }).click();
  await page.getByRole("button", { name: "← 返回条目" }).click();

  const { rows } = await pool.query(
    `SELECT actor, payload FROM pipeline_events
     WHERE document_id=$1 AND stage='user_edit' AND item_id=$2`,
    [docId, itemId]);
  expect(rows).toHaveLength(1);
  expect(rows[0].actor).toBe("user");
  expect(rows[0].payload).toMatchObject({
    field: "content_md", old: "1+1=?", new: "1+1=2（人工修正）",
  });

  await page.getByRole("button", { name: "处理日志" }).click();
  await expect(page.getByRole("button", { name: /user_edit · user/ })).toBeVisible();
});

test("t4 by 页：页复核的本页日志面板", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核", exact: true }).click();
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await expect(page.getByRole("option", { name: TITLE })).toBeAttached();
  await page.getByLabel("选择文档").selectOption(docId);
  const pageCard = page.locator(".page-card").first();
  await expect(pageCard).toBeVisible();
  await pageCard.click();
  await page.getByRole("button", { name: "本页日志" }).click();
  await expect(page.getByText("transcribe qwen3:4b")).toBeVisible();

  const apiResp = await page.request.get(`http://127.0.0.1:8787/api/pages/${pageId}/trajectory`);
  const { events } = await apiResp.json();
  expect(events.length).toBeGreaterThanOrEqual(3);
  for (const ev of events) expect(ev.page_id).toBe(pageId);
});
