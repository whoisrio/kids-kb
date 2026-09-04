/** 试卷产品 API:上传/列表/详情/元数据修改/重试/页级重识别/图片回传。 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import type pg from "pg";
import type { PaperJobDeps } from "../papers/jobs.js";
import { drivePaper } from "../papers/jobs.js";
import { assemblePdf } from "../papers/assemble.js";
import type { BackendConfig } from "../config.js";

const SUBJECTS = new Set(["语文", "数学", "英语", "其他"]);

function mapPgError(c: Context, err: unknown): Response {
  const code = (err as { code?: string })?.code;
  if (code === "23503") return c.json({ error: "child_id 不存在" }, 404);
  if (code === "22P02") return c.json({ error: "id 格式非法（须为 UUID）" }, 422);
  throw err;
}

export function papersRoutes(pool: pg.Pool, deps: PaperJobDeps, cfg: BackendConfig): Hono {
  const app = new Hono({ strict: false });

  app.post("/", async (c) => {
    let form: FormData;
    try {
      // c.req.parseBody 返回普通对象而非 FormData;raw.formData() 才是标准 FormData(.get/.getAll)
      form = await c.req.raw.formData();
    } catch {
      return c.json({ error: "请求体须为 multipart" }, 400);
    }
    const childId = String(form.get("child_id") ?? "");
    const title = String(form.get("title") ?? "").trim();
    const subject = String(form.get("subject") ?? "");
    const files = [...form.getAll("files")].filter((f): f is File => f instanceof File);
    if (!childId || !title || !subject) {
      return c.json({ error: "child_id/title/subject 必填" }, 422);
    }
    if (!SUBJECTS.has(subject)) return c.json({ error: "subject 取值: 语文/数学/英语/其他" }, 422);
    if (files.length === 0) return c.json({ error: "至少上传一个文件(PDF/JPG/PNG)" }, 422);
    try {
      const { rows: child } = await pool.query("SELECT 1 FROM children WHERE id=$1", [childId]);
      if (!child.length) return c.json({ error: "child_id 不存在" }, 404);
      const assembled = await assemblePdf(
        await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
      const { rows: [paper] } = await pool.query(
        `INSERT INTO papers (child_id, title, subject, page_count)
         VALUES ($1,$2,$3,$4)
         RETURNING id::text, title, subject, status, page_count, created_at`,
        [childId, title, subject, assembled.pageCount]);
      void drivePaper(pool, deps, paper.id, { pdfBytes: assembled.bytes });
      return c.json(paper, 201);
    } catch (err) {
      if (err instanceof Error && /不支持的文件类型|至少上传/.test(err.message)) {
        return c.json({ error: err.message }, 422);
      }
      return mapPgError(c, err);
    }
  });

  app.get("/", async (c) => {
    const childId = c.req.query("child_id");
    const params: unknown[] = [];
    let where = "";
    if (childId) { where = "WHERE p.child_id=$1"; params.push(childId); }
    const { rows } = await pool.query(
      `SELECT p.id::text, p.title, p.subject, p.status, p.error, p.page_count, p.created_at,
              count(q.id)::int AS total_questions,
              count(q.id) FILTER (WHERE q.confirmed_result IS NOT NULL)::int AS confirmed_questions
       FROM papers p LEFT JOIN paper_questions q ON q.paper_id = p.id
       ${where} GROUP BY p.id ORDER BY p.created_at DESC`, params);
    return c.json({ papers: rows });
  });

  app.get("/:id", async (c) => {
    try {
      const { rows: [paper] } = await pool.query(
        `SELECT id::text, title, subject, child_id::text, status, error, page_count, created_at
         FROM papers WHERE id=$1`, [c.req.param("id")]);
      if (!paper) return c.json({ error: "试卷不存在" }, 404);
      const { rows: questions } = await pool.query(
        `SELECT pq.id::text, pq.page_no, pq.seq_in_page,
                row_number() OVER (ORDER BY pq.page_no, pq.seq_in_page)::int AS seq,
                pq.content_md, pq.answer_excerpt, pq.mark_desc,
                pq.recognized_result, pq.confirmed_result, pq.error_cause, pq.note,
                pq.matched_item_id::text, pq.match_score,
                i.label AS matched_label, i.chapter AS matched_chapter, d.title AS matched_doc_title
         FROM paper_questions pq
         LEFT JOIN items i ON i.id = pq.matched_item_id
         LEFT JOIN documents d ON d.id = i.document_id
         WHERE pq.paper_id=$1 ORDER BY pq.page_no, pq.seq_in_page`, [c.req.param("id")]);
      return c.json({ ...paper, questions });
    } catch (err) {
      return mapPgError(c, err);
    }
  });

  app.patch("/:id", async (c) => {
    let body: { title?: string; subject?: string; child_id?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "请求体不是合法 JSON" }, 400); }
    const title = body.title?.trim();
    if (body.title !== undefined && !title) return c.json({ error: "title 不能为空" }, 422);
    if (body.subject !== undefined && !SUBJECTS.has(body.subject)) {
      return c.json({ error: "subject 取值: 语文/数学/英语/其他" }, 422);
    }
    try {
      const { rows: [paper] } = await pool.query(
        `UPDATE papers SET
           title=coalesce($2, title), subject=coalesce($3, subject), child_id=coalesce($4, child_id),
           updated_at=now()
         WHERE id=$1
         RETURNING id::text, title, subject, child_id::text, status, page_count`,
        [c.req.param("id"), title ?? null, body.subject ?? null, body.child_id ?? null]);
      if (!paper) return c.json({ error: "试卷不存在" }, 404);
      return c.json(paper);
    } catch (err) {
      return mapPgError(c, err);
    }
  });

  app.post("/:id/retry", async (c) => {
    const { rows: [paper] } = await pool.query(
      "SELECT id::text, status FROM papers WHERE id=$1", [c.req.param("id")]);
    if (!paper) return c.json({ error: "试卷不存在" }, 404);
    if (paper.status !== "failed") return c.json({ error: "只有 failed 卷可重试" }, 409);
    await pool.query(
      "UPDATE papers SET status='processing', error=NULL, updated_at=now() WHERE id=$1", [paper.id]);
    void drivePaper(pool, deps, paper.id);
    return c.json({ id: paper.id, status: "processing" });
  });

  app.post("/:id/re-recognize", async (c) => {
    let body: { page_no?: number };
    try { body = await c.req.json(); } catch { return c.json({ error: "请求体不是合法 JSON" }, 400); }
    const pageNo = Number(body.page_no);
    if (!Number.isInteger(pageNo) || pageNo < 1) return c.json({ error: "page_no 须为正整数" }, 422);
    const { rows: [paper] } = await pool.query(
      "SELECT id::text, status, page_count FROM papers WHERE id=$1", [c.req.param("id")]);
    if (!paper) return c.json({ error: "试卷不存在" }, 404);
    if (pageNo > paper.page_count) return c.json({ error: `page_no 越界(共 ${paper.page_count} 页)` }, 422);
    if (paper.status === "processing") return c.json({ error: "处理中,勿并发重识别" }, 409);
    await pool.query(
      "UPDATE papers SET status='processing', updated_at=now() WHERE id=$1", [paper.id]);
    void drivePaper(pool, deps, paper.id, { pageNo });
    return c.json({ id: paper.id, status: "processing", page_no: pageNo });
  });

  app.get("/:id/source.pdf", async (c) => {
    try {
      const { rows: [paper] } = await pool.query(
        "SELECT id::text FROM papers WHERE id=$1", [c.req.param("id")]);
      if (!paper) return c.json({ error: "试卷不存在" }, 404);
      const path = join(cfg.storageRoot, "papers", paper.id, "source.pdf");
      const buf = await readFile(path);
      return c.body(new Uint8Array(buf), 200, { "Content-Type": "application/pdf" });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "22P02") return c.json({ error: "id 格式非法（须为 UUID）" }, 422);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "原件缺失" }, 404);
      }
      throw err;
    }
  });

  app.get("/:id/pages/:page_no/image", async (c) => {
    const pageNo = Number(c.req.param("page_no"));
    const { rows: [paper] } = await pool.query(
      "SELECT id::text, page_count FROM papers WHERE id=$1", [c.req.param("id")]);
    if (!paper) return c.json({ error: "试卷不存在" }, 404);
    if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > paper.page_count) {
      return c.json({ error: "page_no 越界" }, 422);
    }
    const path = join(cfg.storageRoot, "papers", paper.id, "pages", `p${String(pageNo).padStart(4, "0")}.png`);
    try {
      const buf = await readFile(path);
      return c.body(new Uint8Array(buf), 200, { "Content-Type": "image/png" });
    } catch {
      return c.json({ error: "页图缺失" }, 404);
    }
  });

  return app;
}
