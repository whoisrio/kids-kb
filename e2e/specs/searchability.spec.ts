import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

/** 检索可达性全链路 E2E:md 上传(CLI ingest) -> 入库即章节向量化 -> 聊天检索引用 -> DB 章级 chunk 断言。
    覆盖修复核心:"照工作流走完仍然搜不到"。真实栈(三服务 + ollama bge-m3 + PostgreSQL)。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const TITLE = `E2E-${RUN}-语文语法讲义`;
const KEYWORD = `E2E${RUN}燕子魔法词`;

const pool = new pg.Pool({ connectionTimeoutMillis: 5_000, connectionString: DB_URL });

test("md 入库即向量化,聊天能检索到章节内容", async ({ page }) => {
  // 1) 写 md 并 CLI 入库(不经 structure/approve,验证章节级检索底座)
  const dir = path.join(tmpdir(), `kb-e2e-md-${RUN}`);
  mkdirSync(dir, { recursive: true });
  const md = path.join(dir, "grammar.md");
  writeFileSync(
    md,
    `# 一、修辞手法\n\n${KEYWORD} 出现在比喻句里,本体是燕子。\n\n# 二、标点符号\n\n省略号表示语意未尽。\n`,
    "utf-8",
  );
  execSync(
    `uv run python -m kb.cli ingest "${md}" --title "${TITLE}" --subject 语文 --type workbook`,
    { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline"), stdio: "pipe" },
  );

  // 2) DB:章节级 chunk 已就位(meta.kind=chapter)
  const { rows: [{ n }] } = await pool.query(
    `SELECT count(*)::int AS n FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE d.title = $1 AND c.chapter_id IS NOT NULL AND c.meta->>'kind' = 'chapter'`,
    [TITLE],
  );
  expect(n).toBeGreaterThan(0);

  // 3) UI:聊天问唯一关键词,回复必须引用资料内容(模型必须调 search_items 才知道)
  await page.goto("/");
  await page.getByPlaceholder(/问点什么/).fill(`${KEYWORD} 讲的是什么?请先搜题库再回答。`);
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".msg.user .bubble")).toContainText(KEYWORD);
  await expect(page.locator(".chat-wrap")).toHaveAttribute("data-streaming", "false", {
    timeout: 240_000,
  });
  const replyElement = page.locator(".msg.agent .bubble").last();
  await expect(replyElement).not.toHaveText("");
  const reply = (await replyElement.textContent()) ?? "";
  expect(reply).not.toContain("出错了");
  expect(reply).toContain("燕子");
});

test.afterAll(async () => {
  // documents 级联 chapters/items/chunks;llm_calls.document_id 无 FK,残留可接受(计量流水)
  await pool.query("DELETE FROM documents WHERE title LIKE $1", [`E2E-${RUN}-%`]);
  await pool.end();
});
