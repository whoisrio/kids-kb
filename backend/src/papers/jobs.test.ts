import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { resetDbForTest } from "../db.js";
import { drivePaper, redriveStuckPapers } from "./jobs.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const CHILD = "11111111-1111-1111-1111-111111111111";
const ITEM = "22222222-2222-2222-2222-222222222222";

maybe("试卷后台任务（真库 + 假 pipeline fetch）", () => {
  let pool: pg.Pool;

  async function seedPaper(status = "processing") {
    const { rows: [p] } = await pool.query(
      `INSERT INTO papers (child_id, title, subject, status, page_count)
       VALUES ($1,'卷','数学',$2,1) RETURNING id::text`, [CHILD, status]);
    return p.id as string;
  }

  async function seedQuestion(paperId: string, content: string) {
    const { rows: [q] } = await pool.query(
      `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md)
       VALUES ($1,1,1,$2) RETURNING id::text`, [paperId, content]);
    return q.id as string;
  }

  const okPipeline = async () => new Response(JSON.stringify({ pages: 1, questions: 1 }));
  // embed 返回指向 ITEM chunk 的向量 → 余弦 1 → 自动关联
  const vec = `[${[1, ...new Array(1023).fill(0)].join(",")}]`;
  const deps = {
    pipelineUrl: "http://pipeline.test",
    matchThreshold: 0.88,
    embed: async () => [[1, ...new Array(1023).fill(0)]],
    rerank: async (_q: string, docs: string[]) => docs.map(() => 1),
    fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("/internal/ingest-paper")) return okPipeline();
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch,
  };

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    await pool.query("INSERT INTO children (id, name) VALUES ($1,'小宝')", [CHILD]);
    await pool.query(
      `INSERT INTO documents (id, title, subject, source_path) VALUES
        ('33333333-3333-3333-3333-333333333333','数学书','数学','/tmp/a.pdf')`);
    await pool.query(
      `INSERT INTO items (id, document_id, content_type, label, content_md) VALUES
        ($1,'33333333-3333-3333-3333-333333333333','exercise','1','135 ÷ 5 =')`, [ITEM]);
    await pool.query(
      `INSERT INTO chunks (item_id, document_id, content_md, meta, embedding) VALUES
        ($1,'33333333-3333-3333-3333-333333333333','135 ÷ 5 =',
         '{"subject":"数学","label":"1"}'::jsonb, $2::vector)`, [ITEM, vec]);
  });
  afterAll(async () => { await pool.end(); });

  it("成功路径:调 pipeline -> 自动匹配 -> ready_for_review", async () => {
    const id = await seedPaper();
    await seedQuestion(id, "135 ÷ 5 =");
    const signalCalls: unknown[] = [];
    const depsWithSignal = {
      ...deps,
      fetchImpl: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        signalCalls.push(init?.signal);
        const u = String(input);
        if (u.includes("/internal/ingest-paper")) return okPipeline();
        throw new Error(`unexpected ${u}`);
      }) as unknown as typeof fetch,
    };
    await drivePaper(pool, depsWithSignal, id);
    const paper = (await pool.query(
      "SELECT status, error FROM papers WHERE id=$1", [id])).rows[0];
    expect(paper.status).toBe("ready_for_review");
    expect(paper.error).toBeNull();
    const q = (await pool.query(
      "SELECT matched_item_id::text, match_score FROM paper_questions WHERE paper_id=$1", [id])).rows[0];
    expect(q.matched_item_id).toBe(ITEM);
    expect(q.match_score).toBeGreaterThan(0.88);
    // 首次驱动带 multipart body
    const call = (depsWithSignal.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[0])).toContain("/internal/ingest-paper");
    // 每次 pipeline 调用都挂了 AbortSignal 超时(10 分钟),防整卷卡死
    expect(signalCalls.length).toBeGreaterThan(0);
    for (const s of signalCalls) expect(s).toBeInstanceOf(AbortSignal);
  });

  it("pipeline 失败 -> failed + error 文案", async () => {
    const id = await seedPaper();
    await pool.query("DELETE FROM paper_questions WHERE paper_id=$1", [id]);
    const badDeps = { ...deps, fetchImpl: (async () =>
      new Response(JSON.stringify({ detail: "VLM 超时" }), { status: 500 })) as unknown as typeof fetch };
    await drivePaper(pool, badDeps, id);
    const paper = (await pool.query(
      "SELECT status, error FROM papers WHERE id=$1", [id])).rows[0];
    expect(paper.status).toBe("failed");
    expect(paper.error).toContain("VLM 超时");
  });

  it("0 题识别 -> failed", async () => {
    const id = await seedPaper();
    await drivePaper(pool, { ...deps, fetchImpl: okPipeline as unknown as typeof fetch }, id);
    const paper = (await pool.query(
      "SELECT status, error FROM papers WHERE id=$1", [id])).rows[0];
    expect(paper.status).toBe("failed");
    expect(paper.error).toContain("未识别出题目");
  });

  it("redriveStuckPapers 重驱动滞留 processing 的卷", async () => {
    await seedPaper();        // processing
    await seedPaper("done");  // 不动
    const n = await redriveStuckPapers(pool, { ...deps, fetchImpl: okPipeline as unknown as typeof fetch });
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("匹配失败不致命:卷仍 ready_for_review(人工匹配兜底)", async () => {
    const id = await seedPaper();
    await seedQuestion(id, "x");
    await drivePaper(pool, { ...deps, embed: async () => { throw new Error("ollama 挂了"); } }, id);
    const paper = (await pool.query(
      "SELECT status FROM papers WHERE id=$1", [id])).rows[0];
    expect(paper.status).toBe("ready_for_review");
  });
});
