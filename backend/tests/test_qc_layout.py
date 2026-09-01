"""版面忠实度检查：覆盖不足/块间重叠 -> 页级复核行（重跑版面后机器可复算关闭）。"""
import uuid

import pymupdf as fitz
import pytest


def test_check_page_layout_pure():
    from kb.qc import check_page_layout
    # 覆盖 1% -> 漏切
    assert check_page_layout([(0, 0, 100, 100)], 1000, 1000) == ["layout_gap"]
    # 覆盖 100% -> 正常
    assert check_page_layout([(0, 0, 1000, 800), (0, 800, 1000, 1000)], 1000, 1000) == []
    # 两块几乎完全重叠
    assert "layout_overlap" in check_page_layout(
        [(0, 0, 500, 1000), (10, 10, 490, 990)], 1000, 1000)
    # 无 bbox（骨架期整页块）不检查
    assert check_page_layout([], 1000, 1000) == []


def test_run_qc_page_layout_rows(conn, tmp_path):
    """块覆盖不足的页建页级 layout_gap 复核行；修复 bbox 后 run_qc 自动关闭。"""
    from kb.config import Config
    from kb.layout import run_layout
    from kb.qc import CHECKABLE_REASONS, run_qc
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
    d.new_page(width=200, height=200)
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)  # 骨架期整页块无 bbox
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET status='parsed'")
        cur.execute("UPDATE blocks SET content_md='正文'")  # 块级无问题
        # 人为造一个只覆盖左上角 5% 的 bbox
        cur.execute("UPDATE blocks SET bbox='[0,0,20,100]'::jsonb")

    assert {"layout_gap", "layout_overlap"} <= CHECKABLE_REASONS  # 可自动关闭
    assert run_qc(conn, doc_id) == 1
    with conn.cursor() as cur:
        cur.execute(
            "SELECT reason, block_id, page_id FROM review_queue WHERE status='pending'")
        reason, block_id, page_id = cur.fetchone()
        assert reason == "layout_gap"
        assert block_id is None  # 页级行不锚定块
        assert page_id is not None

    with conn.cursor() as cur:  # 模拟重跑版面后块覆盖全页（超出图幅会被网格裁剪）
        cur.execute("UPDATE blocks SET bbox='[0,0,2000,2000]'::jsonb")
    assert run_qc(conn, doc_id) == 0  # 不新增
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM review_queue WHERE reason='layout_gap'")
        assert cur.fetchone()[0] == "approved"  # 机器复算通过，自动关闭
