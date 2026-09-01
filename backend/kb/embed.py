"""检索期向量化：approved 条目 -> bge-m3 -> pgvector chunks；语义检索。

门禁：只有 qc_status='approved' 的条目进向量库；条目被编辑后 invalidate_chunk
删除旧向量（下次 embed 重建）。模型/端点走配置（默认本地 ollama bge-m3）。
"""
from __future__ import annotations

from openai import OpenAI
from psycopg.types.json import Jsonb

from kb.config import Config


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
                         client=None) -> int:
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
    return len(rows)


def invalidate_chunk(conn, item_id: str) -> None:
    """条目内容变了，旧向量作废。"""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM chunks WHERE item_id=%s", (item_id,))


def search(conn, cfg: Config, query: str, top_k: int = 5,
           filters: dict | None = None, client=None) -> list[dict]:
    """语义检索：query 过 embedding，余弦距离 top-k；filters 按键精确匹配 meta。"""
    vec = embed_texts(cfg, [query], client=client)[0]
    clauses, params = [], []
    for key, val in (filters or {}).items():
        clauses.append("c.meta->>%s = %s")
        params += [key, val]
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT c.item_id, c.content_md, c.meta,
                       1 - (c.embedding <=> %s::vector) AS score
                FROM chunks c {where}
                ORDER BY c.embedding <=> %s::vector LIMIT %s""",
            [vec, *params, vec, top_k],
        )
        return [
            {"item_id": str(r[0]), "content_md": r[1], "score": float(r[3]), **r[2]}
            for r in cur.fetchall()
        ]
