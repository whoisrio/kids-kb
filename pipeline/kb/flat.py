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


def embed_flat_pages(conn, cfg: Config, doc_id: str, page_no: int | None = None,
                     client=None) -> int:
    """flat 文档按页对齐向量化（重建式幂等）。
    每页切段（超长页用 segment_chapter 再细分），seg_no = page_no*1000 + 段序
    （确定性编号，单页重建不与其他页冲突）；page_no 给定时只重建该页。
    返回新增 chunk 数。"""
    from kb.embed import embed_texts, segment_chapter

    with conn.cursor() as cur:
        cur.execute("SELECT struct_mode FROM documents WHERE id=%s", (doc_id,))
        row = cur.fetchone()
        if not row:
            raise ValueError(f"文档不存在: {doc_id}")
        cur.execute(
            """SELECT ch.id, d.title, d.subject, d.grade
               FROM chapters ch JOIN documents d ON d.id = ch.document_id
               WHERE ch.document_id=%s AND ch.chapter_no=1""",
            (doc_id,),
        )
        ch = cur.fetchone()
        if not ch:
            raise ValueError("flat 章不存在，请先跑 structure")
        if row[0] != "flat":
            raise ValueError("非 flat 文档（struct_mode 不是 flat）")
        chapter_id, doc_title, subject, grade = str(ch[0]), ch[1], ch[2], ch[3]
        cur.execute("SELECT page_no FROM pages WHERE document_id=%s ORDER BY page_no", (doc_id,))
        page_nos = {r[0] for r in cur.fetchall()}
        contents = [pc for pc in page_contents(cur, doc_id)
                    if page_no is None or pc[0] == page_no]
    label = "全卷"
    payloads: list[tuple[int, int, str]] = []  # (page_no, seg_idx, content)
    for pno, text in contents:
        for i, seg in enumerate(segment_chapter(text), start=1):
            payloads.append((pno, i, f"{label} · 第 {pno} 页\n\n{seg}"))
    if not payloads:
        with conn.transaction(), conn.cursor() as cur:
            if page_no is None:
                cur.execute("DELETE FROM chunks WHERE chapter_id=%s", (chapter_id,))
            else:
                cur.execute(
                    "DELETE FROM chunks WHERE chapter_id=%s AND meta->>'page_no'=%s",
                    (chapter_id, str(page_no)),
                )
        return 0
    vectors = embed_texts(cfg, [content for _p, _i, content in payloads], client=client)
    by_page: dict[int, list[tuple[tuple[int, int, str], list[float]]]] = {}
    for payload, vec in zip(payloads, vectors, strict=True):
        by_page.setdefault(payload[0], []).append((payload, vec))
    with conn.transaction(), conn.cursor() as cur:
        if page_no is None:
            cur.execute("DELETE FROM chunks WHERE chapter_id=%s", (chapter_id,))
        for pno, items in by_page.items():
            cur.execute(
                "DELETE FROM chunks WHERE chapter_id=%s AND meta->>'page_no'=%s",
                (chapter_id, str(pno)),
            )
            for (p, i, content), vec in items:
                meta = {
                    "kind": "chapter", "chapter": label, "page_no": pno,
                    "doc_title": doc_title, "subject": subject, "grade": grade, "seg": i,
                }
                cur.execute(
                    """INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding)
                       VALUES (%s,%s,%s,%s,%s,%s)""",
                    (chapter_id, doc_id, pno * 1000 + i, content, Jsonb(meta), vec),
                )
    return len(payloads)


def approve_flat_pages(conn, cfg: Config, doc_id: str, client=None) -> dict:
    """flat 文档批量通过：关闭该文档全部 pending 复核行 + 全页向量化（重建式幂等）。
    返回 {pages: 有内容的页数, chunks: 新增 chunk 数, resolved: 关闭的复核行数}。"""
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute("SELECT struct_mode FROM documents WHERE id=%s", (doc_id,))
            row = cur.fetchone()
            if not row:
                raise ValueError(f"文档不存在: {doc_id}")
            if row[0] != "flat":
                raise ValueError("非 flat 文档（struct_mode 不是 flat）")
            cur.execute(
                """UPDATE review_queue SET status='approved'
                   WHERE status='pending'
                     AND (page_id IN (SELECT id FROM pages WHERE document_id=%s)
                          OR block_id IN (
                              SELECT id FROM blocks
                              WHERE page_id IN (
                                  SELECT id FROM pages WHERE document_id=%s
                              )
                          ))""",
                (doc_id, doc_id),
            )
            resolved = cur.rowcount
        chunks = embed_flat_pages(conn, cfg, doc_id, client=client)
    with conn.cursor() as cur:
        n_pages = len(page_contents(cur, doc_id))
    return {"pages": n_pages, "chunks": chunks, "resolved": resolved}


def resolve_mode(cur, doc_id: str, flat: bool, toc_pages: list[int] | None) -> str:
    """structure 模式判定：显式 --flat > 显式 --toc-pages > 自动探测目录页。"""
    if flat:
        return "flat"
    if toc_pages:
        return "toc"
    from kb.toc import detect_toc_pages
    return "toc" if detect_toc_pages(cur, doc_id) else "flat"
