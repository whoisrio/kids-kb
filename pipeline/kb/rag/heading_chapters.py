"""heading 模式：无目录文档用一级标题（blocks.title_level=1，0024）确定性合成章节。

探测不到目录页、但有 ≥2 个一级标题的文档走这里：每个一级标题一章，页范围顺排
（本章起点到下一章起点前一页，末章到文档最大页），之后复用 toc 模式的逐章拆题。
幂等：已有章节的文档直接跳过（仿 toc.extract_toc）。
"""
from __future__ import annotations

import re
import uuid

_H1_SQL = """SELECT p.page_no, b.content_md FROM blocks b
   JOIN pages p ON p.id = b.page_id
   WHERE p.document_id=%s AND b.title_level=1 AND NOT p.excluded_from_index
   ORDER BY p.page_no, b.ordinal"""

_CHAPTER_PREFIX = re.compile(r"^\s*第\s*[0-9一二三四五六七八九十百]+\s*[讲章节课单元]\s*")


def _strip_chapter_prefix(title: str) -> str:
    """剥「第N讲/章/单元」编号前缀（与 toc 模式 TOC_PROMPT 的口径一致——章标签由
    structure_chapter 统一拼「第 N 讲 {title}」，不剥会出现「第 1 讲 第 1 讲 …」）。
    剥完为空（标题就是纯编号）时保留原文。"""
    stripped = _CHAPTER_PREFIX.sub("", title).strip()
    return stripped or title


def count_h1_candidates(cur, doc_id: str) -> int:
    """一级标题候选数（未排除页上的 title_level=1 块）；resolve_mode 用它判 heading。"""
    cur.execute(
        """SELECT count(*) FROM blocks b
           JOIN pages p ON p.id = b.page_id
           WHERE p.document_id=%s AND b.title_level=1 AND NOT p.excluded_from_index""",
        (doc_id,),
    )
    return cur.fetchone()[0]


def synthesize_heading_chapters(conn, doc_id: str) -> int:
    """一级标题合成 chapters，返回新增章节数；<2 个一级标题或已有章节时返回 0。"""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM chapters WHERE document_id=%s LIMIT 1", (doc_id,))
        if cur.fetchone():
            return 0
        cur.execute(_H1_SQL, (doc_id,))
        headings = [(page_no, (content or "").strip()) for page_no, content in cur.fetchall()]
        headings = [(p, t) for p, t in headings if t]
        if len(headings) < 2:
            return 0
        cur.execute("SELECT max(page_no) FROM pages WHERE document_id=%s", (doc_id,))
        max_page = cur.fetchone()[0] or 0
        n = 0
        for i, (page_no, title) in enumerate(headings, start=1):
            page_end = headings[i][0] - 1 if i < len(headings) else max_page
            cur.execute(
                """INSERT INTO chapters (id, document_id, chapter_no, title,
                                         page_start, page_end, tags)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (document_id, chapter_no) DO NOTHING""",
                (str(uuid.uuid4()), doc_id, i, _strip_chapter_prefix(title),
                 page_no, page_end, []),
            )
            n += 1
    return n
