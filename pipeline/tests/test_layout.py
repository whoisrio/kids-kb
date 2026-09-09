import pymupdf as fitz
import pytest

from kb.core.config import Config
from kb.ocr.layout import WholePageLayout, run_layout
from kb.ocr.render import render_document


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
    from kb.ocr.layout import BlockDraft

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


def test_run_layout_writes_ordinal(doc_id, conn):
    """run_layout 落库 ordinal：analyzer 给了用 analyzer 的，没给按返回顺序 1..N。"""
    from kb.ocr.layout import BlockDraft

    _id, _cfg = doc_id

    class FakeTwoBlock:
        def analyze(self, page_id, image_path):
            return [
                BlockDraft(page_id=page_id, block_type="text", bbox=(0, 0, 1, 1), crop_path="a.png"),
                BlockDraft(page_id=page_id, block_type="figure", bbox=(0, 1, 1, 2), crop_path="b.png"),
            ]

    assert run_layout(conn, _id, analyzer=FakeTwoBlock()) == 4
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.ordinal, b.block_type FROM blocks b
               JOIN pages p ON p.id=b.page_id ORDER BY p.page_no, b.ordinal"""
        )
        rows = cur.fetchall()
    assert rows == [(1, "text"), (2, "figure"), (1, "text"), (2, "figure")]


def test_run_layout_with_cfg_writes_relative_paths(doc_id, conn):
    """cfg 传入时：crop_path 落库为 <doc_id>/blocks/... 相对形态（spec §7.1）。"""
    from kb.ocr.layout import BlockDraft

    _id, cfg = doc_id

    class FakeOne:
        def analyze(self, page_id, image_path):
            out = cfg.storage_dir / _id / "blocks" / page_id / "b000.png"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"png")
            return [BlockDraft(page_id=page_id, block_type="text", bbox=(0, 0, 1, 1),
                               crop_path=str(out), ordinal=1, crop_pad=[6, 4])]

    assert run_layout(conn, _id, analyzer=FakeOne(), cfg=cfg) == 2
    with conn.cursor() as cur:
        cur.execute("SELECT crop_path, crop_pad FROM blocks ORDER BY ordinal LIMIT 1")
        crop_path, crop_pad = cur.fetchone()
    assert crop_path.startswith(f"{_id}/blocks/")
    assert not crop_path.startswith("storage/")
    assert crop_pad == [6, 4]


def test_page_contents_follow_ordinal_not_created_at(doc_id, conn):
    """created_at 与 ordinal 顺序相反时，采用内容按 ordinal 排（验收 14 口径）。"""
    from kb.ocr.layout import BlockDraft
    from kb.rag.flat import page_contents

    _id, _cfg = doc_id

    class FakeTwo:
        def analyze(self, page_id, image_path):
            return [
                BlockDraft(page_id=page_id, block_type="text", bbox=(0, 0, 1, 1),
                           crop_path="a.png", ordinal=1),
                BlockDraft(page_id=page_id, block_type="text", bbox=(0, 1, 1, 2),
                           crop_path="b.png", ordinal=2),
            ]

    assert run_layout(conn, _id, analyzer=FakeTwo()) > 0
    with conn.cursor() as cur:
        cur.execute("UPDATE blocks SET content_md='甲', created_at='2020-01-02' WHERE ordinal=1")
        cur.execute("UPDATE blocks SET content_md='乙', created_at='2020-01-01' WHERE ordinal=2")
        contents = page_contents(cur, _id)
    assert contents[0] == (1, "甲\n乙")
