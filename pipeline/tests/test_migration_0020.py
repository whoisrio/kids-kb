"""0020：blocks 血缘/几何列 + chunks.state。"""
from kb.core.db import MIGRATIONS_DIR


def test_0020_columns_exist_with_defaults(conn):
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
        cur.execute(
            "SELECT origin, parent_block_ids, geometry_revision FROM blocks WHERE id=%s",
            (block_id,),
        )
        assert cur.fetchone() == ("layout", [], 1)  # 存量默认：原生块、无血缘、几何未动过
        cur.execute(
            "INSERT INTO items (document_id, content_type, content_md) VALUES (%s, 'exercise', '题') RETURNING id::text",
            (doc_id,),
        )
        item_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO chunks (document_id, item_id, content_md, embedding) VALUES (%s, %s, '题', %s) RETURNING id::text",
            (doc_id, item_id, [1.0] * 1024),
        )
        chunk_id = cur.fetchone()[0]
        cur.execute("SELECT state FROM chunks WHERE id=%s", (chunk_id,))
        assert cur.fetchone()[0] == "indexed"
        cur.execute("SELECT 1 FROM pg_attribute WHERE attrelid='chunks'::regclass AND attname='item_revision'")
        assert cur.fetchone() is None  # item_revision 归子系统 5，本 migration 不加
