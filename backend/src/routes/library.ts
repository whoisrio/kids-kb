/** 资料库 API：上传、分页列表/详情、删除、检索和索引控制。 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Hono } from "hono";
import type pg from "pg";
import type { BackendConfig } from "../config.js";
import { driveDoc } from "../library/jobs.js";
import type { SearchHit } from "../retrieval/search.js";

export interface LibraryDeps {
  pipelineUrl: string;
  search: (q: string, filters?: Record<string, string>) => Promise<SearchHit[]>;
  fetchImpl?: typeof fetch;
}

const DOCUMENT_STATS_SQL = `
  SELECT d.id::text, d.title, d.subject, d.parse_status, d.review_status,
         d.uploaded_by, d.created_at, d.struct_mode, d.doc_type,
         '/api/review/pages/' || cover.id::text || '/image' AS cover_url,
         CASE WHEN lower(d.source_path) LIKE '%.pdf' THEN 'pdf'
              WHEN lower(d.source_path) LIKE '%.docx' THEN 'docx'
              ELSE 'md' END AS file_type,
         CASE WHEN lower(d.source_path) LIKE '%.pdf' THEN coalesce(ps.total_pages, 0)
              ELSE coalesce(cs.total_chapters, 0) END AS total_units,
         coalesce(ps.total_pages, 0) AS total_pages,
         coalesce(cs.total_chapters, 0) AS total_chapters,
         CASE WHEN lower(d.source_path) LIKE '%.pdf' THEN coalesce(ps.auto_pending, 0)
              ELSE coalesce(cs.auto_pending, 0) END AS auto_pending,
         CASE WHEN lower(d.source_path) LIKE '%.pdf' THEN coalesce(ps.auto_passed, 0)
              ELSE coalesce(cs.auto_passed, 0) END AS auto_passed,
         CASE WHEN lower(d.source_path) LIKE '%.pdf' THEN coalesce(ps.auto_needs_review, 0)
              ELSE coalesce(cs.auto_needs_review, 0) END AS auto_needs_review,
         CASE WHEN lower(d.source_path) LIKE '%.pdf' THEN coalesce(ps.auto_failed, 0)
              ELSE coalesce(cs.auto_failed, 0) END AS auto_failed,
         CASE WHEN lower(d.source_path) LIKE '%.pdf' THEN coalesce(ps.manual_unreviewed, 0)
              ELSE coalesce(cs.manual_unreviewed, 0) END AS manual_unreviewed,
         CASE WHEN lower(d.source_path) LIKE '%.pdf' THEN coalesce(ps.manual_approved, 0)
              ELSE coalesce(cs.manual_approved, 0) END AS manual_approved,
         CASE WHEN lower(d.source_path) LIKE '%.pdf' THEN coalesce(ps.manual_rejected, 0)
              ELSE coalesce(cs.manual_rejected, 0) END AS manual_rejected,
         CASE WHEN lower(d.source_path) LIKE '%.pdf' THEN coalesce(ps.index_indexed, 0)
              ELSE coalesce(cs.index_indexed, 0) END AS index_indexed,
         CASE WHEN lower(d.source_path) LIKE '%.pdf' THEN coalesce(ps.index_stale, 0)
              ELSE coalesce(cs.index_stale, 0) END AS index_stale,
         CASE WHEN lower(d.source_path) LIKE '%.pdf' THEN coalesce(ps.index_not_indexed, 0)
              ELSE coalesce(cs.index_not_indexed, 0) END AS index_not_indexed,
         coalesce(ps.index_excluded, 0) AS index_excluded,
         coalesce(ps.pages_parsed, 0) AS pages_parsed,
         coalesce(ps.pages_failed, 0) AS pages_failed
  FROM documents d
  LEFT JOIN LATERAL (
    SELECT count(*) AS total_pages,
           count(*) FILTER (WHERE NOT excluded_from_index AND auto_review_status = 'pending') AS auto_pending,
           count(*) FILTER (WHERE NOT excluded_from_index AND auto_review_status = 'passed') AS auto_passed,
           count(*) FILTER (WHERE NOT excluded_from_index AND auto_review_status = 'needs_review') AS auto_needs_review,
           count(*) FILTER (WHERE NOT excluded_from_index AND auto_review_status = 'failed') AS auto_failed,
           count(*) FILTER (WHERE NOT excluded_from_index AND manual_review_status = 'unreviewed') AS manual_unreviewed,
           count(*) FILTER (WHERE NOT excluded_from_index AND manual_review_status = 'approved') AS manual_approved,
           count(*) FILTER (WHERE NOT excluded_from_index AND manual_review_status = 'rejected') AS manual_rejected,
           count(*) FILTER (WHERE NOT excluded_from_index AND index_status = 'indexed') AS index_indexed,
           count(*) FILTER (WHERE NOT excluded_from_index AND index_status = 'stale') AS index_stale,
           count(*) FILTER (WHERE NOT excluded_from_index AND index_status = 'not_indexed') AS index_not_indexed,
           count(*) FILTER (WHERE excluded_from_index) AS index_excluded,
           count(*) FILTER (WHERE parse_status = 'parsed') AS pages_parsed,
           count(*) FILTER (WHERE parse_status = 'failed') AS pages_failed
    FROM pages WHERE document_id = d.id
  ) ps ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS total_chapters,
           count(*) FILTER (WHERE auto_review_status = 'pending') AS auto_pending,
           count(*) FILTER (WHERE auto_review_status = 'passed') AS auto_passed,
           count(*) FILTER (WHERE auto_review_status = 'needs_review') AS auto_needs_review,
           count(*) FILTER (WHERE auto_review_status = 'failed') AS auto_failed,
           count(*) FILTER (WHERE manual_review_status = 'unreviewed') AS manual_unreviewed,
           count(*) FILTER (WHERE manual_review_status = 'approved') AS manual_approved,
           count(*) FILTER (WHERE manual_review_status = 'rejected') AS manual_rejected,
           count(*) FILTER (WHERE index_status = 'indexed') AS index_indexed,
           count(*) FILTER (WHERE index_status = 'stale') AS index_stale,
           count(*) FILTER (WHERE index_status = 'not_indexed') AS index_not_indexed
    FROM chapters WHERE document_id = d.id
  ) cs ON true
  LEFT JOIN LATERAL (
    SELECT id FROM pages
    WHERE document_id = d.id AND NOT excluded_from_index
    ORDER BY page_no LIMIT 1
  ) cover ON true
`;

type Pagination = { page: number; pageSize: number; offset: number };

/** 排序白名单：ORDER BY 只允许从这里取片段拼接，禁止用户输入直接进 SQL。 */
const SORT_SQL: Record<string, string> = {
  updated: "created_at DESC",
  name: "title ASC",
  units: "total_units DESC",
};

