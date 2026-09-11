"""命令行入口。

用法（在 pipeline/ 目录下执行）:
  uv run python -m kb.cli migrate
  uv run python -m kb.cli ingest <pdf|docx> --title 书名 [--subject 数学] [--grade 四年级] [--type workbook|exam]
  uv run python -m kb.cli status
"""
from __future__ import annotations

import argparse
from pathlib import Path

from kb.core.config import load_config
from kb.core.db import connect, migrate
from kb.pdf_ingest import ingest


def list_documents(conn) -> list[tuple]:
    """每本书的解析进度（标题、状态、已解析页/总页）。"""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT d.title, d.parse_status,
                      count(p.id) FILTER (WHERE p.parse_status='parsed') AS parsed,
                      count(p.id) AS total
               FROM documents d LEFT JOIN pages p ON p.document_id=d.id
               GROUP BY d.title, d.parse_status ORDER BY min(d.created_at)"""
        )
        return cur.fetchall()


def main() -> None:
    ap = argparse.ArgumentParser(prog="kb")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate")
    p_ingest = sub.add_parser("ingest")
    p_ingest.add_argument("pdf")
    p_ingest.add_argument("--title", required=True)
    p_ingest.add_argument("--subject", default=None)
    p_ingest.add_argument("--grade", default=None)
    p_ingest.add_argument("--type", dest="doc_type", default="workbook",
                          choices=["workbook", "exam"])
    p_ingest.add_argument("--start", type=int, default=1, help="起始页(1-based，含)")
    p_ingest.add_argument("--end", type=int, default=None, help="结束页(1-based，含)，默认到末页")
    sub.add_parser("status")
    p_internal = sub.add_parser("serve-internal", help="内部服务（/internal/rerank 等，只对 TS 后端）")
    p_internal.add_argument("--host", default="127.0.0.1")
    p_internal.add_argument("--port", type=int, default=8766)
    p_golden = sub.add_parser("golden-extract")
    p_golden.add_argument("doc_id")
    p_golden.add_argument("--dir", default="golden")
    p_check = sub.add_parser("golden-check")
    p_check.add_argument("doc_id")
    p_check.add_argument("--dir", default="golden")
    p_check.add_argument("--level", default="page", choices=["page", "block"])
    p_anno = sub.add_parser("golden-annotate")
    p_anno.add_argument("doc_id")
    p_anno.add_argument("--dir", default="golden")
    p_struct = sub.add_parser("structure")
    p_struct.add_argument("doc_id")
    p_struct.add_argument("--toc-pages", default=None,
                          help="目录物理页码，逗号分隔，如 5,6；不给则自动探测")
    p_struct.add_argument("--flat", action="store_true",
                          help="整卷按页模式：不抽目录不拆条，页级通过后按页向量化（无目录页的试卷集合）")
    p_struct.add_argument("--exam", action="store_true",
                          help="试卷拆题模式：LLM 按题提取成条目（doc_type=exam 时自动启用）")
    p_embed = sub.add_parser("embed", help="approved 条目 + 未拆条章节向量化补跑（bge-m3 -> pgvector）")
    p_embed.add_argument("doc_id", nargs="?", default=None)
    p_approve = sub.add_parser("approve", help="批量通过条目并自动向量化(可限章)")
    p_approve.add_argument("doc_id")
    p_approve.add_argument("--chapter", type=int, default=None, help="只通过指定章(章号)")
    p_export = sub.add_parser("export", help="markdown 落盘镜像（页级 + 章节级）")
    p_export.add_argument("doc_id")
    p_search = sub.add_parser("search", help="语义检索")
    p_search.add_argument("query")
    p_search.add_argument("--top-k", type=int, default=5)
    p_search.add_argument("--mode", default="hybrid", choices=["vector", "bm25", "hybrid"])
    p_search.add_argument("--rerank", action="store_true",
                          help="用本地 bge-reranker-v2-m3 重排（需 uv sync --extra rerank）")
    args = ap.parse_args()

    if args.cmd == "serve-internal":
        import uvicorn
        from kb.internal_api import create_internal_app
        uvicorn.run(create_internal_app(), host=args.host, port=args.port)
        return

    cfg = load_config()
    conn = connect(cfg.database_url)
    if args.cmd == "migrate":
        print("已执行 migration:", migrate(conn) or "（无新增）")
    elif args.cmd == "ingest":
        migrate(conn)
        lower = str(args.pdf).lower()
        if lower.endswith(".docx"):
            from kb.rag.docx_ingest import ingest_docx
            doc_id = ingest_docx(conn, cfg, args.pdf, args.title,
                                 subject=args.subject, grade=args.grade, doc_type=args.doc_type)
        elif lower.endswith(".md"):
            from kb.rag.text_ingest import ingest_md
            doc_id = ingest_md(conn, cfg, args.pdf, args.title,
                               subject=args.subject, grade=args.grade, doc_type=args.doc_type)
        else:
            doc_id = ingest(conn, cfg, args.pdf, args.title,
                            subject=args.subject, grade=args.grade, doc_type=args.doc_type,
                            start=args.start, end=args.end)
        print(f"完成 document_id={doc_id}")
    elif args.cmd == "status":
        for title, status, parsed, total in list_documents(conn):
            print(f"{title}\t{status}\t{parsed}/{total} 页已解析")
    elif args.cmd == "golden-extract":
        from kb.ocr.golden import extract
        out = extract(conn, args.doc_id, Path(args.dir))
        print(f"导出 {len(out)} 页黄金稿，请人工校对: {args.dir}/{args.doc_id}/")
    elif args.cmd == "golden-check":
        from kb.ocr.golden import check, check_blocks
        if args.level == "block":
            check_blocks(conn, args.doc_id, Path(args.dir))
        else:
            check(conn, cfg, args.doc_id, Path(args.dir))
    elif args.cmd == "golden-annotate":
        from kb.ocr.golden import annotate
        out = annotate(conn, args.doc_id, Path(args.dir))
        print(f"导出 {len(out)} 页区块标注底稿，请人工校对: {args.dir}/{args.doc_id}/")
    elif args.cmd == "structure":
        from kb.rag.structure import run_structure

        toc_pages = [int(x) for x in args.toc_pages.split(",")] if args.toc_pages else None
        run_structure(conn, cfg, args.doc_id, toc_pages=toc_pages, flat=args.flat,
                      exam=args.exam)
    elif args.cmd == "approve":
        from kb.rag.embed import approve_items
        from kb.rag.flat import approve_flat_pages
        with conn.cursor() as cur:
            cur.execute("SELECT struct_mode FROM documents WHERE id=%s", (args.doc_id,))
            row = cur.fetchone()
        if not row:
            raise SystemExit(f"文档不存在: {args.doc_id}")
        if row and row[0] == "flat":
            out = approve_flat_pages(conn, cfg, args.doc_id)
            print(f"通过 {out['pages']} 页,新增向量 {out['chunks']} 条(页级)")
        else:
            out = approve_items(conn, cfg, args.doc_id, chapter_no=args.chapter)
            print(f"通过 {out['approved']} 条,新增向量 {out['embedded']} 条")
    elif args.cmd == "embed":
        from kb.rag.embed import embed_approved_items, embed_chapters
        n = embed_approved_items(conn, cfg, args.doc_id)
        n += embed_chapters(conn, cfg, args.doc_id)
        print(f"新增向量: {n} 条(条目+章节)")
    elif args.cmd == "export":
        from kb.rag.export_md import export_chapter_mds, export_page_mds
        print(f"落盘: {export_page_mds(conn, cfg, args.doc_id)} 页 md, "
              f"{export_chapter_mds(conn, cfg, args.doc_id)} 章 md")
    elif args.cmd == "search":
        from kb.rag.embed import search
        reranker = None
        if args.rerank:
            from kb.rag.rerank import get_reranker
            reranker = get_reranker()
        for h in search(conn, cfg, args.query, top_k=args.top_k,
                        mode=args.mode, reranker=reranker):
            score = h.get("rerank_score") or h.get("score") or h.get("bm25") or 0.0
            print(f"{score:.3f}\t{h.get('doc_title')} · {h.get('chapter')} · "
                  f"{h.get('label') or '章节'}\t{(h['content_md'] or '')[:60]}")


if __name__ == "__main__":
    main()
