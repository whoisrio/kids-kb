/** 资料 API：旧静态复核页的 React 化。读路径直连 PostgreSQL，图片从 storageRoot 读盘回传。
    设计：docs/superpowers/specs/2026-09-05-phase3-c-design.md（Workstream B） */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import type pg from "pg";
import type { SearchHit } from "../retrieval/search.js";
import { resolveStoragePath } from "../storagePath.js";

export interface ReviewDeps {
  search: (q: string, filters?: Record<string, string>) => Promise<SearchHit[]>;
  pipelineUrl: string;
  storageRoot: string;
}

function invalidId(c: Context, err: unknown): Response | null {
  return (err as { code?: string })?.code === "22P02"
    ? c.json({ error: "id 格式非法（须为 UUID）" }, 422)
    : null;
}

export function reviewRoutes(pool: pg.Pool, deps: ReviewDeps): Hono {
  const app = new Hono({ strict: false });

  app.get("/docs", async (c) => {
    const { rows } = await pool.query(
      `SELECT d.id::text, d.title, d.subject, d.doc_type, d.parse_status, d.struct_mode,
              count(p.id) FILTER (WHERE coalesce(pr.n, 0) > 0)::int AS pending_pages
       FROM documents d
       LEFT JOIN pages p ON p.document_id = d.id
       LEFT JOIN LATERAL (
         SELECT count(*) AS n FROM review_queue r
         WHERE r.status = 'pending' AND (
           r.page_id = p.id OR r.block_id IN (SELECT id FROM blocks WHERE page_id = p.id))
       ) pr ON true
       GROUP BY d.id ORDER BY d.created_at DESC`);
    return c.json(rows);
  });

  app.get("/pages", async (c) => {
    const status = c.req.query("status") ?? "pending";
    if (status !== "pending" && status !== "approved") {
      return c.json({ error: "status 取值: pending|approved" }, 422);
    }
    const docId = c.req.query("doc_id");
    const having = status === "pending" ? "coalesce(pr.n, 0) > 0" : "coalesce(pr.n, 0) = 0";
    const params: unknown[] = [];
    let docFilter = "";
    if (docId) { docFilter = "AND p.document_id = $1::uuid"; params.push(docId); }
    const { rows } = await pool.query(
      `SELECT p.id::text, p.page_no, d.title AS doc_title, pr.reasons
       FROM pages p
       JOIN documents d ON d.id = p.document_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS n, array_agg(r.reason ORDER BY r.created_at) AS reasons
         FROM review_queue r
         WHERE r.status = 'pending' AND (
           r.page_id = p.id OR r.block_id IN (SELECT id FROM blocks WHERE page_id = p.id))
       ) pr ON true
       WHERE p.parse_status = 'parsed' ${docFilter} AND ${having}
       ORDER BY d.title, p.page_no`, params);
    return c.json({ pages: rows.map((r) => ({ ...r, pending_reasons: r.reasons ?? [] })) });
  });

  app.get("/pages/:id", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
      `SELECT p.id::text, p.page_no, d.title AS doc_title, p.page_md, p.page_md_model, p.adopted_source,
              p.review_status, p.index_status, p.auto_review_status, p.manual_review_status,
              p.excluded_from_index, p.index_error,
              p.parse_status, p.document_id::text AS doc_id, d.struct_mode
         FROM pages p JOIN documents d ON d.id = p.document_id WHERE p.id = $1`,
        [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      const { rows: blocks } = await pool.query(
        `SELECT id::text, block_type, bbox, content_md, source_model,
                origin, block_type_origin, geometry_revision, crop_pad, title_level
         FROM blocks WHERE page_id = $1 ORDER BY ordinal`, [page.id]);
      const blocksWithCrop = blocks.map((b) => ({ ...b, crop_url: `/api/review/blocks/${b.id}/crop` }));
      const blockIds = blocks.map((b) => b.id);
      const { rows: annotations } = blockIds.length ? await pool.query(
        `SELECT id::text, block_id::text, author, body, created_at, updated_at
         FROM block_annotations WHERE block_id = ANY($1::uuid[]) ORDER BY created_at`, [blockIds]) : { rows: [] };
      const { rows: itemMappings } = await pool.query(
        `SELECT ib.block_id::text, i.id::text, i.label, i.content_type, ib.role,
                i.content_md, i.qc_status, i.paired_item_id::text
         FROM item_blocks ib
        JOIN items i ON i.id = ib.item_id
        JOIN blocks b ON b.id = ib.block_id
        WHERE ib.block_id = ANY($1::uuid[])
        ORDER BY b.ordinal, i.created_at`, [blockIds]);
      const itemsByBlock = new Map<string, { id: string; label: string | null; content_type: string; role: string; content_md: string | null; qc_status: string }[]>();
      for (const m of itemMappings) {
        if (!itemsByBlock.has(m.block_id)) itemsByBlock.set(m.block_id, []);
        itemsByBlock.get(m.block_id)!.push({ id: m.id, label: m.label, content_type: m.content_type, role: m.role, content_md: m.content_md, qc_status: m.qc_status });
      }
      const itemParts = new Map<string, {
        id: string; label: string | null; content_type: string;
        content_md: string | null; qc_status: string;
        block_ids: string[]; block_crops: string[];
      }>();
      for (const m of itemMappings) {
        const part = itemParts.get(m.id) ?? {
          id: m.id, label: m.label, content_type: m.content_type,
          content_md: m.content_md, qc_status: m.qc_status,
          block_ids: [] as string[], block_crops: [] as string[],
        };
        part.block_ids.push(m.block_id);
        part.block_crops.push(`/api/review/blocks/${m.block_id}/crop`);
        itemParts.set(m.id, part);
      }
      const questionIds = [...itemParts.values()]
        .filter((item) => item.content_type !== "answer")
        .map((item) => item.id);
      const { rows: pairedAnswerRows } = questionIds.length ? await pool.query(
        `SELECT a.paired_item_id::text AS question_id, a.id::text, a.content_md, a.qc_status,
                ib.block_id::text
         FROM items a
         LEFT JOIN item_blocks ib ON ib.item_id = a.id
         LEFT JOIN blocks b ON b.id = ib.block_id
         LEFT JOIN pages p ON p.id = b.page_id
         WHERE a.content_type = 'answer' AND a.paired_item_id = ANY($1::uuid[])
           AND (ib.block_id IS NULL OR p.id = $2)
         ORDER BY a.created_at, b.ordinal`, [questionIds, page.id]) : { rows: [] as {
          question_id: string; id: string; content_md: string | null;
          qc_status: string; block_id: string | null;
        }[] };
      const pairedAnswers = new Map<string, {
        id: string; content_md: string | null; qc_status: string;
        block_ids: string[]; block_crops: string[];
      }>();
      for (const row of pairedAnswerRows) {
        const answer = pairedAnswers.get(row.question_id) ?? {
          id: row.id, content_md: row.content_md, qc_status: row.qc_status,
          block_ids: [] as string[], block_crops: [] as string[],
        };
        if (row.block_id) {
          answer.block_ids.push(row.block_id);
          answer.block_crops.push(`/api/review/blocks/${row.block_id}/crop`);
        }
        pairedAnswers.set(row.question_id, answer);
      }
      const shownAnswerIds = new Set<string>();
      const questions = [...itemParts.values()]
        .filter((item) => item.content_type !== "answer")
        .map((item) => {
          const answer = pairedAnswers.get(item.id) ?? null;
          if (answer) shownAnswerIds.add(answer.id);
          return { ...item, answer };
        });
      for (const item of itemParts.values()) {
        if (item.content_type === "answer" && !shownAnswerIds.has(item.id)) {
          questions.push({ ...item, answer: null });
        }
      }
      const { rows: pendingRows } = await pool.query(
        `SELECT r.id::text, r.reason, r.block_id::text
         FROM review_queue r LEFT JOIN blocks b ON b.id = r.block_id
         WHERE r.status = 'pending' AND (r.page_id = $1 OR b.page_id = $1)
         ORDER BY r.created_at`, [page.id]);
      const byBlock = new Map<string, { id: string; reason: string }[]>();
      const pagePending: { id: string; reason: string }[] = [];
      for (const r of pendingRows) {
        if (r.block_id) (byBlock.get(r.block_id) ?? byBlock.set(r.block_id, []).get(r.block_id)!).push({ id: r.id, reason: r.reason });
        else pagePending.push({ id: r.id, reason: r.reason });
      }
      // 采用口径的整页 markdown（选块口径与 pipeline flat.page_contents 一致）：
      // adopted=page_md 用整页稿，否则按 ordinal 拼块文本、跳 header/footer。
      // 块间空行成段（单 \n 在 Markdown 里是段内软换行，整页稿会糊成一坨）。
      // title 块按 title_level 加 Markdown 标题前缀；NULL（未送判）按二级处理。
      const HEADING_PREFIX: Record<number, string> = { 1: "# ", 2: "## ", 3: "### " };
      const contentMd = page.adopted_source === "page_md" && page.page_md
        ? page.page_md
        : blocks
            .filter((b) => b.block_type !== "header" && b.block_type !== "footer" && b.content_md !== null)
            .map((b) => (b.block_type === "title"
              ? (HEADING_PREFIX[b.title_level as number] ?? HEADING_PREFIX[2]) + (b.content_md as string)
              : b.content_md) as string)
            .join("\n\n");
      return c.json({
        id: page.id, page_no: page.page_no, doc_title: page.doc_title,
        doc_id: page.doc_id, struct_mode: page.struct_mode, parse_status: page.parse_status,
        image_url: `/api/review/pages/${page.id}/image`,
        page_md: page.page_md, page_md_model: page.page_md_model,
        adopted_source: page.adopted_source, content_md: contentMd,
        blocks: blocksWithCrop.map((b) => ({
          ...b,
          pending: byBlock.get(b.id) ?? [],
          items: itemsByBlock.get(b.id) ?? [],
          annotations: annotations.filter((a) => a.block_id === b.id),
        })),
        review_status: page.review_status,
        auto_review_status: page.auto_review_status,
        manual_review_status: page.manual_review_status,
        excluded_from_index: page.excluded_from_index,
        index_status: page.index_status,
        index_error: page.index_error,
        page_pending: pagePending,
        questions,
      });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.get("/pages/:id/image", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
        "SELECT image_path FROM pages WHERE id = $1", [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      try {
        const buf = await readFile(resolveStoragePath(deps.storageRoot, page.image_path));
        return c.body(new Uint8Array(buf), 200, { "Content-Type": "image/png" });
      } catch {
        return c.json({ error: "页图缺失" }, 404);
      }
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.get("/blocks/:id/crop", async (c) => {
    try {
      const { rows: [block] } = await pool.query(
        "SELECT crop_path FROM blocks WHERE id = $1", [c.req.param("id")]);
      if (!block) return c.json({ error: "block 不存在" }, 404);
      try {
        const buf = await readFile(resolveStoragePath(deps.storageRoot, block.crop_path));
        return c.body(new Uint8Array(buf), 200, { "Content-Type": "image/png" });
      } catch {
        return c.json({ error: "裁图缺失" }, 404);
      }
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.get("/chapters", async (c) => {
    const docId = c.req.query("doc_id");
    const params: unknown[] = [];
    let where = "";
    if (docId) {
      where = "WHERE c.document_id = $1::uuid";
      params.push(docId);
    }
    const { rows } = await pool.query(
      `SELECT c.id::text, c.document_id::text, d.title AS doc_title,
              c.chapter_no, c.title, c.content_md
       FROM chapters c JOIN documents d ON d.id = c.document_id
       ${where} ORDER BY d.title, c.chapter_no`,
      params,
    );
    return c.json({ chapters: rows });
  });

  app.get("/items", async (c) => {
    const docId = c.req.query("doc_id");
    const status = c.req.query("status");
    if (status !== undefined && status !== "pending") {
      return c.json({ error: "status 取值: pending" }, 422);
    }
    const params: unknown[] = [];
    let where = "";
    if (docId) { where = "WHERE i.document_id = $1::uuid"; params.push(docId); }
    if (status === "pending") {
      where += (where ? " AND " : "WHERE ") +
        "(i.qc_status = 'pending' OR pr.reasons IS NOT NULL)";
    }
    const { rows } = await pool.query(
      `SELECT i.id::text, i.content_type, i.label, i.chapter, i.qc_status, d.title AS doc_title,
              pr.reasons, i.content_md, i.source_model
       FROM items i
       JOIN documents d ON d.id = i.document_id
       LEFT JOIN LATERAL (
         SELECT array_agg(r.reason ORDER BY r.created_at) AS reasons
         FROM review_queue r WHERE r.item_id = i.id AND r.status = 'pending'
       ) pr ON true
       ${where} ORDER BY d.title, i.chapter, i.created_at`, params);
    return c.json({ items: rows.map((r) => ({ ...r, pending_reasons: r.reasons ?? [] })) });
  });

  app.get("/items/:id", async (c) => {
    try {
      const { rows: [item] } = await pool.query(
        `SELECT i.id::text, i.content_type, i.label, i.chapter, i.qc_status, i.content_md,
                i.taxonomy, i.tags, d.title AS doc_title, i.source_model
         FROM items i JOIN documents d ON d.id = i.document_id WHERE i.id = $1`,
        [c.req.param("id")]);
      if (!item) return c.json({ error: "item 不存在" }, 404);
      const { rows: blocks } = await pool.query(
        `SELECT b.id::text, ib.role, b.block_type, b.content_md, b.source_model
         FROM item_blocks ib JOIN blocks b ON b.id = ib.block_id
         WHERE ib.item_id = $1 ORDER BY b.ordinal`, [item.id]);
      const { rows: reviews } = await pool.query(
        "SELECT id::text, reason, status FROM review_queue WHERE item_id = $1 ORDER BY created_at",
        [item.id]);
      return c.json({
        ...item,
        blocks: blocks.map((b) => ({ ...b, crop_url: `/api/review/blocks/${b.id}/crop` })),
        reviews,
      });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ error: "q 不能为空" }, 422);
    const subject = c.req.query("subject");
    const filters = subject ? { subject } : undefined;
    return c.json({ hits: await deps.search(q, filters) });
  });

  async function readJson(c: Context): Promise<Record<string, unknown> | null> {
    try { return await c.req.json(); } catch { return null; }
  }

  app.patch("/blocks/:id", async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
    if (typeof body.content_md !== "string") return c.json({ error: "content_md 必填" }, 422);
    try {
      const { rows: [before] } = await pool.query(
        "SELECT content_md FROM blocks WHERE id=$1", [c.req.param("id")]);
      if (!before) return c.json({ error: "block 不存在" }, 404);
      const { rows: [b] } = await pool.query(
        "UPDATE blocks SET content_md=$2 WHERE id=$1 RETURNING id::text, content_md",
        [c.req.param("id"), body.content_md]);
      if (!b) return c.json({ error: "block 不存在" }, 404);
      const { rows: [page] } = await pool.query(
        `SELECT p.id::text, p.document_id::text, p.page_no
         FROM pages p WHERE p.id=(SELECT page_id FROM blocks WHERE id=$1)`, [c.req.param("id")]);
      if (page) {
        await pool.query("UPDATE pages SET index_status='stale', index_error=NULL WHERE id=$1", [page.id]);
        await pool.query(
        `DELETE FROM chunks WHERE document_id=$1 AND (
           source_block_ids && ARRAY[$2::uuid] OR page_no=$3)`,
          [page.document_id, c.req.param("id"), page.page_no]);
        await pool.query(
          `INSERT INTO pipeline_events
             (run_id, document_id, page_id, stage, event_type, summary, payload, actor)
           VALUES (gen_random_uuid(), $1, $2, 'user_edit', 'edit', $3, $4, 'user')`,
          [page.document_id, page.id, "编辑块内容",
           JSON.stringify({ field: "content_md", old: before.content_md, new: body.content_md })]);
      }
      return c.json(b);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/blocks/merge", async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
    const blockIds = Array.isArray(body.block_ids) ? body.block_ids : [];
    if (blockIds.length < 2 || blockIds.some((id) => typeof id !== "string")) {
      return c.json({ error: "至少两块才能合并" }, 422);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: blocks } = await client.query(
        `SELECT id::text, page_id::text, bbox, content_md, ordinal
         FROM blocks WHERE id = ANY($1::uuid[]) ORDER BY ordinal`, [blockIds]);
      if (blocks.length !== blockIds.length) {
        await client.query("ROLLBACK");
        return c.json({ error: "块不存在" }, 404);
      }
      if (new Set(blocks.map((block) => block.page_id)).size !== 1) {
        await client.query("ROLLBACK");
        return c.json({ error: "只能合并同页的块" }, 422);
      }
      const orderedIds = blocks.map((block) => block.id);
      const newId = crypto.randomUUID();
      const bbox = [
        Math.min(...blocks.map((block) => block.bbox[0])),
        Math.min(...blocks.map((block) => block.bbox[1])),
        Math.max(...blocks.map((block) => block.bbox[2])),
        Math.max(...blocks.map((block) => block.bbox[3])),
      ];
      const content = blocks.map((block) => block.content_md ?? "").filter(Boolean).join("\n\n");
      await client.query(
        `INSERT INTO blocks
           (id, page_id, block_type, bbox, crop_path, content_md, ordinal, origin, parent_block_ids)
         VALUES ($1, $2, 'text', $3,
           (SELECT crop_path FROM blocks WHERE id = $4), $5, $6, 'merged', $7::uuid[])`,
        [newId, blocks[0].page_id, JSON.stringify(bbox), blocks[0].id, content,
          blocks[0].ordinal, orderedIds]);
      await client.query(
        `DELETE FROM item_blocks a USING item_blocks b
         WHERE a.block_id = ANY($1::uuid[]) AND b.block_id = ANY($1::uuid[])
           AND a.item_id = b.item_id AND a.role = b.role AND a.ctid < b.ctid`, [orderedIds]);
      await client.query(
        "UPDATE item_blocks SET block_id=$2 WHERE block_id = ANY($1::uuid[])", [orderedIds, newId]);
      await client.query(
        `UPDATE chunks SET source_block_ids = (
           SELECT array_agg(DISTINCT x)
           FROM unnest(
             (SELECT array_agg(y) FROM unnest(source_block_ids) y WHERE y <> ALL($1::uuid[]))
             || $2::uuid
           ) x), state = 'stale'
         WHERE source_block_ids && $1::uuid[]`, [orderedIds, newId]);
      await client.query("DELETE FROM blocks WHERE id = ANY($1::uuid[])", [orderedIds]);
      await client.query(
        "UPDATE pages SET index_status='stale', index_error=NULL WHERE id=$1", [blocks[0].page_id]);
      await client.query(
        `INSERT INTO pipeline_events (run_id, document_id, page_id, stage, event_type, actor, summary, payload, status)
         SELECT gen_random_uuid(), document_id, id, 'user_edit', 'block_merge', 'user', $2, $3, 'ok'
         FROM pages WHERE id=$1`,
        [blocks[0].page_id, `合并 ${blockIds.length} 块 → ${newId.slice(0, 8)}`,
          JSON.stringify({ merged: orderedIds, into: newId, content })]);
      await client.query("COMMIT");
      fetch(`${deps.pipelineUrl}/internal/block-recrop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ block_id: newId }),
      }).catch((err) => console.warn("合并块重裁失败（可忽略，裁图滞后）", err));
      return c.json({ id: newId });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return invalidId(c, err) ?? (() => { throw err; })();
    } finally {
      client.release();
    }
  });

  app.post("/blocks/:id/split", async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [block] } = await client.query(
        `SELECT id::text, page_id::text, bbox, content_md, ordinal, block_type
         FROM blocks WHERE id=$1`, [c.req.param("id")]);
      if (!block) {
        await client.query("ROLLBACK");
        return c.json({ error: "块不存在" }, 404);
      }
      const lines = (block.content_md ?? "").split("\n");
      const lineIndex = body.line_index;
      if (typeof lineIndex !== "number" || !Number.isInteger(lineIndex) || lineIndex < 1 || lineIndex > lines.length - 1) {
        await client.query("ROLLBACK");
        return c.json({ error: `line_index 须在 1..${lines.length - 1}` }, 422);
      }
      const [x0, y0, x1, y1] = block.bbox;
      // 行比例近似切 bbox：UI 不掌握行级 y 坐标（spec §6.2 的可用近似）。
      const ySplit = Math.round(y0 + (y1 - y0) * lineIndex / lines.length);
      const firstId = crypto.randomUUID();
      const secondId = crypto.randomUUID();
      await client.query(
        "UPDATE blocks SET ordinal=ordinal+1 WHERE page_id=$1 AND ordinal>$2",
        [block.page_id, block.ordinal]);
      const insertHalf = async (id: string, content: string, bbox: number[], ordinal: number) =>
        client.query(
          `INSERT INTO blocks (id, page_id, block_type, bbox, crop_path, content_md, ordinal, origin, parent_block_ids)
           SELECT $1, page_id, block_type, $2, crop_path, $3, $4, 'split', ARRAY[$5::uuid]
           FROM blocks WHERE id=$5`,
          [id, JSON.stringify(bbox), content, ordinal, block.id]);
      await insertHalf(firstId, lines.slice(0, lineIndex).join("\n"),
        [x0, y0, x1, ySplit], block.ordinal);
      await insertHalf(secondId, lines.slice(lineIndex).join("\n"),
        [x0, ySplit, x1, y1], block.ordinal + 1);
      const { rows: links } = await client.query(
        `SELECT ib.item_id::text, ib.role, i.content_md FROM item_blocks ib
         JOIN items i ON i.id = ib.item_id WHERE ib.block_id=$1`, [block.id]);
      const normalize = (value: string) => value.replace(/\s+/g, "");
      const firstText = normalize(lines.slice(0, lineIndex).join(""));
      const secondText = normalize(lines.slice(lineIndex).join(""));
      for (const link of links) {
        const text = normalize(link.content_md ?? "");
        const inFirst = text.length > 0 && firstText.includes(text);
        const inSecond = text.length > 0 && secondText.includes(text);
        const targets = inFirst && !inSecond ? [firstId]
          : inSecond && !inFirst ? [secondId]
          : [firstId, secondId];
        await client.query(
          "DELETE FROM item_blocks WHERE item_id=$1 AND block_id=$2 AND role=$3",
          [link.item_id, block.id, link.role]);
        for (const target of targets) {
          await client.query(
            `INSERT INTO item_blocks (item_id, block_id, role) VALUES ($1,$2,$3)
             ON CONFLICT DO NOTHING`, [link.item_id, target, link.role]);
        }
      }
      await client.query(
        `UPDATE chunks SET source_block_ids =
           array_remove(source_block_ids, $1::uuid) || $2::uuid || $3::uuid,
           state='stale'
         WHERE source_block_ids && ARRAY[$1::uuid]`, [block.id, firstId, secondId]);
      await client.query("DELETE FROM blocks WHERE id=$1", [block.id]);
      await client.query(
        "UPDATE pages SET index_status='stale', index_error=NULL WHERE id=$1", [block.page_id]);
      await client.query(
        `INSERT INTO pipeline_events (run_id, document_id, page_id, stage, event_type, actor, summary, payload, status)
         SELECT gen_random_uuid(), p.document_id, p.id, 'user_edit', 'block_split', 'user', $2, $3, 'ok'
         FROM pages p WHERE p.id=$1`,
        [block.page_id, `拆分块 ${block.id.slice(0, 8)} 于第 ${lineIndex} 行后`,
          JSON.stringify({ from: block.id, into: [firstId, secondId], line_index: lineIndex })]);
      await client.query("COMMIT");
      for (const id of [firstId, secondId]) {
        fetch(`${deps.pipelineUrl}/internal/block-recrop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ block_id: id }),
        }).catch((err) => console.warn("拆分块重裁失败（可忽略，裁图滞后）", err));
      }
      return c.json({ ids: [firstId, secondId] });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return invalidId(c, err) ?? (() => { throw err; })();
    } finally {
      client.release();
    }
  });

  app.delete("/blocks/:id", async (c) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [block] } = await client.query(
        "SELECT id::text, page_id::text FROM blocks WHERE id=$1", [c.req.param("id")]);
      if (!block) {
        await client.query("ROLLBACK");
        return c.json({ error: "块不存在" }, 404);
      }
      const { rows: [guard] } = await client.query(
        "SELECT count(*)::int AS n FROM review_queue WHERE block_id=$1", [block.id]);
      if (guard.n > 0) {
        await client.query("ROLLBACK");
        return c.json({ error: "该块有复核记录，先处理复核行再删" }, 409);
      }
      await client.query(
        `UPDATE items SET qc_status='needs_review', updated_at=now()
         WHERE id IN (SELECT item_id FROM item_blocks WHERE block_id=$1)`, [block.id]);
      await client.query("DELETE FROM item_blocks WHERE block_id=$1", [block.id]);
      await client.query(
        `UPDATE chunks SET source_block_ids=array_remove(source_block_ids, $1::uuid), state='stale'
         WHERE source_block_ids && ARRAY[$1::uuid]`, [block.id]);
      await client.query("DELETE FROM blocks WHERE id=$1", [block.id]);
      await client.query(
        "UPDATE pages SET index_status='stale', index_error=NULL WHERE id=$1", [block.page_id]);
      await client.query(
        `INSERT INTO pipeline_events (run_id, document_id, page_id, stage, event_type, actor, summary, payload, status)
         SELECT gen_random_uuid(), p.document_id, p.id, 'user_edit', 'block_delete', 'user', $2, $3, 'ok'
         FROM pages p WHERE p.id=$1`,
        [block.page_id, `删除块 ${block.id.slice(0, 8)}`, JSON.stringify({ block_id: block.id })]);
      await client.query("COMMIT");
      return c.json({ ok: true });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return invalidId(c, err) ?? (() => { throw err; })();
    } finally {
      client.release();
    }
  });

  app.patch("/pages/:id", async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
    if (typeof body.page_md !== "string") return c.json({ error: "page_md 必填" }, 422);
    try {
      const { rows: [before] } = await pool.query(
        "SELECT page_md FROM pages WHERE id=$1", [c.req.param("id")]);
      if (!before) return c.json({ error: "page 不存在" }, 404);
      const { rows: [page] } = await pool.query(
        `UPDATE pages SET page_md=$2, index_status='stale', index_error=NULL
         WHERE id=$1 RETURNING id::text, page_no, document_id::text, page_md, index_status`,
        [c.req.param("id"), body.page_md]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      await pool.query(
        `DELETE FROM chunks WHERE document_id=$1 AND (
           page_no=$2 OR source_block_ids && ARRAY(
             SELECT id FROM blocks WHERE page_id=$3))`,
        [page.document_id, page.page_no, page.id]);
      await pool.query(
        `INSERT INTO pipeline_events
           (run_id, document_id, page_id, stage, event_type, summary, payload, actor)
         VALUES (gen_random_uuid(), $1, $2, 'user_edit', 'edit', $3, $4, 'user')`,
        [page.document_id, page.id, "编辑整页稿",
         JSON.stringify({ field: "page_md", old: before.page_md, new: body.page_md })]);
      return c.json(page);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/blocks/:id/annotations", async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
    if (typeof body.body !== "string" || !body.body.trim()) return c.json({ error: "body 必填" }, 422);
    try {
      const { rows: [annotation] } = await pool.query(
        `INSERT INTO block_annotations (block_id, author, body)
         VALUES ($1, $2, $3) RETURNING id::text, block_id::text, author, body, created_at, updated_at`,
        [c.req.param("id"), typeof body.author === "string" && body.author.trim() ? body.author.trim() : "admin", body.body.trim()]);
      if (!annotation) return c.json({ error: "block 不存在" }, 404);
      return c.json(annotation, 201);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.patch("/block-annotations/:id", async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
    if (typeof body.body !== "string" || !body.body.trim()) return c.json({ error: "body 必填" }, 422);
    try {
      const { rows: [annotation] } = await pool.query(
        `UPDATE block_annotations SET body=$2, updated_at=now()
         WHERE id=$1 RETURNING id::text, block_id::text, author, body, created_at, updated_at`,
        [c.req.param("id"), body.body.trim()]);
      if (!annotation) return c.json({ error: "批注不存在" }, 404);
      return c.json(annotation);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.delete("/block-annotations/:id", async (c) => {
    try {
      const { rowCount } = await pool.query("DELETE FROM block_annotations WHERE id=$1", [c.req.param("id")]);
      if (!rowCount) return c.json({ error: "批注不存在" }, 404);
      return c.body(null, 204);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.patch("/items/:id", async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
    if (typeof body.content_md !== "string") return c.json({ error: "content_md 必填" }, 422);
    const id = c.req.param("id");
    try {
      const { rows: [before] } = await pool.query(
        "SELECT content_md, document_id::text FROM items WHERE id=$1", [id]);
      if (!before) return c.json({ error: "item 不存在" }, 404);
      const { rows: [item] } = await pool.query(
        "UPDATE items SET content_md=$2, updated_at=now() WHERE id=$1 RETURNING id::text, content_md",
        [id, body.content_md]);
      await pool.query("DELETE FROM chunks WHERE item_id=$1", [id]);
      await pool.query(
        `INSERT INTO pipeline_events
           (run_id, document_id, item_id, stage, event_type, summary, payload, actor)
         VALUES (gen_random_uuid(), $1, $2, 'user_edit', 'edit', $3, $4, 'user')`,
        [before.document_id, id, "编辑条目内容",
         JSON.stringify({ field: "content_md", old: before.content_md, new: body.content_md })]);
      return c.json(item);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/pages/:id/reject", async (c) => {
    const body = await readJson(c);
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) return c.json({ error: "reason 必填" }, 422);
    try {
      const { rows: [page] } = await pool.query(
        "SELECT id::text FROM pages WHERE id=$1", [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      const { rows: [row] } = await pool.query(
        `INSERT INTO review_queue (page_id, reason) VALUES ($1,$2)
         RETURNING id::text, status`, [page.id, reason]);
      return c.json(row, 201);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/items/:id/reject", async (c) => {
    const body = await readJson(c);
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) return c.json({ error: "reason 必填" }, 422);
    try {
      const { rows: [item] } = await pool.query(
        "SELECT id::text FROM items WHERE id=$1", [c.req.param("id")]);
      if (!item) return c.json({ error: "item 不存在" }, 404);
      const { rows: [row] } = await pool.query(
        `INSERT INTO review_queue (item_id, reason) VALUES ($1,$2)
         RETURNING id::text, status`, [item.id, reason]);
      return c.json(row, 201);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/pages/:id/adopt", async (c) => {
    const body = await readJson(c);
    const source = body?.source;
    if (source !== "blocks" && source !== "page_md") {
      return c.json({ error: "source 取值: blocks|page_md" }, 422);
    }
    try {
      const { rows: [page] } = await pool.query(
        `SELECT id::text, page_no, document_id::text, page_md, adopted_source
         FROM pages WHERE id=$1`, [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      if (source === "page_md" && !page.page_md) {
        return c.json({ error: "该页还没有整页转录" }, 409);
      }
      // 采用来源变化 = 页内容变化：与编辑同口径置索引过期、清 chunks、记事件；同源不动。
      if (page.adopted_source !== source) {
        await pool.query(
          "UPDATE pages SET adopted_source=$2, index_status='stale', index_error=NULL WHERE id=$1",
          [page.id, source]);
        await pool.query(
          `DELETE FROM chunks WHERE document_id=$1 AND (
             page_no=$2 OR source_block_ids && ARRAY(
               SELECT id FROM blocks WHERE page_id=$3))`,
          [page.document_id, page.page_no, page.id]);
        await pool.query(
          `INSERT INTO pipeline_events
             (run_id, document_id, page_id, stage, event_type, summary, payload, actor)
           VALUES (gen_random_uuid(), $1, $2, 'user_edit', 'adopt', $3, $4, 'user')`,
          [page.document_id, page.id, `采用来源切换：${page.adopted_source} → ${source}`,
           JSON.stringify({ from: page.adopted_source, to: source })]);
      }
      return c.json({ page_id: page.id, adopted_source: source });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  async function forwardInternal(c: Context, path: string, body?: unknown): Promise<Response> {
    try {
      const resp = await fetch(`${deps.pipelineUrl}${path}`, {
        method: "POST",
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await resp.text();
      return new Response(text.length ? text : null, {
        status: resp.status,
        headers: { "Content-Type": resp.headers.get("content-type") ?? "application/json" },
      });
    } catch (err) {
      console.error("pipeline internal 调用失败", path, err);
      return c.json({ error: "内部服务不可达" }, 502);
    }
  }

  app.post("/blocks/:id/geometry-preview", async (c) => {
    const body = await readJson(c);
    return forwardInternal(c, "/internal/block-geometry-preview", {
      block_id: c.req.param("id"),
      ...(body ?? {}),
    });
  });

  app.post("/blocks/:id/geometry-commit", async (c) => {
    const body = await readJson(c);
    return forwardInternal(c, "/internal/block-geometry-commit", {
      block_id: c.req.param("id"),
      ...(body ?? {}),
    });
  });

  app.post("/pages/:id/blocks", async (c) => {
    const body = await readJson(c);
    return forwardInternal(c, "/internal/block-create", {
      page_id: c.req.param("id"),
      ...(body ?? {}),
    });
  });

  app.post("/pages/:id/approve", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
        `SELECT p.id::text, p.page_no, d.id::text AS doc_id, d.struct_mode
         FROM pages p JOIN documents d ON d.id = p.document_id WHERE p.id = $1`,
        [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      const { rows: closed } = await pool.query(
        `UPDATE review_queue SET status='approved' WHERE status='pending' AND (
           page_id=$1 OR block_id IN (SELECT id FROM blocks WHERE page_id=$1))
         RETURNING id`, [page.id]);
      // 复核阶段收口：与 pipeline approve_flat_pages 同口径置页级复核状态
      await pool.query(
        "UPDATE pages SET review_status='approved', manual_review_status='approved' WHERE id=$1",
        [page.id]);
      if (page.struct_mode === "flat") {
        try {
          const resp = await fetch(`${deps.pipelineUrl}/internal/embed-flat-page`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ doc_id: page.doc_id, page_no: page.page_no }),
          });
          if (!resp.ok) throw new Error(await resp.text());
          const { chunks } = await resp.json() as { chunks: number };
          await pool.query(
            "UPDATE pages SET index_status='indexed', index_error=NULL WHERE id=$1", [page.id]);
          return c.json({ id: page.id, resolved: closed.length, embedded: chunks });
        } catch (err) {
          console.error("flat 页向量化失败", err);
          await pool.query("UPDATE pages SET index_error=$2 WHERE id=$1",
            [page.id, err instanceof Error ? err.message : String(err)]);
          return c.json({ id: page.id, resolved: closed.length, embed_error: "向量化失败，可重新通过该页重试" });
        }
      }
      return c.json({ id: page.id, resolved: closed.length });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/items/:id/approve", async (c) => {
    try {
      const { rows: [item] } = await pool.query(
        "SELECT id::text FROM items WHERE id=$1", [c.req.param("id")]);
      if (!item) return c.json({ error: "item 不存在" }, 404);
      return forwardInternal(c, `/internal/approve-item?item_id=${encodeURIComponent(item.id)}`);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/pages/:id/page-vlm", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
        "SELECT id::text FROM pages WHERE id=$1", [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      return forwardInternal(c, "/internal/page-vlm", { page_id: page.id });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/pages/:id/index-preview", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
        "SELECT id::text FROM pages WHERE id=$1", [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      return forwardInternal(c, "/internal/index-preview", { page_id: page.id });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  return app;
}
