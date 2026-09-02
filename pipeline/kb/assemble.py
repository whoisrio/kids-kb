"""章节组装：把采用版本的页内容拼成章节 markdown（完整文档产物）。

content_md 非空的章（docx 等无页文档）：章稿直接取章原文。
其余章：adopted_source=page_md 的页用远端整页稿，其余页用块文本（跳页眉页脚）按阅读序拼接。
"""
from __future__ import annotations


def assemble_chapter(conn, doc_id: str, chapter_no: int) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT page_start, page_end, content_md FROM chapters
               WHERE document_id=%s AND chapter_no=%s""",
            (doc_id, chapter_no),
        )
        row = cur.fetchone()
        if not row:
            return ""
        if row[2]:
            return row[2]  # docx 章：章稿即原文
        if row[0] is None:
            return ""
        cur.execute(
            """SELECT p.page_no, p.adopted_source, p.page_md, p.id FROM pages p
               WHERE p.document_id=%s AND p.page_no BETWEEN %s AND %s
               ORDER BY p.page_no""",
            (doc_id, row[0], row[1]),
        )
        pages = cur.fetchall()
        parts = []
        for page_no, adopted, page_md, page_id in pages:
            if adopted == "page_md" and page_md:
                parts.append(f"<!-- p{page_no} -->\n{page_md}")
                continue
            cur.execute(
                """SELECT content_md FROM blocks
                   WHERE page_id=%s AND content_md IS NOT NULL
                     AND block_type NOT IN ('header','footer')
                   ORDER BY created_at, id""",
                (page_id,),
            )
            body = "\n\n".join(r[0] for r in cur.fetchall())
            if body.strip():
                parts.append(f"<!-- p{page_no} -->\n{body}")
        return "\n\n".join(parts)
