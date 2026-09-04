import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { resetDbForTest } from "../db.js";
import { makeTools, type ToolDeps } from "./tools.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("agent 工具（真库）", () => {
  let pool: pg.Pool;
  let deps: ToolDeps;

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    await pool.query(`
      INSERT INTO children (id, name, grade) VALUES
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '小宝', '四年级');
      INSERT INTO documents (id, title, subject, source_path) VALUES
        ('11111111-1111-1111-1111-111111111111', '7星学霸', '数学', '/tmp/x.pdf');
      INSERT INTO items (id, document_id, content_type, label, content_md, chapter, qc_status) VALUES
        ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
         'example', '例1', '竖式谜例题与解析', '第 1 讲 竖式谜', 'approved');
      INSERT INTO attempts (child_id, item_id, result, error_cause) VALUES
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'wrong', '粗心');
    `);
    deps = {
      pool,
      search: async () => [{
        item_id: "22222222-2222-2222-2222-222222222222",
        document_id: "11111111-1111-1111-1111-111111111111",
        content_md: "竖式谜例题与解析", score: 0.9,
        label: "例1", chapter: "第 1 讲 竖式谜", doc_title: "7星学霸",
      }],
    };
  });
  afterAll(() => pool.end());

  const run = async (d: ToolDeps, name: string, params: Record<string, unknown>) => {
    const tool = makeTools(d).find((t) => t.name === name)!;
    const result = await tool.execute("tc1", params, new AbortController().signal);
    return result.content[0].type === "text" ? result.content[0].text : "";
  };

  it("list_children", async () => {
    const text = await run(deps, "list_children", {});
    expect(text).toContain("小宝");
  });

  it("search_items 走注入的检索并带出处", async () => {
    const text = await run(deps, "search_items", { query: "竖式谜" });
    expect(text).toContain("例1");
    expect(text).toContain("7星学霸");
  });

  it("get_item 返回条目详情", async () => {
    const text = await run(deps, "get_item", { item_id: "22222222-2222-2222-2222-222222222222" });
    expect(text).toContain("竖式谜例题与解析");
  });

  it("get_child_progress 汇总做题记录", async () => {
    const text = await run(deps, "get_child_progress", { child_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    expect(text).toContain("错");
    expect(text).toContain("粗心");
  });

  it("search_items 展示章节命中(未拆条资料)", async () => {
    const chapterDeps: ToolDeps = {
      pool: deps.pool,
      search: async () => [{
        item_id: null, chapter_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        document_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        content_md: "第 1 讲 修辞手法\n比喻句本体是燕子", score: 0.8,
        chapter: "第 1 讲 修辞手法", doc_title: "语法讲义",
      }],
    };
    const text = await run(chapterDeps, "search_items", { query: "比喻" });
    expect(text).toContain("章节");
    expect(text).toContain("第 1 讲 修辞手法");
    expect(text).toContain("语法讲义");
    expect(text).toContain("燕子");
  });
});
