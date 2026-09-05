"""flat 入库：无目录文档（试卷集合等）的整卷按页模式。

structure 探测不到目录页时回退到这里：不抽目录、不拆条，
建 1 条合成章 + 按页对齐向量化（chunk meta 带 page_no，检索可定位到页）。
设计：docs/superpowers/specs/2026-09-05-phase3-c-design.md（Workstream D）
"""
from __future__ import annotations

import uuid

from psycopg.types.json import Jsonb

from kb.config import Config

_SKIP_TYPES = ("header", "footer")


def page_contents(cur, doc_id: str) -> list[tuple[int, str]]:
    """flat 文档的按页采用内容：page_md 页用整页稿，其余页用块文本（跳 header/footer）。
    与 structure._chapter_blocks 同口径；无内容的页不出现。"""
    cur.execute(
        """SELECT page_no, adopted_source, page_md, id FROM pages
           WHERE document_id=%s ORDER BY page_no""",
        (doc_id,),
    )
    out: list[tuple[int, str]] = []
    for page_no, adopted, page_md, page_id in cur.fetchall():
        if adopted == "page_md" and page_md:
            out.append((page_no, page_md))
            continue
        cur.execute(
            """SELECT content_md FROM blocks
               WHERE page_id=%s AND NOT (block_type = ANY(%s)) AND content_md IS NOT NULL
               ORDER BY created_at, id""",
            (page_id, list(_SKIP_TYPES)),
        )
        text = "\n".join(r[0] for r in cur.fetchall())
        if text.strip():
            out.append((page_no, text))
    return out
