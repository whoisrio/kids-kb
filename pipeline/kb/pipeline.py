"""流水线编排：渲染 -> 版面 -> 解析 -> 质检，各阶段幂等可断点重跑。"""
from __future__ import annotations

from kb.config import Config
from kb.crosscheck import run_llm_crosscheck
from kb.export_md import export_page_mds
from kb.layout import make_layout_analyzer, run_layout
from kb.parse import run_parse
from kb.qc import run_qc
from kb.render import render_document


def ingest(conn, cfg: Config, pdf_path, title: str,
           subject: str | None = None, grade: str | None = None,
           doc_type: str = "workbook", client=None,
           start: int = 1, end: int | None = None) -> str:
    from kb.traj import Recorder

    doc_id = render_document(conn, cfg, pdf_path, title, subject, grade, doc_type,
                             start=start, end=end)
    rec = Recorder(conn, cfg, doc_id)
    rec.start("ingest", f"入库《{title}》", payload={
        "title": title, "pdf_path": str(pdf_path), "start": start, "end": end,
        "doc_type": doc_type, "subject": subject, "grade": grade,
    })
    t = rec.start("render", f"渲染 {doc_id} 页面")
    rec.end("render", "渲染完成", started=t)
    t = rec.start("layout", "版面切块")
    run_layout(conn, doc_id, analyzer=make_layout_analyzer(cfg))
    rec.end("layout", "版面切块完成", started=t)
    t = rec.start("parse", "区块转录")
    n_parsed = run_parse(conn, cfg, doc_id, client=client, recorder=rec)
    rec.end("parse", f"区块转录完成，{n_parsed} 块", started=t)
    t = rec.start("qc", "质检")
    run_qc(conn, doc_id, cfg=cfg, recorder=rec)  # 实质问题多的页自动触发整页 VLM 第二解析
    rec.end("qc", "质检完成", started=t)
    t = rec.start("crosscheck", "双模型比对")
    n_dis = run_llm_crosscheck(conn, cfg, doc_id, recorder=rec)
    rec.end("crosscheck", f"双模型比对完成，新增 {n_dis} 条分歧", started=t)
    t = rec.start("export", "页级 markdown 落盘")
    export_page_mds(conn, cfg, doc_id)  # 页级 markdown 落盘镜像
    rec.end("export", "页级 markdown 落盘完成", started=t)
    rec.end("ingest", "入库完成")
    return doc_id
