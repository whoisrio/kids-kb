"""解析来源与远端 token 消耗入库：blocks.source_model/tokens + llm_calls 流水。"""
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
def parsed_doc(conn, tmp_path):
    from kb.layout import run_layout
    from kb.render import render_document

    cfg = _cfg(tmp_path)
    p = tmp_path / "scan.pdf"
    d = fitz.open()
    d.new_page()
    d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)
    return doc_id, cfg


class UsageChat:
    """带 token 用量的假远端响应。"""

    class completions:
        @staticmethod
        def create(model, messages, max_tokens):
            class M:
                content = "远端转录"

            class C:
                message = M()

            class U:
                prompt_tokens = 1200
                completion_tokens = 80

            class R:
                choices = [C()]
                usage = U()

            return R()


class UsageClient:
    chat = UsageChat()


def test_parse_records_source_and_tokens(conn, parsed_doc):
    """远端转录块：source_model=模型名 + token 入块 + llm_calls 流水；本地 ocr 块只有来源。"""
    from kb.parse import run_parse

    doc_id, cfg = parsed_doc
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM blocks ORDER BY created_at LIMIT 2")
        b1, b2 = [r[0] for r in cur.fetchall()]
        cur.execute("UPDATE blocks SET block_type='text' WHERE id=%s", (b1,))
        cur.execute("UPDATE blocks SET block_type='formula' WHERE id=%s", (b2,))

    n = run_parse(conn, cfg, doc_id, client=UsageClient(), ocr=lambda p: "本地OCR")
    assert n == 2
    with conn.cursor() as cur:
        cur.execute(
            "SELECT source_model, prompt_tokens, completion_tokens FROM blocks WHERE id=%s", (b1,))
        assert cur.fetchone() == ("rapidocr", None, None)  # 本地引擎，无 token
        cur.execute(
            "SELECT source_model, prompt_tokens, completion_tokens FROM blocks WHERE id=%s", (b2,))
        assert cur.fetchone() == ("qwen3:4b", 1200, 80)
        cur.execute(
            "SELECT purpose, model, prompt_tokens, completion_tokens FROM llm_calls "
            "WHERE document_id=%s", (doc_id,))
        assert cur.fetchall() == [("transcribe", "qwen3:4b", 1200, 80)]


def test_reprocess_marks_paddleocr_source(conn, tmp_path):
    """PaddleOCR-VL 整管线产出的块标记本地引擎来源。"""
    from kb.layout import run_layout
    from kb.render import render_document
    from kb.reprocess import reprocess_pages_paddleocr
    from tests.test_reprocess import FAKE_BLOCKS, FakeVL

    cfg = _cfg(tmp_path)
    p = tmp_path / "b.pdf"
    d = fitz.open()
    d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)
    reprocess_pages_paddleocr(conn, cfg, doc_id, [1], pipeline=FakeVL(FAKE_BLOCKS))
    with conn.cursor() as cur:
        cur.execute("SELECT DISTINCT source_model FROM blocks")
        assert cur.fetchall() == [("paddleocr-vl-1.5",)]


def test_record_llm_call_paper_fields(conn):
    from kb.metering import record_llm_call

    cid = str(uuid.uuid4())
    conn.execute("INSERT INTO children (id, name) VALUES (%s,'小宝')", (cid,))
    pid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO papers (id, child_id, title, subject) VALUES (%s,%s,'卷','数学')",
        (pid, cid),
    )
    record_llm_call(conn, None, "paper_vlm", "qwen3.8-27b", (11, 22),
                    paper_id=pid, modality="image")
    row = conn.execute(
        "SELECT document_id, paper_id, purpose, model, modality, prompt_tokens, completion_tokens "
        "FROM llm_calls ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    # psycopg 把 uuid 列读成 UUID 对象,与插入的字符串比较前先归一
    assert row == (None, uuid.UUID(pid), "paper_vlm", "qwen3.8-27b", "image", 11, 22)


def test_structure_records_llm_call(conn, tmp_path):
    """章节拆条走远端 -> llm_calls 记 purpose=structure。"""
    from kb.layout import run_layout
    from kb.render import render_document
    from kb.structure import structure_chapter

    cfg = _cfg(tmp_path)
    p = tmp_path / "b.pdf"
    d = fitz.open()
    d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE blocks SET content_md='例1 内容'")
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, page_start, page_end)
               VALUES (%s,%s,1,'竖式谜',1,1)""",
            (str(uuid.uuid4()), doc_id),
        )

    class StructChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                class M:
                    content = '[{"content_type":"example","label":"例1","content_md":"例1","block_ids":[1]}]'

                class C:
                    message = M()

                class U:
                    prompt_tokens = 9000
                    completion_tokens = 500

                class R:
                    choices = [C()]
                    usage = U()

                return R()

    class StructClient:
        chat = StructChat()

    n = structure_chapter(conn, cfg, doc_id, 1, client=StructClient())
    assert n == 1
    with conn.cursor() as cur:
        cur.execute(
            "SELECT purpose, model, prompt_tokens, completion_tokens FROM llm_calls "
            "WHERE document_id=%s", (doc_id,))
        assert cur.fetchall() == [("structure", "qwen3:4b", 9000, 500)]
