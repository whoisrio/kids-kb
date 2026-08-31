"""命令行入口。

用法（在 backend/ 目录下执行）:
  uv run python -m kb.cli migrate
  uv run python -m kb.cli ingest <pdf> --title 书名 [--subject 数学] [--grade 四年级] [--type workbook|exam]
  uv run python -m kb.cli status
"""
from __future__ import annotations

import argparse
from pathlib import Path

from kb.config import load_config
from kb.db import connect, migrate
from kb.pipeline import ingest


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
    sub.add_parser("status")
    p_golden = sub.add_parser("golden-extract")
    p_golden.add_argument("doc_id")
    p_golden.add_argument("--dir", default="golden")
    p_check = sub.add_parser("golden-check")
    p_check.add_argument("doc_id")
    p_check.add_argument("--dir", default="golden")
    args = ap.parse_args()

    cfg = load_config()
    conn = connect(cfg.database_url)
    if args.cmd == "migrate":
        print("已执行 migration:", migrate(conn) or "（无新增）")
    elif args.cmd == "ingest":
        migrate(conn)
        doc_id = ingest(conn, cfg, args.pdf, args.title,
                        subject=args.subject, grade=args.grade, doc_type=args.doc_type)
        print(f"完成 document_id={doc_id}")
    elif args.cmd == "status":
        with conn.cursor() as cur:
            cur.execute(
                """SELECT d.title, d.status,
                          count(p.id) FILTER (WHERE p.status='parsed') AS parsed,
                          count(p.id) AS total
                   FROM documents d LEFT JOIN pages p ON p.document_id=d.id
                   GROUP BY d.title, d.status ORDER BY d.created_at"""
            )
            for title, status, parsed, total in cur.fetchall():
                print(f"{title}\t{status}\t{parsed}/{total} 页已解析")
    elif args.cmd == "golden-extract":
        from kb.golden import extract
        out = extract(conn, args.doc_id, Path(args.dir))
        print(f"导出 {len(out)} 页黄金稿，请人工校对: {args.dir}/{args.doc_id}/")
    elif args.cmd == "golden-check":
        from kb.golden import check
        check(conn, cfg, args.doc_id, Path(args.dir))


if __name__ == "__main__":
    main()
