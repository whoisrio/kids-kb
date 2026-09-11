"""检索期向量化：approved 条目 -> bge-m3 -> pgvector chunks；语义检索。

门禁：只有 qc_status='approved' 的条目进向量库；条目被编辑后 invalidate_chunk
删除旧向量（下次 embed 重建）。模型/端点走配置（默认本地 ollama bge-m3）。
"""
from __future__ import annotations

import re

from openai import OpenAI
from psycopg.types.json import Jsonb

from kb.core.config import Config


def _embed_client(cfg: Config) -> OpenAI:
    return OpenAI(base_url=cfg.embed_base_url.rstrip("/") + "/v1", api_key="ollama")


def embed_texts(cfg: Config, texts: list[str], client=None) -> list[list[float]]:
    client = client or _embed_client(cfg)
    out = []
    for t in texts:  # 逐条调用，bge-m3 本地推理足够快；批量接口各家不一致
        resp = client.embeddings.create(model=cfg.embed_model, input=t)
        out.append(resp.data[0].embedding)
    return out


def embed_approved_items(conn, cfg: Config, doc_id: str | None = None,
                         client=None, recorder=None) -> int:
    """approved 且无 chunk 的条目向量化。返回新增 chunk 数（幂等）。"""
    where, params = ("AND i.document_id=%s", [doc_id]) if doc_id else ("", [])
    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT i.id, i.document_id, i.content_md, i.label, i.chapter,
                       i.content_type, i.taxonomy, i.tags, i.page_start, i.page_end,
                       d.subject, d.grade, d.title
                FROM items i JOIN documents d ON d.id = i.document_id
                WHERE i.qc_status='approved' AND i.content_md IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.item_id = i.id)
                {where}""",
            params,
        )
        rows = cur.fetchall()
    if not rows:
        return 0
    vectors = embed_texts(cfg, [r[2] for r in rows], client=client)
    with conn.cursor() as cur:
        for r, vec in zip(rows, vectors, strict=True):
            meta = {
                "label": r[3], "chapter": r[4], "content_type": r[5],
                "taxonomy": r[6], "tags": r[7], "page_start": r[8], "page_end": r[9],
                "subject": r[10], "grade": r[11], "doc_title": r[12],
            }
            cur.execute(
                """INSERT INTO chunks (item_id, document_id, content_md, meta, embedding)
                   VALUES (%s,%s,%s,%s,%s) ON CONFLICT (item_id) DO NOTHING""",
                (str(r[0]), str(r[1]), r[2], Jsonb(meta), vec),
            )
    if recorder is not None:
        recorder.decision("embed", f"条目向量化新增 {len(rows)} 条 chunk")
    return len(rows)


def segment_chapter(content_md: str, max_chars: int = 1600,
                    overlap_chars: int = 0) -> list[str]:
    """章稿分段:空行分段落,聚合成 ≤max_chars 的段;超长单段硬切。bge-m3 上下文 8k,留足余量。
    overlap_chars>0 时相邻段携带上一段尾部重叠（章节向量化用；flat 页路径默认无重叠）。"""
    paras = [p.strip() for p in re.split(r"\n\s*\n", content_md or "") if p.strip()]
    segs: list[str] = []
    buf = ""
    for p in paras:
        if buf and len(buf) + len(p) + 2 <= max_chars:
            buf = f"{buf}\n\n{p}"
        else:
            if buf:
                segs.append(buf)
                buf = buf[-overlap_chars:] if overlap_chars > 0 else ""
            buf = f"{buf}\n\n{p}" if buf else p
        while len(buf) > max_chars:  # 单段超长:硬切
            segs.append(buf[:max_chars])
            buf = (buf[max_chars - overlap_chars:]
                   if 0 < overlap_chars < max_chars else buf[max_chars:])
    if buf:
        segs.append(buf)
    return segs


def embed_chapters(conn, cfg: Config, doc_id: str | None = None,
                   client=None, recorder=None) -> int:
    """有 content_md 且无 chunk 的章节 -> 分段向量化(未拆条也可见的检索底座)。幂等。"""
    where, params = ("AND ch.document_id=%s", [doc_id]) if doc_id else ("", [])
    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT ch.id, ch.document_id, ch.chapter_no, ch.title, ch.content_md,
                       d.subject, d.grade, d.title
                FROM chapters ch JOIN documents d ON d.id = ch.document_id
                WHERE ch.content_md IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.chapter_id = ch.id)
                {where}""",
            params,
        )
        rows = cur.fetchall()
    if not rows:
        return 0
    payloads = []
    for r in rows:
        label = f"第 {r[2]} 讲 {r[3]}"  # 与 structure_chapter 的 items.chapter 标签同构
        overlap = int(cfg.chunk_max_chars * cfg.chunk_overlap_ratio)
        for i, seg in enumerate(segment_chapter(
                r[4], max_chars=cfg.chunk_max_chars, overlap_chars=overlap), start=1):
            payloads.append((r, label, i, seg))
    vectors = embed_texts(cfg, [f"{label}\n\n{seg}" for (_r, label, _i, seg) in payloads],
                          client=client)
    with conn.cursor() as cur:
        for (r, label, i, seg), vec in zip(payloads, vectors, strict=True):
            meta = {
                "kind": "chapter", "chapter": label, "doc_title": r[7],
                "subject": r[5], "grade": r[6], "seg": i,
            }
            cur.execute(
                """INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding)
                   VALUES (%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (chapter_id, seg_no) WHERE chapter_id IS NOT NULL DO NOTHING""",
                (str(r[0]), str(r[1]), i, f"{label}\n\n{seg}", Jsonb(meta), vec),
            )
    if recorder is not None:
        recorder.decision("embed", f"章节向量化新增 {len(payloads)} 条 chunk")
    return len(payloads)


