import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test, type Page } from "@playwright/test";

/** 试卷管线全链路 E2E:上传(3 图) -> VLM 拆题 -> 匹配 -> 键盘确认 -> attempts 落库。
    前置:e2e/playwright.config.ts 的三服务编排(复用/拉起)+ ollama + 远端 VLM。
    数据写真库 kb(真实计量);测试结束清理种子题库与本次试卷。 */

const RUN = Date.now().toString(36);
const TITLE = `E2E-${RUN}-期中卷`;
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const Q2_TEXT = "135 ÷ 5 =";  // 与种子 item 同文(自动匹配用例)

test.describe.configure({ mode: "serial" });

const pool = new pg.Pool({ connectionString: DB_URL });

let paperId = "";
let childId = "";
let seedDocId = "";
let seedItemId = "";

test.beforeAll(async () => {
  // 1) 生成 3 张合成试卷图(借 pipeline 的 pymupdf)
  const e2eDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const outDir = path.join(tmpdir(), `kb-e2e-paper-${RUN}`);
  execSync(`uv run --project ../pipeline python fixtures/make_paper.py ${outDir}`, { cwd: e2eDir });
  // 2) 种子孩子 + 同文题库 item(bge-m3 embedding 直插 chunks)
  const { rows: [child] } = await pool.query(
    `INSERT INTO children (name, grade) VALUES ($1,'三年级') RETURNING id::text`, [`E2E-${RUN}-小宝`]);
  childId = child.id;
  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path) VALUES ($1,'数学','workbook',$2) RETURNING id::text`,
    [`E2E-${RUN}-数学书`, `/tmp/e2e-${RUN}.pdf`]);
  seedDocId = doc.id;
  const { rows: [item] } = await pool.query(
    `INSERT INTO items (document_id, content_type, label, content_md, qc_status, subject)
     VALUES ($1,'exercise','1',$2,'approved','数学') RETURNING id::text`, [seedDocId, Q2_TEXT]);
  seedItemId = item.id;
  const emb = await (await fetch("http://127.0.0.1:11434/v1/embeddings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "bge-m3", input: Q2_TEXT }),
  })).json() as { data: { embedding: number[] }[] };
  await pool.query(
    `INSERT INTO chunks (item_id, document_id, content_md, meta, embedding) VALUES
      ($1,$2,$3,'{"subject":"数学","label":"1","chapter":null,"doc_title":null}'::jsonb,$4::vector)`,
    [seedItemId, seedDocId, Q2_TEXT, `[${emb.data[0].embedding.join(",")}]`]);
  // 存 outDir 供测试体用
  (globalThis as { __paperDir?: string }).__paperDir = outDir;
});

test.afterAll(async () => {
  // 清理:本次试卷(级联 paper_questions/attempts)+ 种子题库(item 被 attempts 引用,先删 attempts)
  if (paperId) await pool.query("DELETE FROM papers WHERE id=$1", [paperId]);
  if (seedDocId) {
    await pool.query("DELETE FROM attempts WHERE item_id=$1", [seedItemId]);
    await pool.query("DELETE FROM documents WHERE id=$1", [seedDocId]);  // 级联 items/chunks
  }
  await pool.end();
});

function paperDir(): string {
  return (globalThis as { __paperDir?: string }).__paperDir!;
}

async function waitPaperStatus(page: Page, status: string, timeout = 300_000) {
  await expect.poll(async () => {
    const r = await page.request.get(`/api/papers/${paperId}`);
    return r.ok() ? ((await r.json()) as { status: string }).status : "";
  }, { timeout }).toBe(status);
}

test("t1 上传 3 图 -> processing -> ready_for_review,拆题与预识别正确", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核" }).click();
  await page.getByRole("button", { name: "上传试卷" }).click();
  await page.getByLabel("孩子").selectOption({ label: `E2E-${RUN}-小宝` });
  await page.getByLabel("标题").fill(TITLE);
  await page.getByLabel("科目").selectOption("数学");
  const files = readdirSync(paperDir()).filter((f) => f.endsWith(".png")).sort()
    .map((f) => path.join(paperDir(), f));
  await page.getByLabel("文件").setInputFiles(files);
  await page.getByRole("button", { name: "提交" }).click();
  // 列表出现新卷(用队列项定位,避免与详情区《》标题歧义)并选中
  const queueItem = page.getByRole("button", { name: TITLE });
  await expect(queueItem).toBeVisible({ timeout: 30_000 });
  await queueItem.click();
  const detail = (await (await page.request.get(`/api/papers?child_id=${childId}`)).json()) as {
    papers: { id: string; title: string }[];
  };
  paperId = detail.papers.find((p) => p.title === TITLE)!.id;
  await waitPaperStatus(page, "ready_for_review");
  await page.reload();
  await page.getByRole("button", { name: "复核" }).click();
  await page.getByRole("button", { name: TITLE }).click();

  // 拆题:3 题,顺序与识别断言(痕迹识别允许 null 降级,题干必须识别出)
  const detailJson = (await (await page.request.get(`/api/papers/${paperId}`)).json()) as {
    questions: { seq: number; content_md: string; recognized_result: string | null }[];
  };
  expect(detailJson.questions.length).toBe(3);
  expect(detailJson.questions[0].content_md).toContain("246");
  expect(detailJson.questions[1].content_md).toContain("135");
  expect(["wrong", null]).toContain(detailJson.questions[0].recognized_result);
  expect(["correct", null]).toContain(detailJson.questions[1].recognized_result);
  expect(detailJson.questions[2].recognized_result).toBeNull();
  // VLM 计量挂 paper_id
  const meter = await pool.query(
    "SELECT count(*)::int AS n FROM llm_calls WHERE paper_id=$1 AND purpose='paper_vlm' AND modality='image'",
    [paperId]);
  expect(meter.rows[0].n).toBeGreaterThanOrEqual(3);
});

test("t2 自动匹配:同文题已关联(matched_item_id = 种子)", async () => {
  const { rows } = await pool.query(
    `SELECT matched_item_id::text, match_score FROM paper_questions
     WHERE paper_id=$1 AND content_md LIKE '%135%'`, [paperId]);
  expect(rows[0].matched_item_id).toBe(seedItemId);
  expect(rows[0].match_score).toBeGreaterThan(0.88);
});

test("t3 键盘确认 3 题 -> attempts 逐字段 -> done", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核" }).click();
  await page.getByRole("button", { name: TITLE }).click();
  await expect(page.locator(".qnav button")).toHaveCount(3);
  // q1: 错 + 错因(选完错因后点头部区域移开焦点,否则键盘会被输入控件拦截)
  await page.locator('select[aria-label="错因"]').selectOption("计算错");
  await page.locator(".rd-head").click();
  await page.keyboard.press("1");
  await expect(page.locator('.qnav button[data-confirmed="wrong"]').first()).toBeVisible();
  // q2: 对(Enter 采纳预识别 correct;若预识别为 null 则按 2)
  const q2recog = await page.locator(".rd-head .src").textContent();
  await page.keyboard.press(q2recog?.includes("对") && !q2recog.includes("半对") ? "Enter" : "2");
  await expect(page.locator('.qnav button[data-confirmed="correct"]').first()).toBeVisible();
  // q3: 对(无预识别,按 2)
  await page.keyboard.press("2");
  await expect(page.locator('.qnav button[data-confirmed="correct"]')).toHaveCount(2);
  // 状态 done + attempts 逐字段
  await expect.poll(async () =>
    ((await (await page.request.get(`/api/papers/${paperId}`)).json()) as { status: string }).status
  ).toBe("done");
  const { rows: attempts } = await pool.query(
    `SELECT a.result, a.error_cause, a.note, a.item_id::text, a.paper_question_id::text
     FROM attempts a WHERE a.paper_question_id IN
       (SELECT id FROM paper_questions WHERE paper_id=$1)
     ORDER BY a.created_at`, [paperId]);
  expect(attempts).toHaveLength(3);
  expect(attempts[0]).toMatchObject({ result: "wrong", error_cause: "计算错" });
  expect(attempts[1].result).toBe("correct");
  expect(attempts[1].item_id).toBe(seedItemId);  // 自动匹配同步进 attempt
  expect(attempts[2]).toMatchObject({ result: "correct", item_id: null });
  expect(attempts.every((a) => a.paper_question_id)).toBe(true);
});

test("t4 改判 UPDATE 不追加;PATCH 元数据", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核" }).click();
  await page.getByRole("button", { name: TITLE }).click();
  await expect(page.locator(".qnav button")).toHaveCount(3);
  await page.locator(".qnav button").nth(0).click();
  await page.locator('button:has-text("半对")').first().click();
  // 确认后 attempts 的 q1 行更新为 partial(轮询 DB)
  await expect.poll(async () => {
    const { rows } = await pool.query(
      `SELECT array_agg(result ORDER BY created_at) AS results
       FROM attempts WHERE paper_question_id IN (SELECT id FROM paper_questions WHERE paper_id=$1)`,
      [paperId]);
    return rows[0].results as string[];
  }).toContain("partial");
  const { rows: [{ n }] } = await pool.query(
    `SELECT count(*)::int AS n
     FROM attempts WHERE paper_question_id IN (SELECT id FROM paper_questions WHERE paper_id=$1)`,
    [paperId]);
  expect(n).toBe(3);  // 改判没加行
  // 元数据修改
  const r = await page.request.patch(`/api/papers/${paperId}`, {
    data: { title: `${TITLE}-改` },
  });
  expect(r.ok()).toBe(true);
});