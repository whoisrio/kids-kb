"""0019：crop_pad 列 + 存量路径重写到 KB_STORAGE_DIR 相对基准。"""
from kb.core.db import MIGRATIONS_DIR


def _apply_before(clean_db, stop_name: str) -> None:
    """按文件名顺序手工应用 0019 之前的全部 migration（不经 schema_migrations 记账）。"""
    with clean_db.cursor() as cur:
        for p in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if p.name >= stop_name:
                break
            cur.execute(p.read_text(encoding="utf-8"))


def test_0019_rewrites_legacy_paths(clean_db):
    _apply_before(clean_db, "0019_crop_pad_paths.sql")
    with clean_db.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (title, source_path) VALUES ('t', '/tmp/a.pdf') RETURNING id::text"
        )
        doc_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO pages (document_id, page_no, image_path)"
            " VALUES (%s, 1, 'storage/' || %s || '/pages/p0001.png') RETURNING id::text",
            (doc_id, doc_id),
        )
        page_id = cur.fetchone()[0]
        # 形态一：layout.py 旧产物 storage/blocks/<page_id>/b000.png
        cur.execute(
            "INSERT INTO blocks (page_id, block_type, crop_path, ordinal)"
            " VALUES (%s, 'text', 'storage/blocks/' || %s || '/b000.png', 1)",
            (page_id, page_id),
        )
        # 形态二：旧 fixture 形态 storage/<doc_id>/blocks/b1.png
        cur.execute(
            "INSERT INTO blocks (page_id, block_type, crop_path, ordinal)"
            " VALUES (%s, 'text', 'storage/' || %s || '/blocks/b1.png', 2)",
            (page_id, doc_id),
        )
        cur.execute("INSERT INTO children (name) VALUES ('试') RETURNING id::text")
        child_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO papers (child_id, title, subject) VALUES (%s, '卷', '数学') RETURNING id::text",
            (child_id,),
        )
        paper_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md, image_path)"
            " VALUES (%s, 1, 1, 'q', '/Users/x/pipeline/storage/papers/' || %s || '/questions/p0001_q01.png')",
            (paper_id, paper_id),
        )
        cur.execute((MIGRATIONS_DIR / "0019_crop_pad_paths.sql").read_text(encoding="utf-8"))

        cur.execute("SELECT image_path FROM pages WHERE id=%s", (page_id,))
        assert cur.fetchone()[0] == f"{doc_id}/pages/p0001.png"
        cur.execute("SELECT crop_path FROM blocks WHERE page_id=%s ORDER BY ordinal", (page_id,))
        crops = [r[0] for r in cur.fetchall()]
        assert crops[0] == f"{doc_id}/blocks/{page_id}/b000.png"
        assert crops[1] == f"{doc_id}/blocks/b1.png"
        cur.execute("SELECT image_path FROM paper_questions WHERE paper_id=%s", (paper_id,))
        assert cur.fetchone()[0] == f"papers/{paper_id}/questions/p0001_q01.png"
        cur.execute("SELECT crop_pad FROM blocks WHERE page_id=%s LIMIT 1", (page_id,))
        assert cur.fetchone()[0] is None
