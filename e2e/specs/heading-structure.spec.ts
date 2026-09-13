import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

/** heading 入库全链路 E2E:无目录文档(DB 种子,块直写 title_level=1,不跑 VLM 渲染解析;
    heading 层级判定本身由 pipeline 单测覆盖) -> structure 走 heading 模式
    (一级标题确定性合成章节 + 与 toc 同路的逐章 LLM 拆条) -> approve 条目级向量化
    -> 聊天检索命中条目内容。真实栈(三服务 + ollama bge-m3/聊天模型 + PostgreSQL)。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const TITLE = `E2E-${RUN}-无目录讲义`;
const KW_A = `E2E${RUN}魔法词A`; // 只出现在第 1 讲(页 1-2),模型必须检索才知道
const KW_B = `E2E${RUN}魔法词B`; // 第 2 讲(页 3-4)
const CH1_TITLE = `第 1 讲 ${KW_A} 竖式加法`;
const CH2_TITLE = `第 2 讲 ${KW_B} 退位减法`;
const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline");
const STORAGE_ROOT = path.resolve(PIPELINE_DIR, "storage");

const pool = new pg.Pool({ connectionString: DB_URL });

test.describe.configure({ mode: "serial" });

let docId = "";

test.beforeAll(async () => {
  // 种子:1 文档 4 页,页 1/3 各一个 title_level=1 标题块(无「目录」字样,不会误判 toc)
  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path, parse_status)
    VALUES ($1,'数学','workbook',$2,'parsed') RETURNING id::text`,
    [TITLE, `/tmp/e2e-heading-${RUN}.pdf`],
  );
  docId = doc.id;
  // [page_no, blocks:[content, block_type, title_level]]
  const pages: Array<[number, Array<[string, string, number | null]>]> = [
    [1, [
      [CH1_TITLE, "title", 1],
      [`例1 ${KW_A}: 23+45= 列竖式,相同数位对齐相加`, "text", null],
    ]],
    [2, [
      ["1. 36+27=", "text", null],
      ["2. 48+35=", "text", null],
    ]],
    [3, [
      [CH2_TITLE, "title", 1],
      [`例1 ${KW_B}: 52-28= 个位不够减,向十位借一当十`, "text", null],
    ]],
    [4, [
      ["1. 61-34=", "text", null],
      ["2. 73-46=", "text", null],
    ]],
  ];
  for (const [pageNo, blocks] of pages) {
    const { rows: [page] } = await pool.query(
      `INSERT INTO pages (document_id, page_no, image_path, parse_status)
       VALUES ($1,$2,'/tmp/x.png','parsed') RETURNING id::text`,
      [docId, pageNo],
    );
    for (const [content, type, level] of blocks) {
      await pool.query(
        `INSERT INTO blocks (page_id, block_type, crop_path, content_md, ordinal, title_level)
         VALUES ($1,$2,'/tmp/c.png',$3,
                 (SELECT coalesce(max(ordinal), 0) + 1 FROM blocks WHERE page_id = $1), $4)`,
        [page.id, type, content, level],
      );
    }
  }
});

test("t1 structure 走 heading 模式:合成 2 章 + 逐章拆条", async () => {
  test.setTimeout(600_000); // 2 章真实 LLM 拆条
  const out = execSync(`uv run python -m kb.cli structure ${docId}`,
    { cwd: PIPELINE_DIR, encoding: "utf-8" });
  expect(out).not.toContain("回退整卷按页模式");
  expect(out).toContain("标题分章: 2 章入库");

  const { rows: [doc] } = await pool.query(
    "SELECT struct_mode FROM documents WHERE id = $1", [docId]);
  expect(doc.struct_mode).toBe("heading");

  // 一级标题确定性合成:chapter_no 顺排,页范围本章起点到下一章前一页,末章到最大页
  const { rows: chapters } = await pool.query(
    `SELECT chapter_no, title, page_start, page_end FROM chapters
     WHERE document_id = $1 ORDER BY chapter_no`, [docId]);
  expect(chapters).toEqual([
    // 合成章剥「第 N 讲」编号前缀（与 toc 同口径,章标签由拆条统一拼「第 N 讲 {title}」）
    { chapter_no: 1, title: `${KW_A} 竖式加法`, page_start: 1, page_end: 2 },
    { chapter_no: 2, title: `${KW_B} 退位减法`, page_start: 3, page_end: 4 },
  ]);

  // LLM 拆条输出不确定:只断言语义字段,不断逐字内容
  const { rows: items } = await pool.query(
    "SELECT chapter, content_md FROM items WHERE document_id = $1", [docId]);
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect(item.chapter).toMatch(/^第 [12] 讲 /);
  }
  expect(items.some((item) => item.content_md.includes(KW_A))).toBe(true);
});

test("t2 approve:条目通过 + 条目级向量化落 chunks", async () => {
  test.setTimeout(300_000);
  const out = execSync(`uv run python -m kb.cli approve ${docId}`,
    { cwd: PIPELINE_DIR, encoding: "utf-8" });
  expect(out).toMatch(/通过 [1-9]\d* 条,新增向量 [1-9]\d* 条/);

  const { rows: [stat] } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM items
        WHERE document_id = $1 AND qc_status = 'approved') AS approved,
       (SELECT count(*)::int FROM chunks
        WHERE document_id = $1 AND item_id IS NOT NULL) AS item_chunks`,
    [docId]);
  expect(stat.approved).toBeGreaterThan(0);
  expect(stat.item_chunks).toBe(stat.approved); // 条目级向量化,一条 item 一条 chunk
});

test("t3 聊天可检索到条目级内容", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder(/问点什么/).fill(
    `${KW_A} 讲的是什么?请先搜题库再回答。检索 query 必须原样使用 "${KW_A}"，不要省略或改写。`,
  );
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".chat-wrap")).toHaveAttribute("data-streaming", "false", {
    timeout: 240_000,
  });
  const replyElement = page.locator(".msg.agent .bubble").last();
  await expect(replyElement).not.toHaveText("");
  const reply = (await replyElement.textContent()) ?? "";
  expect(reply).not.toContain("出错了");
  expect(reply).toContain("竖式");
});

test.afterAll(async () => {
  // documents 级联 chapters/items/chunks/review_queue;llm_calls 残留为计量流水,可接受
  if (docId) {
    await pool.query("DELETE FROM documents WHERE id = $1", [docId]);
    rmSync(path.join(STORAGE_ROOT, docId), { recursive: true, force: true }); // export 落盘镜像
  }
  await pool.end();
});
