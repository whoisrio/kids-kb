import pymupdf as fitz
import pytest


def _mk_cfg(tmp_path, compare_model="compare-model"):
    from kb.core.config import Config
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="primary-model",
        vision_compare_model=compare_model,
    )


@pytest.fixture()
def doc_with_blocks(conn, tmp_path):
    from kb.ocr.layout import run_layout
    from kb.ocr.render import render_document

    cfg = _mk_cfg(tmp_path)
    p = tmp_path / "s.pdf"
    d = fitz.open()
    d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET parse_status='parsed'")
        cur.execute("UPDATE blocks SET block_type='formula', content_md='正确内容 $1+1=2$'")
    return doc_id, cfg


def _client(text):
    class Chat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                class M:
                    content = text

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class Client:
        chat = Chat()

    return Client()


def test_crosscheck_flags_divergent_formula_block(conn, doc_with_blocks):
    from kb.ocr.crosscheck import run_llm_crosscheck

    doc_id, cfg = doc_with_blocks
    n = run_llm_crosscheck(conn, cfg, doc_id, compare_client=_client("完全不同的内容"))
    assert n == 1
    with conn.cursor() as cur:
        cur.execute("SELECT reason, status FROM review_queue")
        assert cur.fetchone() == ("llm_disagree", "pending")


def test_crosscheck_quiet_when_consistent(conn, doc_with_blocks):
    from kb.ocr.crosscheck import run_llm_crosscheck

    doc_id, cfg = doc_with_blocks
    n = run_llm_crosscheck(conn, cfg, doc_id, compare_client=_client("正确内容 $1+1=2$"))
    assert n == 0


def test_llm_disagree_not_auto_closed(conn, doc_with_blocks):
    """llm_disagree 不在 CHECKABLE_REASONS：内容再编辑也不自动关闭。"""
    from kb.ocr.qc import sync_block_reviews

    doc_id, cfg = doc_with_blocks
    with conn.cursor() as cur:
        cur.execute("INSERT INTO review_queue (block_id, reason) SELECT id, 'llm_disagree' FROM blocks")
        cur.execute("SELECT id FROM blocks")
        block_id = str(cur.fetchone()[0])
    sync_block_reviews(conn, block_id)
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM review_queue WHERE reason='llm_disagree'")
        assert cur.fetchone()[0] == "pending"


def test_crosscheck_skipped_without_compare_config(conn, tmp_path):
    from kb.ocr.crosscheck import run_llm_crosscheck

    cfg = _mk_cfg(tmp_path, compare_model=None)
    assert run_llm_crosscheck(conn, cfg, "任意doc") == 0