def approve_items(conn, cfg: Config, doc_id: str, chapter_no: int | None = None,
                  client=None) -> dict:
    """批量通过一个文档(可限章)的条目:非 approved/rejected 一律 approved,
    关闭其 pending 复核行,并立即向量化(条目 + 章节)。88 页练习册不该逐条点 approve。"""
    from kb.telemetry.traj import Recorder

    rec = Recorder(conn, cfg, doc_id)
    rec.start("approve", f"批量通过（chapter_no={chapter_no}）",
              payload={"chapter_no": chapter_no})
    label = None
    if chapter_no is not None:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT title FROM chapters WHERE document_id=%s AND chapter_no=%s",
                (doc_id, chapter_no),
            )
            row = cur.fetchone()
        if not row:
            raise SystemExit(f"章节不存在: doc={doc_id} 第 {chapter_no} 章")
        label = f"第 {chapter_no} 讲 {row[0]}"
    where = "AND chapter=%s" if label else ""
    params: list = [doc_id] + ([label] if label else [])
    with conn.cursor() as cur:
        cur.execute(
            f"""UPDATE items SET qc_status='approved'
                WHERE document_id=%s AND qc_status IN ('pending','auto_passed','needs_review')
                {where}
                RETURNING id""",
            params,
        )
        ids = [str(r[0]) for r in cur.fetchall()]
        if ids:
            cur.execute(
                "UPDATE review_queue SET status='approved' WHERE item_id = ANY(%s) AND status='pending'",
                (ids,),
            )
    rec.decision("approve", f"通过 {len(ids)} 条", payload={"approved": len(ids)})
    n = embed_approved_items(conn, cfg, doc_id, client=client, recorder=rec)
    n += embed_chapters(conn, cfg, doc_id, client=client, recorder=rec)
    rec.end("approve", f"通过 {len(ids)} 条，新增向量 {n} 条")
    return {"approved": len(ids), "embedded": n}


def invalidate_chunk(conn, item_id: str) -> None:
    """条目内容变了，旧向量作废。"""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM chunks WHERE item_id=%s", (item_id,))


def _vector_hits(conn, vec: list[float], top_n: int) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT c.item_id, c.chapter_id, c.content_md, c.meta,
                      1 - (c.embedding <=> %s::vector) AS score
               FROM chunks c ORDER BY c.embedding <=> %s::vector LIMIT %s""",
            (vec, vec, top_n),
        )
        return [
            {"item_id": str(r[0]) if r[0] else None,
             "chapter_id": str(r[1]) if r[1] else None,
             "content_md": r[2], "score": float(r[4]), **(r[3] or {})}
            for r in cur.fetchall()
        ]


def _hit_key(h: dict) -> str:
    return f"item:{h['item_id']}" if h.get("item_id") else f"chapter:{h.get('chapter_id')}"


def _meta_match(hit: dict, filters: dict | None) -> bool:
    return all(hit.get(k) == v for k, v in (filters or {}).items())


def search(conn, cfg: Config, query: str, top_k: int = 5,
           filters: dict | None = None, client=None, mode: str = "hybrid",
           reranker=None) -> list[dict]:
    """检索：mode=vector|bm25|hybrid（RRF k=60 融合）；reranker 注入 cross-encoder
    （如 kb.rag.rerank.get_reranker()，bge-reranker-v2-m3 本地 Python 加载）时重排候选。"""
    candidates: list[dict]
    if mode == "vector":
        vec = embed_texts(cfg, [query], client=client)[0]
        candidates = _vector_hits(conn, vec, max(top_k, 20))
    elif mode == "bm25":
        from kb.rag.lexical import bm25_search
        candidates = bm25_search(conn, query, top_k=max(top_k, 20))
    else:  # hybrid: RRF
        from kb.rag.lexical import bm25_search
        vec = embed_texts(cfg, [query], client=client)[0]
        vec_hits = _vector_hits(conn, vec, 20)
        lex_hits = bm25_search(conn, query, top_k=20)
        rrf: dict[str, dict] = {}
        for rank, h in enumerate(vec_hits):
            e = rrf.setdefault(_hit_key(h), {**h, "score": 0.0})
            e["score"] += 1 / (60 + rank + 1)
        for rank, h in enumerate(lex_hits):
            e = rrf.setdefault(_hit_key(h), {**h, "score": 0.0})
            e["score"] += 1 / (60 + rank + 1)
        candidates = sorted(rrf.values(), key=lambda h: -h["score"])
    candidates = [h for h in candidates if _meta_match(h, filters)]
    if reranker is not None and candidates:
        pool = candidates[: max(top_k, 10)]
        pairs = [(query, h["content_md"]) for h in pool]
        scores = reranker.compute_score(pairs)
        if not isinstance(scores, list):  # 单对时库返回标量
            scores = [scores]
        for h, s in zip(pool, scores, strict=True):
            h["rerank_score"] = float(s)
        pool.sort(key=lambda h: -h["rerank_score"])
        candidates = pool
    return candidates[:top_k]
