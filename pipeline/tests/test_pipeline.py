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
        # doc 级状态与 /internal/ingest-doc 同口径：CLI 入库成功推进到 parsed
        cur.execute("SELECT parse_status FROM documents WHERE id=%s", (doc_id,))
        assert cur.fetchone()[0] == "parsed"
        cur.execute("SELECT count(*) FROM blocks WHERE content_md='转录结果'")
        assert cur.fetchone()[0] == 2
    # ingest 末尾把页级 markdown 镜像落盘
    pages_dir = cfg.storage_dir / doc_id / "pages"
    assert (pages_dir / "p0001.md").read_text(encoding="utf-8") == "转录结果"
    assert (pages_dir / "p0002.md").exists()


def test_ingest_marks_title_level(conn, tmp_path, monkeypatch):
    """ingest 编排：pagetype 之后跑 heading 阶段，title 块判定出 title_level（幂等）。"""
    import kb.pdf_ingest as pdf_ingest
    from kb.ocr.layout import BlockDraft
    from kb.pdf_ingest import ingest

    class TitleLayout:
        def analyze(self, page_id, image_path):
            return [BlockDraft(page_id=page_id, block_type="title",
                               bbox=[10.0, 10.0, 500.0, 90.0],
                               crop_path=image_path, ordinal=1)]

    monkeypatch.setattr(pdf_ingest, "make_layout_analyzer",
                        lambda cfg, doc_id: TitleLayout())

    class HeadFakeChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens, **kwargs):
                content = messages[-1]["content"]
                prompt = content if isinstance(content, str) else content[0]["text"]
                text = ('[{"index":1,"level":1},{"index":2,"level":1}]'
                        if "请判断每个标题的层级" in prompt else "转录结果")

                class M:
                    pass
                M.content = text

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class HeadFakeClient:
        chat = HeadFakeChat()

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
    doc_id = ingest(conn, cfg, p, title="7星学霸", subject="数学",
                    client=HeadFakeClient())
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.block_type, b.title_level FROM blocks b
               JOIN pages p2 ON p2.id=b.page_id WHERE p2.document_id=%s
               ORDER BY p2.page_no""",
            (doc_id,),
        )
        assert cur.fetchall() == [("title", 1), ("title", 1)]


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
