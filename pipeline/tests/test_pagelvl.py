"""页级整页 VLM 转录：手动/自动触发、page_md 落库、token 计量、实质问题阈值。"""
import uuid

import pymupdf as fitz
import pytest


def _cfg(tmp_path):
    from kb.config import Config
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


@pytest.fixture()
def doc2(conn, tmp_path):
    """2 页文档：第 1 页有 2 条实质问题（bad_latex + layout_overlap），
    第 2 页只有页眉 empty（琐碎，不算实质问题）。"""
    from kb.layout import run_layout
    from kb.render import render_document

    cfg = _cfg(tmp_path)
    p = tmp_path / "s.pdf"
    d = fitz.open()
    for _ in range(2):
        d.new_page(width=200, height=200)
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET status='parsed'")
        # 第 1 页：块内容带 KaTeX 不支持的 \cline（run_qc 复算后 bad_latex 仍在），
        # 并复制一个重叠块让 layout_overlap 也可复算成立
        cur.execute(
            """UPDATE blocks SET content_md='$$ \\begin{array}{c|c} a & b \\\\ \\cline{2-2} \\end{array} $$',
                   bbox='[0,0,500,1000]'::jsonb
               WHERE page_id IN (SELECT id FROM pages WHERE page_no=1)"""
        )
        cur.execute(
            """INSERT INTO blocks (page_id, block_type, crop_path, content_md, bbox)
               SELECT page_id, 'text', '/tmp/c2.png', '另一块', '[10,10,490,990]'::jsonb
               FROM blocks WHERE page_id IN (SELECT id FROM pages WHERE page_no=1)"""
        )
        cur.execute(
            """INSERT INTO review_queue (block_id, reason)
               SELECT b.id, 'bad_latex' FROM blocks b
               JOIN pages p ON p.id=b.page_id WHERE p.page_no=1
               ORDER BY b.created_at LIMIT 1"""
        )
        cur.execute(
            """INSERT INTO review_queue (page_id, reason)
               SELECT p.id, 'layout_overlap' FROM pages p WHERE p.page_no=1"""
        )
        # 第 2 页：页眉空转录（琐碎问题）
        cur.execute("UPDATE blocks SET block_type='header', content_md='' WHERE page_id IN "
                    "(SELECT id FROM pages WHERE page_no=2)")
        cur.execute(
            """INSERT INTO review_queue (block_id, reason)
               SELECT b.id, 'empty' FROM blocks b
               JOIN pages p ON p.id=b.page_id WHERE p.page_no=2"""
        )
    return doc_id, cfg


class _Chat:
    class completions:
        @staticmethod
        def create(model, messages, max_tokens):
            class M:
                content = "# 整页转录\n例1 内容……"

            class C:
                message = M()

            class U:
                prompt_tokens = 5000
                completion_tokens = 600

            class R:
                choices = [C()]
                usage = U()

            return R()


class _Client:
    chat = _Chat()


def test_transcribe_page_stores_md_and_meters(conn, doc2):
    from kb.pagelvl import transcribe_page

    doc_id, cfg = doc2
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM pages WHERE page_no=1")
        page_id = str(cur.fetchone()[0])
    transcribe_page(conn, cfg, page_id, client=_Client())
    with conn.cursor() as cur:
        cur.execute("SELECT page_md, page_md_model, adopted_source FROM pages WHERE id=%s",
                    (page_id,))
        md, model, adopted = cur.fetchone()
        assert md.startswith("# 整页转录") and model == "qwen3:4b"
        assert adopted == "blocks"  # 转录不改变采用版本，由人工选
        cur.execute(
            "SELECT purpose, model, prompt_tokens FROM llm_calls WHERE purpose='page_vlm'")
        assert cur.fetchall() == [("page_vlm", "qwen3:4b", 5000)]
    transcribe_page(conn, cfg, page_id, client=_Client())  # 手动重发覆盖
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM llm_calls WHERE purpose='page_vlm'")
        assert cur.fetchone()[0] == 2


def test_auto_trigger_threshold(conn, doc2):
    """实质问题 ≥2 的页自动整页转录；只有页眉 empty 的页不触发。"""
    from kb.pagelvl import auto_page_vlm

    doc_id, cfg = doc2
    n = auto_page_vlm(conn, cfg, doc_id, client=_Client())
    assert n == 1
    with conn.cursor() as cur:
        cur.execute("SELECT page_no, page_md IS NOT NULL FROM pages ORDER BY page_no")
        assert cur.fetchall() == [(1, True), (2, False)]
    assert auto_page_vlm(conn, cfg, doc_id, client=_Client()) == 0  # 已有 page_md 不重复触发


def test_run_qc_auto_triggers_page_vlm(conn, doc2):
    """run_qc 传入 cfg 时，实质问题 ≥2 的页自动整页转录。"""
    from kb.qc import run_qc

    doc_id, cfg = doc2
    n = run_qc(conn, doc_id, cfg=cfg, vlm_client=_Client())
    with conn.cursor() as cur:
        cur.execute("SELECT page_no, page_md IS NOT NULL FROM pages ORDER BY page_no")
        assert cur.fetchall() == [(1, True), (2, False)]
