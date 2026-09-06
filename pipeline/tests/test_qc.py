import pymupdf as fitz
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
        cur.execute("UPDATE pages SET parse_status='parsed'")
        cur.execute("UPDATE blocks SET content_md=''")  # 模拟空转录
    assert run_qc(conn, doc_id) == 1
    with conn.cursor() as cur:
        cur.execute("SELECT reason FROM review_queue")
        assert cur.fetchone()[0] == "empty"
    assert run_qc(conn, doc_id) == 0  # 幂等


def test_run_qc_skips_empty_for_figure_blocks(conn, tmp_path):
    """figure 块的内容就是裁图本身（如竖式图），空 content_md 是正常态，不进复核队列。"""
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
        cur.execute("UPDATE pages SET parse_status='parsed'")
        cur.execute("UPDATE blocks SET block_type='figure', content_md=''")
    assert run_qc(conn, doc_id) == 0
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM review_queue")
        assert cur.fetchone()[0] == 0


def test_run_qc_auto_resolves_stale_review_rows(conn, tmp_path):
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
    with conn.cursor() as cur:  # 先失败 -> 产生 empty 复核行
        cur.execute("UPDATE pages SET parse_status='failed', parse_error='x'")
    assert run_qc(conn, doc_id) == 1
    with conn.cursor() as cur:  # 重试成功 -> 复核行应自动关闭
        cur.execute("UPDATE pages SET parse_status='parsed', parse_error=NULL")
        cur.execute("UPDATE blocks SET content_md='完整内容。'")
    assert run_qc(conn, doc_id) == 0
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM review_queue")
        assert cur.fetchone()[0] == "approved"


def test_run_qc_keeps_custom_reason_rows(conn, tmp_path):
    """人工插入的自定义原因复核行不能被 run_qc 自动关闭——机器只能关闭自己可检测的原因。"""
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
        cur.execute("UPDATE pages SET parse_status='parsed'")
        cur.execute("UPDATE blocks SET content_md='内容正常。'")
        cur.execute("INSERT INTO review_queue (block_id, reason) SELECT id, '幻觉前缀' FROM blocks")
    assert run_qc(conn, doc_id) == 0  # 不新增
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM review_queue WHERE reason='幻觉前缀'")
        assert cur.fetchone()[0] == "pending"  # 自定义行存活


def test_check_content_flags_bad_latex():
    from kb.qc import check_content
    assert "bad_latex" in check_content("公式坏了：$\\frac{1$ 缺括号")
    assert check_content("公式正常：$\\frac{1}{2}$ 和 $$x^2$$") == []


def test_bad_latex_auto_resolves_after_fix(conn, tmp_path):
    """bad_latex 属可机器复判原因：修复后 sync_block_reviews 自动关闭。"""
    import pymupdf as fitz

    from kb.config import Config
    from kb.layout import run_layout
    from kb.qc import sync_block_reviews
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
        cur.execute("SELECT id FROM blocks")
        block_id = str(cur.fetchone()[0])
        cur.execute("INSERT INTO review_queue (block_id, reason) VALUES (%s,'bad_latex')", (block_id,))
        cur.execute("UPDATE blocks SET content_md='修好了 $\\frac{1}{2}$' WHERE id=%s", (block_id,))
    sync_block_reviews(conn, block_id)
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM review_queue WHERE reason='bad_latex'")
        assert cur.fetchone()[0] == "approved"


def test_check_label_continuity_flags_missing(conn, tmp_path):
    """第 1 章有 1、3 题缺 2 -> 建 missing_item 复核行；且不属可自动关闭原因。"""
    import uuid

    from kb.config import Config
    from kb.qc import CHECKABLE_REASONS, check_label_continuity

    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/b.pdf') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO chapters (document_id, chapter_no, title) VALUES (%s, 1, '竖式谜')",
            (doc_id,),
        )
        for label in ("1", "3"):
            cur.execute(
                """INSERT INTO items (id, document_id, content_type, label, content_md, chapter)
                   VALUES (%s,%s,'exercise',%s,'题','第 1 讲 竖式谜')""",
                (str(uuid.uuid4()), doc_id, label),
            )
    assert "missing_item" not in CHECKABLE_REASONS
    assert check_label_continuity(conn, doc_id) == 1
    with conn.cursor() as cur:
        cur.execute("SELECT reason FROM review_queue WHERE reason LIKE 'missing_item%'")
        assert "第 1 讲" in cur.fetchone()[0]


def test_check_label_continuity_handles_grouped_labels(conn, tmp_path):
    """3-1/3-3 这类"例N-第M题"题号按组检查连续性：缺 3-2 要建 missing_item 复核行。"""
    import uuid

    from kb.qc import check_label_continuity

    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/b.pdf') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        for label in ("3-1", "3-3"):
            cur.execute(
                """INSERT INTO items (id, document_id, content_type, label, content_md, chapter)
                   VALUES (%s,%s,'exercise',%s,'题','第 1 讲 竖式谜')""",
                (str(uuid.uuid4()), doc_id, label),
            )
    assert check_label_continuity(conn, doc_id) == 1
    with conn.cursor() as cur:
        cur.execute("SELECT reason FROM review_queue WHERE reason LIKE 'missing_item%'")
        assert "3-2" in cur.fetchone()[0]
