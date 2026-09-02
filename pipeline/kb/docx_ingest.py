"""docx 入库：pandoc -> gfm markdown -> 按标题切章存 chapters.content_md。

docx 无页概念：不写 pages/blocks；图片 --extract-media 落 storage/<doc_id>/，
markdown 里的相对引用（media/...）相对该目录解析。
"""
from __future__ import annotations

import re
import subprocess
import uuid
from pathlib import Path

from kb.config import Config
from kb.export_md import export_chapter_mds

_HEADING_RE = re.compile(r"^#{1,2}\s+(.+?)\s*#*$", re.M)


def docx_to_markdown(docx_path, extract_dir: Path) -> str:
    """pandoc docx -> gfm；图片抽到 extract_dir（markdown 引用为其相对路径）。"""
    Path(extract_dir).mkdir(parents=True, exist_ok=True)
    try:
        out = subprocess.run(
            ["pandoc", "-f", "docx", "-t", "gfm", f"--extract-media={extract_dir}", str(docx_path)],
            capture_output=True, text=True,
        )
    except FileNotFoundError:
        raise SystemExit("需要 pandoc: https://pandoc.org/installing.html") from None
    if out.returncode != 0:
        raise SystemExit(f"pandoc 转换失败: {out.stderr.strip()}")
    return out.stdout


def split_chapters(markdown: str, doc_title: str) -> list[tuple[str, str]]:
    """按一/二级标题切章，卷首并入第一章；无标题则整份单章。返回 [(title, content_md)]。"""
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


def ingest_docx(conn, cfg: Config, path, title: str,
                subject: str | None = None, grade: str | None = None,
                doc_type: str = "exam") -> str:
    """幂等可重跑：source_path（绝对路径）为幂等键，已建档则复用 doc_id 补写章节。"""
    # 存绝对路径：source_path 是幂等键，相对路径会因 CWD 不同而重复建档
    path = str(Path(path).resolve())
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM documents WHERE source_path=%s", (path,))
        row = cur.fetchone()
    doc_id = str(row[0]) if row else str(uuid.uuid4())
    # pandoc 先于建档：转换失败不留孤儿 documents 行
    markdown = docx_to_markdown(path, Path(cfg.storage_dir) / doc_id)
    if not row:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO documents (id, title, subject, grade, doc_type, source_path,
                                          page_count, has_text_layer, status)
                   VALUES (%s,%s,%s,%s,%s,%s,0,true,'parsed')""",
                (doc_id, title, subject, grade, doc_type, path),
            )
    with conn.cursor() as cur:
        for i, (ch_title, content) in enumerate(split_chapters(markdown, title), start=1):
            cur.execute(
                """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
                   VALUES (%s,%s,%s,%s,%s) ON CONFLICT (document_id, chapter_no) DO NOTHING""",
                (str(uuid.uuid4()), doc_id, i, ch_title, content),
            )
    export_chapter_mds(conn, cfg, doc_id)
    return doc_id
