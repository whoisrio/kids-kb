import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

/** flat 入库全链路 E2E:无目录试卷集合(DB 种子) -> structure 自动回退 -> approve 全页向量化
    -> 聊天检索命中页级内容。真实栈(三服务 + ollama bge-m3/聊天模型 + PostgreSQL);
    种子直插 pages/blocks(不跑 VLM 渲染解析),聚焦 flat 链路本身。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const TITLE = `E2E-${RUN}-无目录试卷`;
const KEYWORD = `E2E${RUN}魔法词`; // 只出现在页 1 内容里,模型必须检索才知道
const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline");

const pool = new pg.Pool({ connectionString: DB_URL });

test.describe.configure({ mode: "serial" });

let docId = "";

test.beforeAll(async () => {
  // 1) 种子:1 文档 2 页块文本(无「目录」字样),页 1 带唯一关键词
  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path)
     VALUES ($1,'数学','exam',$2) RETURNING id::text`,
    [TITLE, `/tmp/e2e-flat-${RUN}.pdf`],
  );
  docId = doc.id;
  const pages: Array<[number, Array<[string, string]>]> = [
    [1, [[`${KEYWORD} 15-9= 竖式退位减法`, "text"], ["页眉 学霸提优", "header"]]],
    [2, [["第二套 口算 24+37=", "text"]]],
  ];
  for (const [pageNo, contents] of pages) {
    const { rows: [page] } = await pool.query(
      `INSERT INTO pages (document_id, page_no, image_path, parse_status)
       VALUES ($1,$2,'/tmp/x.png','parsed') RETURNING id::text`,
      [docId, pageNo],
    );
    for (const [content, type] of contents) {
      await pool.query(
        `INSERT INTO blocks (page_id, block_type, crop_path, content_md) VALUES ($1,$2,'/tmp/c.png',$3)`,
        [page.id, type, content],
      );
    }
  }
});

test("structure 自动回退 flat,approve 后页级可检索", async ({ page }) => {
  // 2) structure:无目录 -> 自动 flat(合成 1 章,不拆条,零 LLM)
  const out = execSync(`uv run python -m kb.cli structure ${docId}`,
    { cwd: PIPELINE_DIR, encoding: "utf-8" });
  expect(out).toContain("回退整卷按页模式");
  const { rows: [doc] } = await pool.query(
    `SELECT struct_mode,
            (SELECT count(*)::int FROM chapters WHERE document_id = d.id) AS chapters,
            (SELECT count(*)::int FROM items WHERE document_id = d.id) AS items
     FROM documents d WHERE d.id = $1`, [docId]);
  expect(doc.struct_mode).toBe("flat");
  expect(doc.chapters).toBe(1);
  expect(doc.items).toBe(0);

  // 3) approve:关复核行 + 全页向量化(seg_no 按页对齐,meta 带 page_no)
  const appr = execSync(`uv run python -m kb.cli approve ${docId}`,
    { cwd: PIPELINE_DIR, encoding: "utf-8" });
  expect(appr).toContain("通过 2 页");
  const { rows: chunks } = await pool.query(
    `SELECT seg_no, meta->>'page_no' AS page_no, meta->>'kind' AS kind
     FROM chunks WHERE document_id = $1 ORDER BY seg_no`, [docId]);
  expect(chunks.map((c) => [c.seg_no, c.page_no, c.kind])).toEqual([
    [1001, "1", "chapter"],
    [2001, "2", "chapter"],
  ]);

  // 4) UI:聊天问关键词,回复必须引用资料内容(须调 search_items)
  await page.goto("/");
  await page.getByPlaceholder(/问点什么/).fill(`${KEYWORD} 讲的是什么?请先搜题库再回答。`);
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".chat-wrap")).toHaveAttribute("data-streaming", "false", {
    timeout: 240_000,
  });
  const replyElement = page.locator(".msg.agent .bubble").last();
  await expect(replyElement).not.toHaveText("");
  const reply = (await replyElement.textContent()) ?? "";
  expect(reply).not.toContain("出错了");
  expect(reply).toContain("退位");
});

test.afterAll(async () => {
  // documents 级联 chapters/chunks/review_queue;llm_calls 残留为计量流水,可接受
  if (docId) await pool.query("DELETE FROM documents WHERE id = $1", [docId]);
  await pool.end();
});
