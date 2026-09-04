import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { resetDbForTest } from "../db.js";
import { matchQuestion } from "./match.js";
import type { SearchDeps } from "./search.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("matchQuestion（真库）", () => {
  let pool: pg.Pool;
  // 题库两条:数学(向量沿 x 轴)与英语(沿 y 轴,与数学正交)
  const mathVec = [1, ...new Array(1023).fill(0)];
  const engVec = [0, 1, ...new Array(1022).fill(0)];
  // query 向量与 mathVec 夹角约 0.31rad → 余弦 ≈ 0.952:
  // > 0.88(自动命中)且 < 0.999(可测"低于阈值"分支),避免同向向量 cos=1.0 恒超阈值。
  const queryVec = [
    Math.cos(0.31),
    Math.sin(0.31),
    ...new Array(1022).fill(0),
  ];
  const deps: SearchDeps = {
    embed: async () => [queryVec],
    rerank: async (_q, docs) => docs.map(() => 1),
  };

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    await pool.query(
      `INSERT INTO documents (id, title, subject, source_path) VALUES
        ('11111111-1111-1111-1111-111111111111','数学书','数学','/tmp/a.pdf'),
        ('44444444-4444-4444-4444-444444444444','英语书','英语','/tmp/b.pdf')`,
    );
    await pool.query(
      `INSERT INTO items (id, document_id, content_type, label, content_md) VALUES
        ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','exercise','1','135 ÷ 5 = 27'),
        ('55555555-5555-5555-5555-555555555555','44444444-4444-4444-4444-444444444444','exercise','2','英语阅读')`,
    );
    const vec = (arr: number[]) => `[${arr.join(",")}]`;
    await pool.query(
      `INSERT INTO chunks (item_id, document_id, content_md, meta, embedding) VALUES
        ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','135 ÷ 5 = 27',
         '{"subject":"数学","label":"1","chapter":null,"doc_title":"数学书"}'::jsonb, $1::vector),
        ('55555555-5555-5555-5555-555555555555','44444444-4444-4444-4444-444444444444','英语阅读',
         '{"subject":"英语","label":"2","chapter":null,"doc_title":"英语书"}'::jsonb, $2::vector)`,
      [vec(mathVec), vec(engVec)],
    );
    // 章节分段:同 doc 数学、向量与 mathVec 同向(与查询同向)——若不过滤会被当成 top 候选
    await pool.query(
      `INSERT INTO chapters (id, document_id, chapter_no, title, content_md) VALUES
        ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 1, '除法', '# 除法')`,
    );
    await pool.query(
      `INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding) VALUES
        ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 1,
         '第 1 讲 除法\n135 ÷ 5 = 27 讲解',
         '{"kind":"chapter","chapter":"第 1 讲 除法","subject":"数学","doc_title":"数学书"}', $1::vector)`,
      [vec(mathVec)],
    );
  });
  afterAll(async () => { await pool.end(); });

  it("同学科过滤 + rerank 第一名超阈值 → auto", async () => {
    const { candidates, auto } = await matchQuestion(
      pool, deps, "135 ÷ 5 = 27", "数学", 0.88);
    expect(auto?.item_id).toBe("22222222-2222-2222-2222-222222222222");
    expect(auto!.vec_score).toBeGreaterThan(0.88);
    expect(candidates.map((c) => c.item_id)).not.toContain("55555555-5555-5555-5555-555555555555");
  });

  it("rerank 第一名低于阈值 → auto 为 null(宁缺勿滥)", async () => {
    const { auto, candidates } = await matchQuestion(
      pool, deps, "135 ÷ 5 = 27", "数学", 0.999);
    expect(auto).toBeNull();
    expect(candidates.length).toBeGreaterThan(0);  // 候选照常供人工选择
  });

  it("匹配只用条目级 chunk:章节分段不进候选(auto 仍是 item)", async () => {
    const { candidates, auto } = await matchQuestion(
      pool, deps, "135 ÷ 5 = 27", "数学", 0.88);
    expect(auto?.item_id).toBe("22222222-2222-2222-2222-222222222222");
    expect(candidates.every((c) => c.item_id !== null)).toBe(true);
    expect(candidates.some((c) => c.chapter_id === "66666666-6666-6666-6666-666666666666")).toBe(false);
  });

  it("topK=10:候选窗口按 spec 放宽到 10", async () => {
    const { candidates } = await matchQuestion(pool, deps, "135 ÷ 5 = 27", "数学", 0.88);
    expect(candidates.length).toBeLessThanOrEqual(10);
  });
});
