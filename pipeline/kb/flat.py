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


def build_flat_chapter(conn, doc_id: str) -> str:
    """建/更新合成章（chapter_no=1，title=文档名，content_md=全页采用内容拼接）并置
    struct_mode='flat'。返回 chapter_id。幂等：重跑更新 content_md。
    防混用：文档已有第 2+ 章视为 TOC 拆过章，拒绝。"""
    with conn.cursor() as cur:
        cur.execute("SELECT title FROM documents WHERE id=%s", (doc_id,))
        row = cur.fetchone()
        if not row:
            raise ValueError(f"文档不存在: {doc_id}")
        cur.execute(
            "SELECT chapter_no FROM chapters WHERE document_id=%s ORDER BY chapter_no",
            (doc_id,),
        )
        chapters = [r[0] for r in cur.fetchall()]
        if chapters and chapters != [1]:
            raise ValueError("文档已有章节（可能已按目录拆章），--flat 仅用于未拆章文档")
        content_md = "\n\n".join(text for _no, text in page_contents(cur, doc_id))
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,1,%s,%s)
               ON CONFLICT (document_id, chapter_no) DO UPDATE SET content_md = EXCLUDED.content_md
               RETURNING id""",
            (str(uuid.uuid4()), doc_id, row[0], content_md),
        )
        chapter_id = str(cur.fetchone()[0])
        cur.execute("UPDATE documents SET struct_mode='flat' WHERE id=%s", (doc_id,))
    return chapter_id
