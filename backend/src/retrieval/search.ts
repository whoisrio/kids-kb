/** 双路召回：向量（pgvector）+ BM25（内存）→ RRF k=60 融合 → 可选重排。
    行为对齐 pipeline/kb/embed.py 的 search(mode='hybrid')。 */
import type pg from "pg";
import { bm25Score } from "./bm25.js";

export interface SearchHit {
  item_id: string;
  content_md: string;
  score: number;
  rerank_score?: number;
  [k: string]: unknown;  // meta 展开（label/chapter/subject/doc_title 等）
}

export interface SearchDeps {
  embed: (texts: string[]) => Promise<number[][]>;
  rerank: ((query: string, docs: string[]) => Promise<number[]>) | null;
}

interface ChunkRow {
  item_id: string;
  content_md: string;
  meta: Record<string, unknown>;
  score?: number;
}

async function vectorHits(pool: pg.Pool, vec: number[], topN: number): Promise<ChunkRow[]> {
  const { rows } = await pool.query(
    `SELECT c.item_id, c.content_md, c.meta,
            1 - (c.embedding <=> $1::vector) AS score
     FROM chunks c ORDER BY c.embedding <=> $1::vector LIMIT $2`,
    [`[${vec.join(",")}]`, topN],
  );
  return rows;
}

function toHit(r: ChunkRow): SearchHit {
  return { item_id: r.item_id, content_md: r.content_md, score: r.score ?? 0, ...r.meta };
}

export async function hybridSearch(
  pool: pg.Pool,
  deps: SearchDeps,
  query: string,
  opts: { topK?: number; filters?: Record<string, string> } = {},
): Promise<SearchHit[]> {
  const topK = opts.topK ?? 5;
  const [vec] = await deps.embed([query]);
  const vecHits = await vectorHits(pool, vec, 20);
  const { rows: allChunks } = await pool.query(
    "SELECT item_id, content_md, meta FROM chunks",
  );
  const lexOrder = bm25Score(query, allChunks.map((r: ChunkRow) => r.content_md), 20);

  const rrf = new Map<string, SearchHit>();
  vecHits.forEach((r, rank) => {
    const h = rrf.get(r.item_id) ?? { ...toHit(r), score: 0 };
    h.score += 1 / (60 + rank + 1);
    rrf.set(r.item_id, h);
  });
  lexOrder.forEach(({ index }, rank) => {
    const r = allChunks[index];
    const h = rrf.get(r.item_id) ?? { ...toHit(r), score: 0 };
    h.score += 1 / (60 + rank + 1);
    rrf.set(r.item_id, h);
  });

  let candidates = [...rrf.values()].sort((a, b) => b.score - a.score);
  const filters = opts.filters ?? {};
  candidates = candidates.filter((h) =>
    Object.entries(filters).every(([k, v]) => h[k] === v),
  );

  if (deps.rerank && candidates.length > 0) {
    const poolN = candidates.slice(0, Math.max(topK, 10));
    const scores = await deps.rerank(query, poolN.map((h) => h.content_md));
    poolN.forEach((h, i) => (h.rerank_score = scores[i]));
    poolN.sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0));
    candidates = poolN;
  }
  return candidates.slice(0, topK);
}