function pagination(query: Record<string, string>): Pagination {
  const page = Number(query.page ?? 1);
  const pageSize = Number(query.pageSize ?? 20);
  if (!Number.isInteger(page) || page < 1) throw new Error("page 须为正整数");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error("pageSize 须为 1-100 的整数");
  }
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function counts(row: Record<string, unknown>) {
  return {
    auto_review: {
      pending: Number(row.auto_pending), passed: Number(row.auto_passed),
      needs_review: Number(row.auto_needs_review), failed: Number(row.auto_failed),
    },
    manual_review: {
      unreviewed: Number(row.manual_unreviewed), approved: Number(row.manual_approved),
      rejected: Number(row.manual_rejected),
    },
    index: {
      indexed: Number(row.index_indexed), stale: Number(row.index_stale),
      not_indexed: Number(row.index_not_indexed), excluded: Number(row.index_excluded),
    },
  };
}

export function libraryRoutes(pool: pg.Pool, deps: LibraryDeps, cfg: BackendConfig): Hono {
  const app = new Hono({ strict: false });

  app.post("/docs", async (c) => {
    let form: FormData;
    try {
      // c.req.parseBody 返回普通对象而非 FormData;raw.formData() 才是标准 FormData
      form = await c.req.raw.formData();
    } catch {
      return c.json({ error: "请求体须为 multipart" }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "file 必填(单文件)" }, 422);
    const ext = extname(file.name).toLowerCase();
    if (![".pdf", ".docx", ".md"].includes(ext)) {
      return c.json({ error: "仅支持 .pdf/.docx/.md 文件" }, 422);
    }
    const docType = String(form.get("doc_type") ?? "").trim() || "workbook";
    if (!["workbook", "exam"].includes(docType)) return c.json({ error: "doc_type 非法" }, 422);
    const title = String(form.get("title") ?? "").trim() || file.name.replace(/\.[^.]+$/, "");
    const subject = String(form.get("subject") ?? "").trim() || null;

    const docId = randomUUID();
    const sourcePath = resolve(join(cfg.storageRoot, docId, `source${ext}`));
    await mkdir(join(cfg.storageRoot, docId), { recursive: true });
    await writeFile(sourcePath, new Uint8Array(await file.arrayBuffer()));
    // 预插 pending 行:表达「待检测」窗口;pipeline 端点以 source_path 幂等接管
    await pool.query(
      `INSERT INTO documents (id, title, subject, doc_type, source_path, parse_status)
       VALUES ($1,$2,$3,$4,$5,'pending')`,
      [docId, title, subject, docType, sourcePath]);
    void driveDoc(pool, { pipelineUrl: deps.pipelineUrl, fetchImpl: deps.fetchImpl }, docId, {
      source_path: sourcePath, title, subject, doc_type: docType,
    });
    return c.json(
      { id: docId, title, subject, doc_type: docType, parse_status: "pending" },
      201,
    );
  });

  app.get("/", async (c) => {
    try {
      const p = pagination(c.req.query());
      const q = (c.req.query("q") ?? "").trim();
      const subject = (c.req.query("subject") ?? "").trim();
      const fileType = c.req.query("file_type");
      const docType = c.req.query("doc_type");
      const autoReview = c.req.query("auto_review");
      const reviewStatus = c.req.query("review_status");
      const indexStatus = c.req.query("index_status");
      const sort = c.req.query("sort") ?? "updated";
      if (!SORT_SQL[sort]) return c.json({ error: "sort 非法" }, 422);
      if (fileType) {
        if (!["pdf", "docx", "md"].includes(fileType)) return c.json({ error: "file_type 非法" }, 422);
      }
      if (docType) {
        if (!["workbook", "exam"].includes(docType)) return c.json({ error: "doc_type 非法" }, 422);
      }
      if (autoReview) {
        if (!["pending", "passed", "needs_review", "failed"].includes(autoReview)) {
          return c.json({ error: "auto_review 非法" }, 422);
        }
      }
      if (reviewStatus) {
        if (!["unreviewed", "approved", "rejected"].includes(reviewStatus)) {
          return c.json({ error: "review_status 非法" }, 422);
        }
      }
      if (indexStatus) {
        if (!["indexed", "partial", "stale", "not_indexed", "excluded"].includes(indexStatus)) {
          return c.json({ error: "index_status 非法" }, 422);
        }
      }
      const params: unknown[] = [
        q || null, subject || null, fileType || null, docType || null,
        autoReview || null, reviewStatus || null, indexStatus || null,
        p.pageSize, p.offset,
      ];
      const { rows } = await pool.query(
        `WITH stats AS (${DOCUMENT_STATS_SQL})
         SELECT *, count(*) OVER()::int AS total_count
         FROM stats
         WHERE ($1::text IS NULL OR title ILIKE '%' || $1::text || '%')
           AND ($2::text IS NULL OR subject = $2::text)
           AND ($3::text IS NULL OR file_type = $3::text)
           AND ($4::text IS NULL OR doc_type = $4::text)
           AND (
             $5::text IS NULL OR
             ($5::text = 'passed' AND total_units > 0 AND auto_pending = 0 AND auto_needs_review = 0 AND auto_failed = 0) OR
             ($5::text = 'pending' AND auto_pending > 0) OR
             ($5::text = 'needs_review' AND auto_needs_review > 0) OR
             ($5::text = 'failed' AND auto_failed > 0)
           )
           AND (
             $6::text IS NULL OR
             ($6::text = 'approved' AND total_units > 0 AND manual_unreviewed = 0 AND manual_rejected = 0) OR
             ($6::text = 'unreviewed' AND manual_unreviewed > 0) OR
             ($6::text = 'rejected' AND manual_rejected > 0)
           )
           AND (
             $7::text IS NULL OR
             ($7::text = 'indexed' AND total_units > 0 AND index_indexed = total_units - index_excluded) OR
             ($7::text = 'partial' AND index_indexed > 0 AND index_indexed < total_units - index_excluded) OR
             ($7::text = 'stale' AND index_stale > 0) OR
             ($7::text = 'not_indexed' AND index_not_indexed > 0) OR
             ($7::text = 'excluded' AND index_excluded > 0)
           )
         ORDER BY ${SORT_SQL[sort]}
         LIMIT $8::int OFFSET $9::int`,
        params,
      );
      const total = rows[0] ? Number(rows[0].total_count) : 0;
      return c.json({
        documents: rows.map(({ total_count: _total, ...doc }) => ({
          ...doc,
          total_pages: Number(doc.total_pages),
          total_chapters: Number(doc.total_chapters),
          pages_parsed: Number(doc.pages_parsed),
          pages_failed: Number(doc.pages_failed),
          ...counts(doc),
        })),
        pagination: {
          page: p.page, pageSize: p.pageSize, total,
          totalPages: Math.ceil(total / p.pageSize),
        },
      });
    } catch (err) {
      if (err instanceof Error && /page|pageSize/.test(err.message)) return c.json({ error: err.message }, 422);
      throw err;
    }
  });

  app.get("/summary", async (c) => {
    const { rows: [totals] } = await pool.query(
      `SELECT count(*)::int AS total_docs,
              (SELECT count(*)::int FROM pages
               WHERE index_status = 'indexed' AND NOT excluded_from_index) +
              (SELECT count(*)::int FROM chapters
               WHERE index_status = 'indexed') AS indexed_units,
              (SELECT count(*)::int FROM pages
               WHERE NOT excluded_from_index
                 AND auto_review_status IN ('pending', 'needs_review')) AS pending_review_pages
       FROM documents`);
    const { rows: bySubject } = await pool.query(
      `SELECT subject, count(*)::int AS count
       FROM documents GROUP BY subject ORDER BY count DESC, subject`);
    const { rows: byDocType } = await pool.query(
      `SELECT doc_type, count(*)::int AS count
       FROM documents GROUP BY doc_type ORDER BY count DESC, doc_type`);
    return c.json({
      total_docs: Number(totals.total_docs),
      by_subject: bySubject.map((r) => ({ subject: r.subject, count: Number(r.count) })),
      by_doc_type: byDocType.map((r) => ({ doc_type: r.doc_type, count: Number(r.count) })),
      indexed_units: Number(totals.indexed_units),
      pending_review_pages: Number(totals.pending_review_pages),
    });
  });

  app.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ error: "q 不能为空" }, 422);
    const docId = c.req.query("doc_id");
    const filters: Record<string, string> = {};
    if (docId) filters.doc_id = docId;
    return c.json({ hits: await deps.search(q, filters) });
  });

  app.delete("/:id", async (c) => {
    try {
      const { rowCount } = await pool.query("DELETE FROM documents WHERE id=$1", [c.req.param("id")]);
      if (!rowCount) return c.json({ error: "文档不存在" }, 404);
      return c.body(null, 204);
    } catch (err) {
      if ((err as { code?: string }).code === "22P02") return c.json({ error: "id 格式非法" }, 422);
      throw err;
    }
  });

  app.post("/:id/reindex", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.type || !body?.id) return c.json({ error: "type/id 必填" }, 422);
    try {
      const resp = await fetch(`${deps.pipelineUrl}/internal/reindex`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: c.req.param("id"), type: body.type, id: body.id }),
      });
      return c.json(await resp.json(), resp.status as 200);
    } catch {
      return c.json({ error: "pipeline 不可达" }, 502);
    }
  });

  app.post("/:id/approve", async (c) => {
    try {
      const resp = await fetch(`${deps.pipelineUrl}/internal/approve-doc`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: c.req.param("id") }),
      });
      return c.json(await resp.json(), resp.status as 200);
    } catch {
      return c.json({ error: "pipeline 不可达" }, 502);
    }
  });

  app.post("/pages/:pageId/exclusion", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.excluded !== "boolean") return c.json({ error: "excluded 必须为 boolean" }, 422);
    try {
      const resp = await fetch(`${deps.pipelineUrl}/internal/page-exclusion`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_id: c.req.param("pageId"), excluded: body.excluded }),
      });
      return c.json(await resp.json(), resp.status as 200);
    } catch {
      return c.json({ error: "pipeline 不可达" }, 502);
    }
  });

  app.get("/:id/chunks", async (c) => {
    try {
      const p = pagination(c.req.query());
      const params: unknown[] = [c.req.param("id"), p.pageSize, p.offset];
      const { rows } = await pool.query(
        `SELECT c.id::text,
                row_number() OVER (ORDER BY c.page_no NULLS LAST, c.seg_no NULLS LAST, c.created_at)::int AS seq,
                c.page_no, c.seg_no, left(c.content_md, 240) AS content_preview,
                c.source_block_ids::text[], c.item_id::text, c.chapter_id::text, c.created_at,
                count(*) OVER()::int AS total_count
         FROM chunks c
         WHERE c.document_id=$1
         ORDER BY c.page_no NULLS LAST, c.seg_no NULLS LAST, c.created_at
         LIMIT $2 OFFSET $3`, params);
      const total = rows[0] ? Number(rows[0].total_count) : 0;
      return c.json({
        chunks: rows.map(({ total_count: _total, ...chunk }) => chunk),
        pagination: {
          page: p.page, pageSize: p.pageSize, total,
          totalPages: Math.ceil(total / p.pageSize),
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "22P02") return c.json({ error: "id 格式非法" }, 422);
      if (err instanceof Error && /page|pageSize/.test(err.message)) return c.json({ error: err.message }, 422);
      throw err;
    }
  });

  app.get("/:id/content", async (c) => {
    try {
      const { rows: [doc] } = await pool.query(
        `SELECT id::text, title,
                CASE WHEN lower(source_path) LIKE '%.pdf' THEN 'pdf' ELSE 'text' END AS kind
         FROM documents WHERE id=$1`, [c.req.param("id")]);
      if (!doc) return c.json({ error: "文档不存在" }, 404);
      if (doc.kind === "pdf") {
        const { rows } = await pool.query(
          `SELECT p.page_no, p.adopted_source, p.page_md,
                  (SELECT string_agg(b.content_md, E'\n\n' ORDER BY b.ordinal)
                   FROM blocks b
                   WHERE b.page_id = p.id AND b.content_md IS NOT NULL
                     AND b.block_type NOT IN ('header','footer')) AS blocks_md
           FROM pages p WHERE p.document_id=$1 ORDER BY p.page_no`, [doc.id]);
        return c.json({
          id: doc.id, title: doc.title, unit_type: "pages",
          sections: rows.map((row) => ({
            page_no: row.page_no,
            content_md: (row.adopted_source === "page_md" && row.page_md)
              ? row.page_md : (row.blocks_md ?? ""),
          })),
        });
      }
      const { rows } = await pool.query(
        `SELECT chapter_no, title, content_md FROM chapters
         WHERE document_id=$1 ORDER BY chapter_no`, [doc.id]);
      return c.json({
        id: doc.id, title: doc.title, unit_type: "chapters",
        sections: rows.map((row) => ({
          chapter_no: row.chapter_no, title: row.title, content_md: row.content_md ?? "",
        })),
      });
    } catch (err) {
      if ((err as { code?: string }).code === "22P02") {
        return c.json({ error: "id 格式非法" }, 422);
      }
      throw err;
    }
  });

  app.get("/:id", async (c) => {
    try {
      const p = pagination(c.req.query());
      const { rows: [stat] } = await pool.query(
        `WITH stats AS (${DOCUMENT_STATS_SQL}) SELECT * FROM stats WHERE id=$1`, [c.req.param("id")]);
      if (!stat) return c.json({ error: "文档不存在" }, 404);
      const doc = {
        ...stat,
        total_pages: Number(stat.total_pages),
        total_chapters: Number(stat.total_chapters),
        pages_parsed: Number(stat.pages_parsed),
        pages_failed: Number(stat.pages_failed),
      };
      const aggregates = counts(stat);
      if (stat.file_type === "pdf") {
        const { rows: pages } = await pool.query(
          `SELECT p.id::text, p.page_no, p.parse_status,
                  p.auto_review_status, p.manual_review_status, p.index_status,
                  p.excluded_from_index, p.index_error,
                  coalesce(bc.block_count, 0)::int AS block_count,
                  coalesce(cc.chunk_count, 0)::int AS chunk_count,
                  '/api/review/pages/' || p.id::text || '/image' AS thumbnail_url
           FROM pages p
           LEFT JOIN LATERAL (
             SELECT count(*) AS block_count FROM blocks b WHERE b.page_id = p.id
           ) bc ON true
           LEFT JOIN LATERAL (
             SELECT count(*) AS chunk_count FROM chunks c
             WHERE c.document_id = p.document_id AND (
               c.page_no = p.page_no OR
               c.source_block_ids && ARRAY(SELECT b.id FROM blocks b WHERE b.page_id = p.id)
             )
           ) cc ON true
           WHERE p.document_id=$1 ORDER BY p.page_no LIMIT $2 OFFSET $3`,
          [stat.id, p.pageSize, p.offset]);
        return c.json({
          ...doc, unit_type: "pages", pages, aggregates,
          pagination: {
            page: p.page, pageSize: p.pageSize, total: doc.total_pages,
            totalPages: Math.ceil(doc.total_pages / p.pageSize),
          },
        });
      }
      const { rows: chapters } = await pool.query(
        `SELECT ch.id::text, ch.chapter_no, ch.title,
                left(ch.content_md, 240) AS content_preview,
                ch.auto_review_status, ch.manual_review_status, ch.index_status,
                coalesce(cc.chunk_count, 0)::int AS chunk_count
         FROM chapters ch
         LEFT JOIN LATERAL (
           SELECT count(*) AS chunk_count FROM chunks c WHERE c.chapter_id = ch.id
         ) cc ON true
         WHERE ch.document_id=$1 ORDER BY ch.chapter_no LIMIT $2 OFFSET $3`,
        [stat.id, p.pageSize, p.offset]);
      return c.json({
        ...doc, unit_type: "chapters", chapters, aggregates,
        pagination: {
          page: p.page, pageSize: p.pageSize, total: doc.total_chapters,
          totalPages: Math.ceil(doc.total_chapters / p.pageSize),
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "22P02") return c.json({ error: "id 格式非法" }, 422);
      if (err instanceof Error && /page|pageSize/.test(err.message)) return c.json({ error: err.message }, 422);
      throw err;
    }
  });

  return app;
}
