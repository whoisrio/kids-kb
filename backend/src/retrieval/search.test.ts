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
         '三位数乘两位数 竖式', '{"label":"例1","doc_title":"书"}', $1::vector),
        ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
         '英语阅读理解', '{"label":"2","doc_title":"书"}', $2::vector)`,
      [V1, V2],
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
});
