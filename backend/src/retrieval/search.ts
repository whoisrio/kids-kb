/** 双路召回:向量(pgvector)+ BM25(内存)→ RRF k=60 融合 → 同章抑制 → 可选重排。
    chunks 有两类单元:条目(item_id)与章节分段(chapter_id,docx/md 未拆条内容的检索底座)。
    行为对齐 pipeline/kb/rag/embed.py 的 search(mode='hybrid')。 */
import type pg from "pg";
import { bm25Score } from "./bm25.js";

export interface SearchHit {
  item_id: string | null;
  chapter_id?: string | null;
  document_id: string;
  content_md: string;
  score: number;
  rerank_score?: number;
  /** 向量余弦(该条目所有 chunk 的最大值);仅 BM25 命中的条目无此字段。 */
  vec_score?: number;
  [k: string]: unknown;  // meta 展开（label/chapter/subject/doc_title 等）
}

export interface SearchDeps {
  embed: (texts: string[]) => Promise<number[][]>;
  rerank: ((query: string, docs: string[]) => Promise<number[]>) | null;
}

interface ChunkRow {
  item_id: string | null;
  chapter_id: string | null;
  document_id: string;
  content_md: string;
  meta: Record<string, unknown>;
  score?: number;
}

async function vectorHits(
  pool: pg.Pool, vec: number[], topN: number, itemsOnly: boolean, subject: string | undefined,
): Promise<ChunkRow[]> {
  const conds = [itemsOnly && "c.item_id IS NOT NULL", subject && "c.meta->>'subject' = $3"]
    .filter(Boolean) as string[];
  const params: unknown[] = [`[${vec.join(",")}]`, topN];
  if (subject) params.push(subject);
  const { rows } = await pool.query(
    `SELECT c.item_id::text, c.chapter_id::text, c.document_id::text, c.content_md, c.meta,
            1 - (c.embedding <=> $1::vector) AS score
     FROM chunks c ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
     ORDER BY c.embedding <=> $1::vector LIMIT $2`,
    params,
  );
  return rows;
}

function toHit(r: ChunkRow): SearchHit {
  return {
    item_id: r.item_id, chapter_id: r.chapter_id, document_id: r.document_id,
    content_md: r.content_md, score: r.score ?? 0, ...r.meta,
  };
}

/** 同章已有条目级命中时,抑制该章的章节分段命中(避免同内容重复占位)。 */
export function suppressChapterSegs(hits: SearchHit[]): SearchHit[] {
  const withItems = new Set(
    hits.filter((h) => h.item_id).map((h) => `${h.document_id}|${h.chapter ?? ""}`),
  );
  return hits.filter(
    (h) => h.item_id !== null || !withItems.has(`${h.document_id}|${h.chapter ?? ""}`),
  );
}

export async function hybridSearch(
  pool: pg.Pool,
  deps: SearchDeps,
  query: string,
  opts: { topK?: number; filters?: Record<string, string>; itemsOnly?: boolean } = {},
): Promise<SearchHit[]> {
  const topK = opts.topK ?? 5;
  const itemsOnly = opts.itemsOnly ?? false;
  const subject = opts.filters?.subject;
  const [vec] = await deps.embed([query]);
  const vecHits = await vectorHits(pool, vec, 20, itemsOnly, subject);
  const bm25Conds = [itemsOnly && "item_id IS NOT NULL", subject && "meta->>'subject' = $1"]
    .filter(Boolean) as string[];
  const bm25Params: unknown[] = subject ? [subject] : [];
  const { rows: allChunks } = await pool.query(
    `SELECT item_id::text, chapter_id::text, document_id::text, content_md, meta
     FROM chunks ${bm25Conds.length ? `WHERE ${bm25Conds.join(" AND ")}` : ""}`,
    bm25Params,
  );

  const rrf = new Map<string, SearchHit>();
  const hitKey = (r: ChunkRow) => r.item_id ?? `chapter:${r.chapter_id}`;
  vecHits.forEach((r, rank) => {
    const key = hitKey(r);
    const h = rrf.get(key) ?? { ...toHit(r), score: 0 };
    // vec_score 取该条目各 chunk 的最大余弦(一个条目一个 chunk,当前即本身)
    h.vec_score = Math.max(h.vec_score ?? -1, r.score ?? -1);
    h.score += 1 / (60 + rank + 1);
    rrf.set(key, h);
  });
  const lexOrder = bm25Score(query, allChunks.map((r: ChunkRow) => r.content_md), 20);
  lexOrder.forEach(({ index }, rank) => {
    const r = allChunks[index];
    const key = hitKey(r);
    const h = rrf.get(key) ?? { ...toHit(r), score: 0 };
    h.score += 1 / (60 + rank + 1);
    rrf.set(key, h);
  });

  let candidates = [...rrf.values()].sort((a, b) => b.score - a.score);
  const filters = opts.filters ?? {};
  candidates = candidates.filter((h) =>
    Object.entries(filters).every(([k, v]) => h[k] === v),
  );
  candidates = suppressChapterSegs(candidates);

  if (deps.rerank && candidates.length > 0) {
    const poolN = candidates.slice(0, Math.max(topK, 10));
    const scores = await deps.rerank(query, poolN.map((h) => h.content_md));
    poolN.forEach((h, i) => (h.rerank_score = scores[i]));
    poolN.sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0));
    candidates = poolN;
  }
  return candidates.slice(0, topK);
}
