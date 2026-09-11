"""markdown 落盘镜像：DB 为唯一事实来源，文件只写不读。

页级 storage/<doc_id>/pages/pNNNN.md；章节级 storage/<doc_id>/chapters/cNN.md。
"""
import uuid

import pytest

from kb.core.config import Config
from kb.rag.export_md import export_chapter_mds, export_page_mds


@pytest.fixture()
def doc(conn, tmp_path):
    """1 本书：页 2 块版（含页眉块）+ 页 3 整页版 + 页 4 无内容；第 1 章跨 2-3 页。"""
    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/b.pdf') RETURNING id",
            (str(uuid.uuid4()),),
        )
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, page_start, page_end)
               VALUES (%s,%s,1,'竖式谜',2,3)""",
            (str(uuid.uuid4()), doc_id),
        )
        cur.execute(
            """INSERT INTO pages (id, document_id, page_no, image_path, parse_status)
               VALUES (%s,%s,2,'/tmp/p2.png','parsed') RETURNING id""",
            (str(uuid.uuid4()), doc_id),
        )
        p2 = str(cur.fetchone()[0])
        for btype, content in [("header", "四年级上册 页眉"), ("text", "例1 题干"), ("text", "例1 解析")]:
            cur.execute(
                """INSERT INTO blocks (id, page_id, block_type, crop_path, content_md, ordinal)
                   VALUES (%s,%s,%s,'/tmp/c.png',%s,
                           (SELECT coalesce(max(ordinal), 0) + 1 FROM blocks WHERE page_id=%s))""",
                (str(uuid.uuid4()), p2, btype, content, p2),
            )
        cur.execute(
            """INSERT INTO pages (id, document_id, page_no, image_path, parse_status, page_md, adopted_source)
               VALUES (%s,%s,3,'/tmp/p3.png','parsed','整页转录内容','page_md')""",
            (str(uuid.uuid4()), doc_id),
        )
        cur.execute(
            """INSERT INTO pages (id, document_id, page_no, image_path, parse_status)
               VALUES (%s,%s,4,'/tmp/p4.png','pending')""",
            (str(uuid.uuid4()), doc_id),
        )
    return conn, cfg, doc_id


def test_export_page_mds_mirrors_adopted_content(doc):
    """块版页拼块文本（跳页眉页脚），整页版页用 page_md。"""
    conn, cfg, doc_id = doc
    n = export_page_mds(conn, cfg, doc_id)
    assert n == 2  # 页 4 无内容，不落盘
    p2 = (cfg.storage_dir / doc_id / "pages" / "p0002.md").read_text(encoding="utf-8")
    assert "例1 题干" in p2 and "例1 解析" in p2
    assert "页眉" not in p2
    p3 = (cfg.storage_dir / doc_id / "pages" / "p0003.md").read_text(encoding="utf-8")
    assert p3 == "整页转录内容"


def test_export_page_mds_skips_pages_without_content(doc):
    conn, cfg, doc_id = doc
    export_page_mds(conn, cfg, doc_id)
    assert not (cfg.storage_dir / doc_id / "pages" / "p0004.md").exists()


def test_export_page_mds_overwrites_on_rerun(doc):
    """重跑覆盖旧文件（页内容更新后镜像跟随）。"""
    conn, cfg, doc_id = doc
    export_page_mds(conn, cfg, doc_id)
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE blocks SET content_md='例1 修订后题干'
               WHERE content_md='例1 题干'"""
        )
    export_page_mds(conn, cfg, doc_id)
    p2 = (cfg.storage_dir / doc_id / "pages" / "p0002.md").read_text(encoding="utf-8")
    assert "修订后题干" in p2


def test_export_chapter_mds(doc):
    """章节稿按章号落盘（不可变路径，不含标题）。"""
    conn, cfg, doc_id = doc
    n = export_chapter_mds(conn, cfg, doc_id)
    assert n == 1
    text = (cfg.storage_dir / doc_id / "chapters" / "c01.md").read_text(encoding="utf-8")
    assert "例1 题干" in text  # 页 2 块版内容进章稿
    assert "整页转录内容" in text  # 页 3 整页版内容进章稿
    assert "页眉" not in text


def test_export_chapter_mds_skips_chapters_without_pages(doc):
    """页码未校准（page_start NULL）的章不落盘。"""
    conn, cfg, doc_id = doc
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title)
               VALUES (%s,%s,2,'未校准章')""",
            (str(uuid.uuid4()), doc_id),
        )
    assert export_chapter_mds(conn, cfg, doc_id) == 1  # 仍只有第 1 章
    assert not (cfg.storage_dir / doc_id / "chapters" / "c02.md").exists()


def test_export_chapter_mds_for_docx_chapter(conn, tmp_path):
    """content_md 章（无页）：章稿直接取章原文。"""
    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/f.docx') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,1,'选择题','# 一、选择题\n\n1. 题干')""",
            (str(uuid.uuid4()), doc_id),
        )
    n = export_chapter_mds(conn, cfg, doc_id)
    assert n == 1
    text = (cfg.storage_dir / doc_id / "chapters" / "c01.md").read_text(encoding="utf-8")
    assert "题干" in text
