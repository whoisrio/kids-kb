"""sync_block_reviews：块内容变化后同步复核行（新增可检测问题 + 关闭已修复），PATCH 与 run_qc 同一语义。"""
import pymupdf as fitz
import pytest


@pytest.fixture()
def doc1(conn, tmp_path):
    from kb.core.config import Config
    from kb.ocr.layout import run_layout
    from kb.ocr.render import render_document

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    p = tmp_path / "s.pdf"
    d = fitz.open()
    d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET parse_status='parsed'")
        cur.execute("UPDATE blocks SET content_md='完整的正文。' RETURNING id")
        block_id = cur.fetchone()[0]
    return doc_id, block_id


def test_sync_block_reviews_create_then_resolve(conn, doc1):
    from kb.ocr.qc import sync_block_reviews

    _doc_id, block_id = doc1
    assert sync_block_reviews(conn, block_id) == 0  # 好内容不建行

    with conn.cursor() as cur:  # 人工编辑反而引入截断
        cur.execute("UPDATE blocks SET content_md='这句话没说完，' WHERE id=%s", (block_id,))
    assert sync_block_reviews(conn, block_id) == 1  # 新增 maybe_truncated
    with conn.cursor() as cur:
        cur.execute("SELECT reason, status FROM review_queue WHERE block_id=%s", (block_id,))
        assert cur.fetchall() == [("maybe_truncated", "pending")]

    assert sync_block_reviews(conn, block_id) == 0  # 幂等，不重复建
    with conn.cursor() as cur:  # 修好后同步 -> 自动关闭
        cur.execute("UPDATE blocks SET content_md='完整的话。' WHERE id=%s", (block_id,))
    sync_block_reviews(conn, block_id)
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM review_queue WHERE block_id=%s", (block_id,))
        assert cur.fetchone()[0] == "approved"


def test_sync_block_reviews_keeps_custom_reason(conn, doc1):
    """自定义原因（人工标注）永远不被同步逻辑关闭。"""
    import uuid

    from kb.ocr.qc import sync_block_reviews

    _doc_id, block_id = doc1
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO review_queue (id, block_id, reason) VALUES (%s,%s,'语义错误')",
            (str(uuid.uuid4()), block_id),
        )
    sync_block_reviews(conn, block_id)
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM review_queue WHERE block_id=%s", (block_id,))
        assert cur.fetchone()[0] == "pending"
