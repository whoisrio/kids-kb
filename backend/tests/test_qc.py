import fitz
import pytest


def test_check_content_flags_empty():
    from kb.qc import check_content
    assert check_content("") == ["empty"]
    assert check_content("   \n ") == ["empty"]


def test_check_content_flags_truncation():
    from kb.qc import check_content
    assert "maybe_truncated" in check_content("解答过程类似猜谜语游戏，")
    assert check_content("完整的句子。") == []


def test_run_qc_inserts_review_rows(conn, tmp_path):
    from kb.config import Config
    from kb.layout import run_layout
    from kb.qc import run_qc
    from kb.render import render_document

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
        cur.execute("UPDATE pages SET status='parsed'")
        cur.execute("UPDATE blocks SET content_md=''")  # 模拟空转录
    assert run_qc(conn, doc_id) == 1
    with conn.cursor() as cur:
        cur.execute("SELECT reason FROM review_queue")
        assert cur.fetchone()[0] == "empty"
    assert run_qc(conn, doc_id) == 0  # 幂等
