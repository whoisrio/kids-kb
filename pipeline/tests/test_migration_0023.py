"""0023：pages.page_type——页类型（content/toc/ad/cover），非内容页默认排除索引。"""
import pytest

from kb.core.db import MIGRATIONS_DIR


def test_0023_page_type_default_and_check(conn):
    assert (MIGRATIONS_DIR / "0023_page_type.sql").exists()
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (title, source_path) VALUES ('t', '/tmp/a.pdf') RETURNING id::text"
        )
        doc_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO pages (document_id, page_no, image_path) VALUES (%s, 1, 'p.png') RETURNING id::text",
            (doc_id,),
        )
        page_id = cur.fetchone()[0]
        cur.execute("SELECT page_type, excluded_from_index FROM pages WHERE id=%s", (page_id,))
        assert cur.fetchone() == ("content", False)  # 存量/新页默认：正文、参与索引
    with conn.cursor() as cur:
        with pytest.raises(Exception):  # CHECK 约束拒绝未知类型
            cur.execute("UPDATE pages SET page_type='junk' WHERE id=%s", (page_id,))
