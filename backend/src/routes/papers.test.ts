import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { Hono } from "hono";
import { resetDbForTest } from "../db.js";
import { papersRoutes } from "./papers.js";
import type { PaperJobDeps } from "../papers/jobs.js";
import type { BackendConfig } from "../config.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const CHILD = "11111111-1111-1111-1111-111111111111";
const STORAGE_ROOT = "/tmp/kb-papers-test";

maybe("papers API（真库）", () => {
  let pool: pg.Pool;
  let app: Hono;
  let deps: PaperJobDeps;

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    await pool.query("INSERT INTO children (id, name) VALUES ($1,'小宝')", [CHILD]);
    deps = {
      pipelineUrl: "http://x", matchThreshold: 0.88,
      embed: async () => { throw new Error("不应在路由测试里匹配"); },
      rerank: null,
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    };
    app = new Hono();
    app.route("/api/papers", papersRoutes(pool, deps, { storageRoot: STORAGE_ROOT } as BackendConfig));
  });
  afterAll(async () => { await pool.end(); });

  function multipart(fields: Record<string, string>, files: { name: string; bytes: Uint8Array }[] = []) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const f of files) form.append("files", new Blob([f.bytes as BlobPart]), f.name);
    return form;
  }

  const PNG_1PX = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
    (c) => c.charCodeAt(0));

  // 上传会 void drivePaper(异步改状态)→ 状态断言放宽;其余用例手动 seed(状态确定)
  async function upload(ok = true) {
    return app.request("/api/papers", {
      method: "POST",
      body: multipart(
        ok ? { child_id: CHILD, title: "期中卷", subject: "数学" } : {},
        [{ name: "p1.png", bytes: PNG_1PX }],
      ),
    });
  }

  async function seedPaper(over: Partial<Record<string, string | number>> = {}) {
    const { rows: [p] } = await pool.query(
      `INSERT INTO papers (child_id, title, subject, status, page_count)
       VALUES ($1,$2,$3,$4,$5) RETURNING id::text`,
      [CHILD, over.title ?? "卷", over.subject ?? "数学",
       over.status ?? "processing", over.page_count ?? 1]);
    return p.id as string;
  }

  it("上传:建行 processing + 触发后台任务 + 201", async () => {
    // drivePaper 会真调 fakeDeps.fetchImpl(返回 {} 也行,失败会落 failed,不影响建行断言)
    const resp = await upload();
    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.status).toBe("processing");
    expect(body.page_count).toBe(1);
    const row = (await pool.query("SELECT status, source_path FROM papers WHERE id=$1", [body.id])).rows[0];
    expect(row.status).toMatch(/processing|failed/);
  });

  it("上传校验:缺字段 422 / child 不存在 404 / 非法文件类型 422 / 无文件 422", async () => {
    expect((await upload(false)).status).toBe(422);
    const badChild = await app.request("/api/papers", { method: "POST",
      body: multipart({ child_id: "99999999-9999-9999-9999-999999999999", title: "t", subject: "数学" },
        [{ name: "a.png", bytes: PNG_1PX }]) });
    expect(badChild.status).toBe(404);
    const badType = await app.request("/api/papers", { method: "POST",
      body: multipart({ child_id: CHILD, title: "t", subject: "数学" },
        [{ name: "a.heic", bytes: PNG_1PX }]) });
    expect(badType.status).toBe(422);
    const noFile = await app.request("/api/papers", { method: "POST",
      body: multipart({ child_id: CHILD, title: "t", subject: "数学" }) });
    expect(noFile.status).toBe(422);
  });

  it("列表带确认进度;详情带全局序号;PATCH 改元数据", async () => {
    // 手动 seed(无 drivePaper 追改,状态确定),避免上传后异步 failed 竞态
    const id = await seedPaper();
    await pool.query(
      `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md) VALUES
        ($1,1,1,'q1'),($1,2,1,'q2')`, [id]);
    await pool.query(
      "UPDATE paper_questions SET confirmed_result='wrong' WHERE paper_id=$1 AND page_no=1", [id]);
    const list = await (await app.request("/api/papers?child_id=" + CHILD)).json();
    const mine = list.papers.find((p: { id: string }) => p.id === id);
    expect(mine).toMatchObject({ total_questions: 2, confirmed_questions: 1, status: "processing" });

    const detail = await (await app.request(`/api/papers/${id}`)).json();
    expect(detail.questions.map((q: { seq: number }) => q.seq)).toEqual([1, 2]);
    expect(detail.questions[0]).toMatchObject({ page_no: 1, content_md: "q1" });

    const patched = await app.request(`/api/papers/${id}`, {
      method: "PATCH", body: JSON.stringify({ title: "期末卷", subject: "英语" }),
      headers: { "Content-Type": "application/json" } });
    expect(patched.status).toBe(200);
    expect((await patched.json()).title).toBe("期末卷");
  });

  it("retry 只允许 failed;re-recognize 校验页码范围", async () => {
    const id = await seedPaper();
    const r1 = await app.request(`/api/papers/${id}/retry`, { method: "POST" });
    expect(r1.status).toBe(409);  // processing 不许 retry
    await pool.query("UPDATE papers SET status='failed', error='x' WHERE id=$1", [id]);
    const r2 = await app.request(`/api/papers/${id}/retry`, { method: "POST" });
    expect(r2.status).toBe(200);
    const id2 = await seedPaper({ status: "ready_for_review" });
    const rr = await app.request(`/api/papers/${id2}/re-recognize`, {
      method: "POST", body: JSON.stringify({ page_no: 99 }),
      headers: { "Content-Type": "application/json" } });
    expect(rr.status).toBe(422);
  });

  it("页图回传:存在则 200 + image/png,缺失则 404", async () => {
    const id = await seedPaper({ status: "ready_for_review" });
    await pool.query(
      `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md)
       VALUES ($1,1,1,'q')`, [id]);
    // 文件不存在 → 404
    const miss = await app.request(`/api/papers/${id}/pages/1/image`);
    expect(miss.status).toBe(404);
    // 写入文件 → 200 + png
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(STORAGE_ROOT, "papers", id, "pages");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "p0001.png"), Buffer.from("fakepng"));
    const ok = await app.request(`/api/papers/${id}/pages/1/image`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("image/png");
  });

  it("GET /:id/source.pdf 回传原件;缺失 404;非法 id 422", async () => {
    const { rows: [paper] } = await pool.query(
      `INSERT INTO papers (child_id, title, subject, status, page_count)
       VALUES ($1,'原件卷','数学','failed',0) RETURNING id::text`, [CHILD]);
    const srcDir = `${STORAGE_ROOT}/papers/${paper.id}`;
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(`${srcDir}/source.pdf`, Buffer.from("%PDF-1.4 fake"));

    const ok = await app.request(`/api/papers/${paper.id}/source.pdf`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await ok.arrayBuffer()).toString()).toContain("%PDF-1.4");

    // 缺失 404(DB 有卷但盘上无原件)
    const { rows: [paper2] } = await pool.query(
      `INSERT INTO papers (child_id, title, subject, status, page_count)
       VALUES ($1,'无原件卷','数学','failed',0) RETURNING id::text`, [CHILD]);
    expect((await app.request(`/api/papers/${paper2.id}/source.pdf`)).status).toBe(404);

    // 非法 id 422(与 Task 4 的统一语义一致)
    expect((await app.request("/api/papers/not-a-uuid/source.pdf")).status).toBe(422);
  });

  it("GET /:id/pages 列出已渲染页图编号(供 failed 详情展示)", async () => {
    const { rows: [paper] } = await pool.query(
      `INSERT INTO papers (child_id, title, subject, status, page_count)
       VALUES ($1,'页图卷','数学','failed',3) RETURNING id::text`, [CHILD]);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const pagesDir = `${STORAGE_ROOT}/papers/${paper.id}/pages`;
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(`${pagesDir}/p0002.png`, Buffer.from("png"));
    writeFileSync(`${pagesDir}/p0001.png`, Buffer.from("png"));
    const resp = await app.request(`/api/papers/${paper.id}/pages`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ pages: [1, 2] });
  });

  it("非 UUID id 全族统一 422(retry/re-recognize/pages image)", async () => {
    for (const path of [
      "/api/papers/not-a-uuid/retry",
      "/api/papers/not-a-uuid/re-recognize",
      "/api/papers/not-a-uuid/pages/1/image",
      "/api/papers/not-a-uuid/source.pdf",
      "/api/papers/not-a-uuid/pages",
    ]) {
      const method = path.endsWith("/retry") || path.endsWith("/re-recognize") ? "POST" : "GET";
      const init: RequestInit | undefined = method === "POST"
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
        : undefined;
      const resp = await app.request(path, init);
      expect(resp.status, path).toBe(422);
      expect((await resp.json()).error).toContain("UUID");
    }
  });
});
