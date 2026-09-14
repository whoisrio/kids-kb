"""0022：blocks.block_type_origin——block_type 血缘（layout 版面检测 | vlm VLM 改判）。"""
from kb.core.db import MIGRATIONS_DIR


def test_0022_block_type_origin_default(conn):
    assert (MIGRATIONS_DIR / "0022_block_type_origin.sql").exists()
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
            "INSERT INTO blocks (page_id, block_type, crop_path, ordinal)"
            " VALUES (%s, 'text', 'c.png', 1) RETURNING id::text",
            (page_id,),
        )
        block_id = cur.fetchone()[0]
        cur.execute("SELECT block_type_origin FROM blocks WHERE id=%s", (block_id,))
        assert cur.fetchone()[0] == "layout"  # 存量/新块默认：类型来自版面检测
