import pymupdf as fitz
import pytest

from kb.config import Config


def _cfg(tmp_path):
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


class FakeMessage:
    content = "转录结果 $1+1=2$"


class FakeChoice:
    message = FakeMessage()


class FakeResponse:
    choices = [FakeChoice()]


class FakeChat:
    class completions:
        @staticmethod
        def create(model, messages, max_tokens):
            assert model == "qwen3:4b"
            return FakeResponse()


class FakeClient:
    chat = FakeChat()


def test_transcribe_image_calls_openai_compatible_api(tmp_path):
    from kb.parse import transcribe_image

    img = tmp_path / "p.png"
    img.write_bytes(b"\x89PNG fake")
    text = transcribe_image(FakeClient(), "qwen3:4b", img)
    assert text == "转录结果 $1+1=2$"


def test_run_parse_fills_block_content_and_marks_page(conn, parsed_doc):
    from kb.parse import run_parse

    doc_id, cfg = parsed_doc
    n = run_parse(conn, cfg, doc_id, client=FakeClient())
    assert n == 2
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM blocks WHERE content_md IS NOT NULL")
        assert cur.fetchone()[0] == 2
        cur.execute("SELECT status FROM pages WHERE document_id=%s", (doc_id,))
        assert {r[0] for r in cur.fetchall()} == {"parsed"}


def test_run_parse_failure_marks_page_failed(conn, parsed_doc):
    from kb.parse import run_parse

    class BoomChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                raise RuntimeError("模型挂了")

    class BoomClient:
        chat = BoomChat()

    doc_id, cfg = parsed_doc
    n = run_parse(conn, cfg, doc_id, client=BoomClient())
    assert n == 0
    with conn.cursor() as cur:
        cur.execute("SELECT status, parse_error FROM pages WHERE document_id=%s", (doc_id,))
        rows = cur.fetchall()
    assert all(s == "failed" and "模型挂了" in (e or "") for s, e in rows)
