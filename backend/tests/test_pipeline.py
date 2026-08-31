import fitz

from kb.config import Config


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
    from kb.pipeline import ingest

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    p = tmp_path / "book.pdf"
    d = fitz.open()
    d.new_page()
    d.new_page()
    d.save(p)
    doc_id = ingest(conn, cfg, p, title="7星学霸", subject="数学", grade="四年级",
                    client=FakeClient())
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM pages WHERE document_id=%s", (doc_id,))
        assert {r[0] for r in cur.fetchall()} == {"parsed"}
        cur.execute("SELECT count(*) FROM blocks WHERE content_md='转录结果'")
        assert cur.fetchone()[0] == 2
