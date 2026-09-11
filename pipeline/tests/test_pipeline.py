import pymupdf as fitz

from kb.core.config import Config


class FakeMessage:
    content = "转录结果"


class FakeChoice:
    message = FakeMessage()


class FakeChat:
    class completions:
        @staticmethod
        def create(model, messages, max_tokens):
            class R:
                choices = [FakeChoice()]
            return R()


class FakeClient:
    chat = FakeChat()


def test_ingest_end_to_end(conn, tmp_path):
    from kb.pdf_ingest import ingest

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
        layout_engine="whole_page",
    )
    p = tmp_path / "book.pdf"
    d = fitz.open()
    d.new_page()
    d.new_page()
    d.save(p)
    doc_id = ingest(conn, cfg, p, title="7星学霸", subject="数学", grade="四年级",
                    client=FakeClient())
    with conn.cursor() as cur:
        cur.execute("SELECT parse_status FROM pages WHERE document_id=%s", (doc_id,))
        assert {r[0] for r in cur.fetchall()} == {"parsed"}
        cur.execute("SELECT count(*) FROM blocks WHERE content_md='转录结果'")
        assert cur.fetchone()[0] == 2
    # ingest 末尾把页级 markdown 镜像落盘
    pages_dir = cfg.storage_dir / doc_id / "pages"
    assert (pages_dir / "p0001.md").read_text(encoding="utf-8") == "转录结果"
    assert (pages_dir / "p0002.md").exists()


def test_list_documents_status_query(conn, tmp_path):
    from kb.cli import list_documents
    from kb.ocr.render import render_document
    from kb.core.config import Config

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    p = tmp_path / "b.pdf"
    d = fitz.open()
    d.new_page()
    d.save(p)
    render_document(conn, cfg, p, title="书A")
    rows = list_documents(conn)
    assert rows == [("书A", "rendered", 0, 1)]
