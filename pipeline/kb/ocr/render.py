"""阶段①渲染：文本层检测 + 每页渲染为 PNG，落库 documents/pages。幂等可重跑。"""
from __future__ import annotations

import uuid
from pathlib import Path

import pymupdf as fitz  # PyMuPDF

from kb.core.config import Config
from kb.core.paths import storage_rel


def detect_text_layer(doc: fitz.Document) -> bool:
    return any(page.get_text().strip() for page in doc)


def render_document(
    conn,
    cfg: Config,
    pdf_path,
    title: str,
    subject: str | None = None,
    grade: str | None = None,
    doc_type: str = "workbook",
    start: int = 1,
    end: int | None = None,
) -> str:
    """start/end 为 1-based 且含端点；不传 end 到末页。只渲染指定范围，断点重跑可补齐剩余页。"""
    # 存绝对路径：source_path 是幂等键，相对路径会因 CWD 不同而重复建档
    pdf_path = str(Path(pdf_path).resolve())
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM documents WHERE source_path=%s", (pdf_path,))
        row = cur.fetchone()
    doc = fitz.open(pdf_path)
    if row:
        doc_id = str(row[0])
    else:
        doc_id = str(uuid.uuid4())
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO documents
                   (id, title, subject, grade, doc_type, source_path, page_count,
                    has_text_layer, parse_status)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'rendered')""",
                (doc_id, title, subject, grade, doc_type, pdf_path,
                 doc.page_count, detect_text_layer(doc)),
            )
    pages_dir = cfg.storage_dir / doc_id / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT page_no FROM pages WHERE document_id=%s AND parse_status IN ('rendered','parsed')",
            (doc_id,),
        )
        done = {r[0] for r in cur.fetchall()}
        end_page = doc.page_count if end is None else min(end, doc.page_count)
        if not (1 <= start <= end_page):
            raise SystemExit(f"页码范围非法: start={start} end={end_page} total={doc.page_count}")
        for i in range(start - 1, end_page):
            page_no = i + 1
            img_abs = pages_dir / f"p{page_no:04d}.png"
            img_rel = storage_rel(cfg, img_abs)
            if page_no not in done:
                pix = doc[i].get_pixmap(dpi=cfg.dpi)
                pix.save(str(img_abs))
                cur.execute(
                    """INSERT INTO pages (document_id, page_no, image_path, parse_status)
                       VALUES (%s,%s,%s,'rendered')
                       ON CONFLICT (document_id, page_no)
                       DO UPDATE SET image_path=EXCLUDED.image_path, parse_status='rendered'""",
                    (doc_id, page_no, img_rel),
                )
    return doc_id
