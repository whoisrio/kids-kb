import pymupdf as fitz
import pytest

from kb.config import Config
from kb.layout import WholePageLayout, run_layout
from kb.render import render_document


@pytest.fixture()
def doc_id(conn, tmp_path):
    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    p = tmp_path / "scan.pdf"
    d = fitz.open()
    d.new_page()
    d.new_page()
    d.save(p)
    return render_document(conn, cfg, p, title="t"), cfg


def test_whole_page_layout_returns_single_block(doc_id):
    _id, cfg = doc_id
    draft = WholePageLayout().analyze("page-1", f"{cfg.storage_dir}/x/p0001.png")
    assert len(draft) == 1
    assert draft[0].block_type == "page"
    assert draft[0].bbox is None


def test_run_layout_inserts_blocks_idempotent(doc_id, conn):
    _id, _cfg = doc_id
    assert run_layout(conn, _id) == 2
    assert run_layout(conn, _id) == 0  # 幂等：已有 blocks 的页跳过


def test_run_layout_force_relayouts(doc_id, conn):
    """force=True 时清掉无复核引用的旧 blocks 重新切版；有复核记录的块保留。"""
    from kb.layout import BlockDraft

    _id, _cfg = doc_id
    assert run_layout(conn, _id) == 2  # 整页占位，2 页各 1 块

    class FakeTwoBlock:
        def analyze(self, page_id, image_path):
            return [
                BlockDraft(page_id=page_id, block_type="text", bbox=(0, 0, 1, 1), crop_path="a.png"),
                BlockDraft(page_id=page_id, block_type="figure", bbox=(0, 1, 1, 2), crop_path="b.png"),
            ]

    assert run_layout(conn, _id, analyzer=FakeTwoBlock()) == 0  # 已有块，跳过
    # 给第 1 页的块挂一条复核记录 -> force 时该页保留
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO review_queue (block_id, reason)
               SELECT b.id, 'empty' FROM blocks b JOIN pages p ON p.id=b.page_id
               WHERE p.page_no=1"""
        )
    assert run_layout(conn, _id, analyzer=FakeTwoBlock(), force=True) == 2  # 只重切第 2 页
    with conn.cursor() as cur:
        cur.execute(
            """SELECT p.page_no, b.block_type FROM blocks b
               JOIN pages p ON p.id=b.page_id ORDER BY p.page_no, b.block_type"""
        )
        rows = cur.fetchall()
    assert rows[0] == (1, "page")  # 有复核记录的第 1 页保持原块
    assert [(r[0], r[1]) for r in rows[1:]] == [(2, "figure"), (2, "text")]
