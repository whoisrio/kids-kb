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
