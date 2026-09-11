"""docx 入库:pandoc -> gfm markdown -> 共用文本入库路径(kb/text_ingest.py)。

docx 无页概念:不写 pages/blocks;图片 --extract-media 落 storage/<doc_id>/,
markdown 里的相对引用(media/...)相对该目录解析。
"""
from __future__ import annotations

import subprocess
import uuid
from pathlib import Path

from kb.core.config import Config
from kb.rag.text_ingest import split_chapters, store_document_chapters


def docx_to_markdown(docx_path, extract_dir: Path) -> str:
    """pandoc docx -> gfm;图片抽到 extract_dir(markdown 引用为其相对路径)。"""
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


def ingest_docx(conn, cfg: Config, path, title: str,
                subject: str | None = None, grade: str | None = None,
                doc_type: str = "exam", client=None) -> str:
    """幂等可重跑:source_path(绝对路径)为幂等键,已建档则复用 doc_id 补写章节。"""
    # 存绝对路径:source_path 是幂等键,相对路径会因 CWD 不同而重复建档
    path = str(Path(path).resolve())
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM documents WHERE source_path=%s", (path,))
        row = cur.fetchone()
    doc_id = str(row[0]) if row else str(uuid.uuid4())
    # pandoc 先于建档:转换失败不留孤儿 documents 行
    markdown = docx_to_markdown(path, Path(cfg.storage_dir) / doc_id)
    return store_document_chapters(
        conn, cfg, path, title, subject, grade, doc_type,
        split_chapters(markdown, title), doc_id=doc_id, client=client)
