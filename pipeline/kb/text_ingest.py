"""文本类资料入库(docx/md 共用):按标题切章 -> chapters.content_md -> 章节向量化。

md 直接读文件;docx 先经 pandoc(kb/docx_ingest.py)。两路共用切章与落库。
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from kb.config import Config
from kb.export_md import export_chapter_mds

_HEADING_RE = re.compile(r"^#{1,2}\s+(.+?)\s*#*$", re.M)


def split_chapters(markdown: str, doc_title: str) -> list[tuple[str, str]]:
    """按一/二级标题切章,卷首并入第一章;无标题则整份单章。返回 [(title, content_md)]。"""
    matches = list(_HEADING_RE.finditer(markdown))
    if not matches:
        body = markdown.strip()
        return [(doc_title, body)] if body else []
    chapters = []
    for i, m in enumerate(matches):
        begin = 0 if i == 0 else m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown)
        chapters.append((m.group(1).strip(), markdown[begin:end].strip()))
    return chapters


def store_document_chapters(conn, cfg: Config, path, title: str,
                            subject: str | None, grade: str | None, doc_type: str,
                            chapters: list[tuple[str, str]],
                            doc_id: str | None = None, client=None) -> str:
    """幂等落库:source_path(绝对路径)为键;doc_id 可由调用方预解析(docx 抽图目录需要)。
    落库后立即章节向量化(失败不阻断,可 kb.cli embed 补跑)。"""
    path = str(Path(path).resolve())
    if doc_id is None:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM documents WHERE source_path=%s", (path,))
            row = cur.fetchone()
        doc_id = str(row[0]) if row else str(uuid.uuid4())
    chapters = [(ch_title, content) for ch_title, content in chapters if content.strip()]
    if not chapters:
        raise ValueError("文档没有可入库内容")
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO documents (id, title, subject, grade, doc_type, source_path,
                                      page_count, has_text_layer, parse_status, review_status)
               VALUES (%s,%s,%s,%s,%s,%s,0,true,'parsed','pending')
               ON CONFLICT (id) DO NOTHING""",
            (doc_id, title, subject, grade, doc_type, path),
        )
        for i, (ch_title, content) in enumerate(chapters, start=1):
            cur.execute(
                """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
                   VALUES (%s,%s,%s,%s,%s)
                   ON CONFLICT (document_id, chapter_no) DO UPDATE
                   SET title=EXCLUDED.title, content_md=EXCLUDED.content_md""",
                (str(uuid.uuid4()), doc_id, i, ch_title, content),
            )
        export_chapter_mds(conn, cfg, doc_id)
    try:
        from kb.embed import embed_chapters
        embed_chapters(conn, cfg, doc_id, client=client)
        with conn.cursor() as cur:
            cur.execute("UPDATE chapters SET index_status='indexed' WHERE document_id=%s", (doc_id,))
    except Exception as e:  # noqa: BLE001 - 向量化失败不阻断入库,可 kb.cli embed 补跑
        print(f"warn: 章节向量化失败({e}),稍后可用 `kb.cli embed {doc_id}` 补跑")
    return doc_id


def ingest_md(conn, cfg: Config, path, title: str,
              subject: str | None = None, grade: str | None = None,
              doc_type: str = "exam", client=None) -> str:
    """md 入库:整份文件即 markdown,无 pandoc。"""
    text = Path(path).read_text(encoding="utf-8")
    return store_document_chapters(
        conn, cfg, path, title, subject, grade, doc_type,
        split_chapters(text, title), client=client)
