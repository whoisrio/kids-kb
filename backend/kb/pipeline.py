"""流水线编排：渲染 -> 版面 -> 解析 -> 质检，各阶段幂等可断点重跑。"""
from __future__ import annotations

from kb.config import Config
from kb.layout import run_layout
from kb.parse import run_parse
from kb.qc import run_qc
from kb.render import render_document


def ingest(conn, cfg: Config, pdf_path, title: str,
           subject: str | None = None, grade: str | None = None,
           doc_type: str = "workbook", client=None) -> str:
    doc_id = render_document(conn, cfg, pdf_path, title, subject, grade, doc_type)
    run_layout(conn, doc_id)
    run_parse(conn, cfg, doc_id, client=client)
    run_qc(conn, doc_id)
    return doc_id
