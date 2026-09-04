import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { resetDbForTest } from "../db.js";
import { hybridSearch, type SearchDeps } from "./search.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("hybridSearch（真库）", () => {
  let pool: pg.Pool;
  // chunks.embedding 是 vector(1024)：假向量必须补齐 1024 维
  const V1 = `[${[1, ...new Array(1023).fill(0)].join(",")}]`;
  const V2 = `[${[0, 1, ...new Array(1022).fill(0)].join(",")}]`;
  const deps: SearchDeps = {
    embed: async (_texts: string[]) => [[1, ...new Array(1023).fill(0)]], // 假向量：最接近 item1
    rerank: null,
  };
  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    // chunks.meta 需带 label：与 pipeline embed_approved_items 一致（label 从 items 快照进 meta），
    // 检索侧只靠 meta 展开取 label，不 JOIN items。
    await pool.query(
      `INSERT INTO documents (id, title, source_path) VALUES
        ('11111111-1111-1111-1111-111111111111', '书', '/tmp/x.pdf')`,
    );
    await pool.query(
      `INSERT INTO items (id, document_id, content_type, label, content_md) VALUES
        ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'example', '例1', '三位数乘两位数 竖式'),
        ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'exercise', '2', '英语阅读理解')`,
    );
    await pool.query(
      `INSERT INTO chunks (item_id, document_id, content_md, meta, embedding) VALUES
        ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
         '三位数乘两位数 竖式', '{"label":"例1","chapter":"第 1 讲 竖式谜","doc_title":"书"}', $1::vector),
        ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
         '英语阅读理解', '{"label":"2","doc_title":"书"}', $2::vector)`,
      [V1, V2],
    );
    // 章节级向量种子:同 doc 同章(会被条目命中抑制) + 另一 doc 的章节(应保留)
    await pool.query(
      `INSERT INTO documents (id, title, source_path) VALUES
        ('66666666-6666-6666-6666-666666666666', '语法讲义', '/tmp/y.md')`,
    );
    await pool.query(
      `INSERT INTO chapters (id, document_id, chapter_no, title, content_md) VALUES
        ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 1, '竖式谜', '# 竖式谜'),
        ('55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666', 1, '修辞手法', '# 修辞手法')`,
    );
    await pool.query(
      `INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding) VALUES
        ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 1,
         '第 1 讲 竖式谜\n三位数乘两位数 竖式',
         '{"kind":"chapter","chapter":"第 1 讲 竖式谜","doc_title":"书","subject":"数学"}', $1::vector),
        ('55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666', 1,
         '第 1 讲 修辞手法\n比喻句本体',
         '{"kind":"chapter","chapter":"第 1 讲 修辞手法","doc_title":"语法讲义","subject":"语文"}', $1::vector)`,
      [V1],
    );
  });
  afterAll(() => pool.end());

  it("RRF 融合：向量与词法都命中者排最前", async () => {
    const hits = await hybridSearch(pool, deps, "竖式", { topK: 5 });
    expect(hits[0].label).toBe("例1");
    expect(hits[0].score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it("hit 贯通 vec_score(向量余弦),供匹配阈值判定", async () => {
    const hits = await hybridSearch(pool, deps, "三位数乘两位数 竖式");
    // item1(V1 向量)与 query 同方向 → 余弦 ≈ 1
    const hit1 = hits.find((h) => h.item_id === "22222222-2222-2222-2222-222222222222");
    expect(hit1).toBeDefined();
    expect(hit1!.vec_score).toBeCloseTo(1, 5);
    // 2-chunk 库:item2(正交 V2)也会被向量 top20 召回 → vec_score≈0 而非 undefined。
    // 「纯 BM25 条目无 vec_score」分支由融合逻辑保证(仅在向量路 forEach 赋值),
    // 需 >20 chunk 的库才能构造,这里用正交条目的 0 分验证不会误判高相似。
    const hit2 = hits.find((h) => h.item_id === "33333333-3333-3333-3333-333333333333");
    expect(hit2).toBeDefined();
    expect(hit2!.vec_score).toBeCloseTo(0, 5);
  });

  it("章节命中贯通:未拆条文档的内容可被搜到(chapter_id 非 null)", async () => {
    const hits = await hybridSearch(pool, deps, "比喻句本体");
    const chapterHit = hits.find((h) => h.chapter_id === "55555555-5555-5555-5555-555555555555");
    expect(chapterHit).toBeDefined();
    expect(chapterHit!.item_id).toBeNull();
    expect(chapterHit!.chapter).toBe("第 1 讲 修辞手法");
    expect(chapterHit!.doc_title).toBe("语法讲义");
  });

  it("同章抑制:条目级命中时,该章的章节分段不再占位", async () => {
    const hits = await hybridSearch(pool, deps, "竖式", { topK: 10 });
    expect(hits.some((h) => h.item_id === "22222222-2222-2222-2222-222222222222")).toBe(true);
    expect(hits.some((h) => h.chapter_id === "44444444-4444-4444-4444-444444444444")).toBe(false);
  });

  it("itemsOnly:条目检索(试卷匹配用)不返回章节分段", async () => {
    const hits = await hybridSearch(pool, deps, "比喻句本体", { topK: 10, itemsOnly: true });
    expect(hits.every((h) => h.item_id !== null)).toBe(true);
  });
});

maybe("hybridSearch subject 下推（真库）", () => {
  let pool: pg.Pool;
  const V1 = `[${[1, ...new Array(1023).fill(0)].join(",")}]`;
  const V2 = `[${[0, 1, ...new Array(1022).fill(0)].join(",")}]`;
  const deps: SearchDeps = {
    embed: async () => [[1, ...new Array(1023).fill(0)]],
    rerank: null,
  };
  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    // 数学条目 1 条(同学科窗口必须留得住)
    await pool.query(
      `INSERT INTO documents (id, title, subject, source_path) VALUES
        ('11111111-1111-1111-1111-111111111111', '数学书', '数学', '/tmp/x.pdf')`,
    );
    await pool.query(
      `INSERT INTO items (id, document_id, content_type, label, content_md) VALUES
        ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'example', '例1', '三位数乘两位数 竖式')`,
    );
    await pool.query(
      `INSERT INTO chunks (item_id, document_id, content_md, meta, embedding) VALUES
        ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
         '三位数乘两位数 竖式',
         '{"label":"例1","doc_title":"数学书","subject":"数学"}'::jsonb, $1::vector)`,
      [V1],
    );
    // 英语卷 21 条 chapter-chunk,内容含\"英语阅读理解\",刷满 BM25 top-20
    await pool.query(
      `INSERT INTO documents (id, title, subject, source_path) VALUES
        ('77777777-7777-7777-7777-777777777777', '英语书', '英语', '/tmp/c.pdf')`,
    );
    await pool.query(
      `INSERT INTO chapters (id, document_id, chapter_no, title, content_md) VALUES
        ('88888888-8888-8888-8888-888888888888', '77777777-7777-7777-7777-777777777777', 1, '英语阅读', '# 英语阅读')`,
    );
    for (let i = 0; i < 21; i++) {
      await pool.query(
        `INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding) VALUES
          ('88888888-8888-8888-8888-888888888888', '77777777-7777-7777-7777-777777777777', $1,
           '英语阅读理解 exercise long padding text number ' || $2,
           '{"subject":"英语","doc_title":"英语书"}'::jsonb, $3::vector)`,
        [i + 1, String(i), V2],
      );
    }
  });
  afterAll(() => pool.end());

  it("subject 下推 SQL:其他学科刷满窗口也不挤掉同学科命中", async () => {
    const hits = await hybridSearch(pool, deps, "英语阅读理解", {
      topK: 10, filters: { subject: "数学" },
    });
    expect(hits.every((h) => h.subject === "数学")).toBe(true);
    expect(hits.some((h) => h.item_id === "22222222-2222-2222-2222-222222222222")).toBe(true);
  });
});
