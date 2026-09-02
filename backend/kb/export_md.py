"""markdown 落盘镜像：DB 为唯一事实来源，文件只写不读（供人审/外部工具消费）。

页级：storage/<doc_id>/pages/pNNNN.md —— 该页采用版本内容（page_md 或块拼接，跳页眉页脚）。
章节级：storage/<doc_id>/chapters/cNN.md —— assemble_chapter 的整章组装稿。
路径只用不可变的 doc_id/页码/章号，不含标题等可变属性。
"""
from __future__ import annotations

from pathlib import Path

from kb.assemble import assemble_chapter
from kb.config import Config


def _adopted_page_md(cur, page_id: str, adopted: str, page_md: str | None) -> str:
    """单页采用版本内容：整页版优先，否则块拼接（跳页眉页脚，与 assemble_chapter 同规则）。"""
    if adopted == "page_md" and page_md:
        return page_md
    cur.execute(
        """SELECT content_md FROM blocks
           WHERE page_id=%s AND content_md IS NOT NULL
             AND block_type NOT IN ('header','footer')
           ORDER BY created_at, id""",
        (page_id,),
    )
    return "\n\n".join(r[0] for r in cur.fetchall())


def _page_md_path(cfg: Config, doc_id: str, page_no: int) -> Path:
    return Path(cfg.storage_dir) / doc_id / "pages" / f"p{page_no:04d}.md"


def export_page_md(conn, cfg: Config, doc_id: str, page_no: int) -> bool:
    """刷新单页镜像：有采用内容则写/覆盖，无内容则删旧文件。返回镜像是否存在。"""
    path = _page_md_path(cfg, doc_id, page_no)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT id, adopted_source, page_md FROM pages
               WHERE document_id=%s AND page_no=%s""",
            (doc_id, page_no),
        )
        row = cur.fetchone()
        if not row:
            return False
        text = _adopted_page_md(cur, *row)
    if not text.strip():
        path.unlink(missing_ok=True)  # 内容清空后旧镜像一并移除
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return True


def export_page_mds(conn, cfg: Config, doc_id: str) -> int:
    """每页采用版本内容镜像到 storage/<doc_id>/pages/pNNNN.md。返回写入文件数。"""
    n = 0
    with conn.cursor() as cur:
        cur.execute(
            """SELECT id, page_no, adopted_source, page_md FROM pages
               WHERE document_id=%s ORDER BY page_no""",
            (doc_id,),
        )
        rows = cur.fetchall()
        for page_id, page_no, adopted, page_md in rows:
            text = _adopted_page_md(cur, page_id, adopted, page_md)
            if not text.strip():
                continue  # 未解析页不落盘
            path = _page_md_path(cfg, doc_id, page_no)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            n += 1
    return n


def export_chapter_mds(conn, cfg: Config, doc_id: str) -> int:
    """每章组装稿镜像到 storage/<doc_id>/chapters/cNN.md。返回写入文件数。"""
    out_dir = Path(cfg.storage_dir) / doc_id / "chapters"
    with conn.cursor() as cur:
        cur.execute(
            """SELECT chapter_no FROM chapters
               WHERE document_id=%s AND page_start IS NOT NULL ORDER BY chapter_no""",
            (doc_id,),
        )
        chapter_nos = [r[0] for r in cur.fetchall()]
    n = 0
    for no in chapter_nos:
        text = assemble_chapter(conn, doc_id, no)
        if not text.strip():
            continue
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"c{no:02d}.md").write_text(text, encoding="utf-8")
        n += 1
    return n
