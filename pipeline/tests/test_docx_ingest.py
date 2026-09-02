"""docx 入库：pandoc 转 markdown -> 按标题切章 -> chapters.content_md + 章稿落盘。"""
import subprocess
import uuid

import pytest

from kb.config import Config

pandoc_missing = pytest.mark.skipif(
    subprocess.run(["which", "pandoc"], capture_output=True).returncode != 0,
    reason="需要 pandoc",
)


@pytest.fixture()
def docx_file(tmp_path):
    """pandoc 现场合成 docx：两个大题标题 + 卷首。"""
    md = tmp_path / "paper.md"
    md.write_text(
        "语法一阶 期末测试\n\n# 一、选择题\n\n1. He ___ to school by bus.\n\n# 二、填空题\n\n5. 用所给词的适当形式 ___ (go)。\n",
        encoding="utf-8",
    )
    docx = tmp_path / "paper.docx"
    subprocess.run(["pandoc", "-f", "gfm", "-t", "docx", "-o", str(docx), str(md)], check=True)
    return docx


@pytest.fixture()
def cfg(tmp_path):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


@pandoc_missing
def test_ingest_docx_splits_chapters(conn, cfg, docx_file):
    from kb.docx_ingest import ingest_docx

    doc_id = ingest_docx(conn, cfg, docx_file, title="语法一阶 期末测试",
                         subject="英语", doc_type="exam")
    with conn.cursor() as cur:
        cur.execute(
            "SELECT chapter_no, title, content_md, page_start FROM chapters WHERE document_id=%s ORDER BY chapter_no",
            (doc_id,),
        )
        rows = cur.fetchall()
    assert len(rows) == 2
    assert rows[0][1] == "一、选择题"
    md0 = rows[0][2].replace("\\", "")  # gfm 会对 ___ 转义（\_\_\_）
    assert "He ___ to school by bus" in md0
    assert "语法一阶 期末测试" in rows[0][2]  # 卷首并入第一章
    assert rows[0][3] is None  # docx 无页码
    assert rows[1][1] == "二、填空题"
    # 章稿落盘
    c01 = cfg.storage_dir / doc_id / "chapters" / "c01.md"
    assert c01.exists() and "选择题" in c01.read_text(encoding="utf-8")
    # documents 行
    with conn.cursor() as cur:
        cur.execute("SELECT doc_type, subject, page_count FROM documents WHERE id=%s", (doc_id,))
        r = cur.fetchone()
    assert r == ("exam", "英语", 0)


def test_split_chapters_no_heading():
    """无标题文档整份为单章。"""
    from kb.docx_ingest import split_chapters

    chapters = split_chapters("纯文字没有标题\n第二行", "文档标题")
    assert chapters == [("文档标题", "纯文字没有标题\n第二行")]
