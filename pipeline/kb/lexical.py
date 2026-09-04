"""BM25 词法检索：纯 Python 实现（chunks 量级小，无需外部引擎）。

分词：英数按词，CJK 按字符二元组（单字词保留单字）——中文教辅检索够用，免 jieba。
"""
from __future__ import annotations

import math
import re
from collections import Counter

_RUN_RE = re.compile(r"[a-z0-9]+|[一-鿿]+")

_K1 = 1.5
_B = 0.75


def tokenize(text: str) -> list[str]:
    tokens = []
    for m in _RUN_RE.finditer((text or "").lower()):
        t = m.group(0)
        if len(t) == 1 or re.fullmatch(r"[a-z0-9]+", t):
            tokens.append(t)
        else:  # CJK 长串 -> 字符二元组
            tokens.extend(t[i:i + 2] for i in range(len(t) - 1))
    return tokens


def bm25_search(conn, query: str, top_k: int = 20) -> list[dict]:
    """对全部 chunks 做 BM25。返回 [{item_id, chapter_id, content_md, bm25, **meta}]，降序。"""
    with conn.cursor() as cur:
        cur.execute("SELECT item_id, chapter_id, content_md, meta FROM chunks")
        rows = cur.fetchall()
    if not rows:
        return []
    docs = [(r[0], r[1], r[2], r[3], Counter(tokenize(r[2]))) for r in rows]
    avgdl = sum(sum(d[4].values()) for d in docs) / len(docs)
    q_terms = tokenize(query)
    # df
    df: Counter = Counter()
    for _iid, _cid, _c, _m, tf in docs:
        for t in set(tf):
            df[t] += 1
    n_docs = len(docs)
    scored = []
    for iid, cid, content, meta, tf in docs:
        dl = sum(tf.values())
        score = 0.0
        for t in q_terms:
            if t not in tf:
                continue
            idf = math.log(1 + (n_docs - df[t] + 0.5) / (df[t] + 0.5))
            score += idf * tf[t] * (_K1 + 1) / (tf[t] + _K1 * (1 - _B + _B * dl / avgdl))
        scored.append({"item_id": str(iid) if iid else None,
                       "chapter_id": str(cid) if cid else None,
                       "content_md": content, "bm25": score, **(meta or {})})
    scored.sort(key=lambda h: -h["bm25"])
    return scored[:top_k]
