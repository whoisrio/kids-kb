"""0024：blocks.title_level——标题层级（1/2/3），NULL=未判定或非标题块。"""
import pytest

from kb.core.db import MIGRATIONS_DIR


def test_0024_title_level_nullable_and_check(conn):
    assert (MIGRATIONS_DIR / "0024_title_level.sql").exists()
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
        cur.execute(
            "INSERT INTO blocks (page_id, block_type, crop_path, ordinal) VALUES (%s, 'title', 'c.png', 1) RETURNING id::text",
            (page_id,),
        )
        block_id = cur.fetchone()[0]
        cur.execute("SELECT title_level FROM blocks WHERE id=%s", (block_id,))
        assert cur.fetchone()[0] is None  # 存量/新块默认未判定
        cur.execute("UPDATE blocks SET title_level=2 WHERE id=%s", (block_id,))
        cur.execute("SELECT title_level FROM blocks WHERE id=%s", (block_id,))
        assert cur.fetchone()[0] == 2
    with conn.cursor() as cur:
        with pytest.raises(Exception):  # CHECK 约束拒绝层级 0/4
            cur.execute("UPDATE blocks SET title_level=4 WHERE id=%s", (block_id,))
