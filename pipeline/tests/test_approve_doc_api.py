"""整本文档批准入口：按文档结构派发到现有批准/向量化实现。"""
from contextlib import contextmanager

from fastapi.testclient import TestClient

from kb.internal_api import create_internal_app


class FakeCursor:
    def __init__(self, struct_mode: str | None, has_chapter: bool = False,
                 has_content: bool = False, has_pages: bool = False,
                 source_path: str = "/tmp/source.pdf", title: str = "文档",
                 doc_type: str = "workbook"):
        self.struct_mode = struct_mode
        self.has_chapter = has_chapter
        self.has_content = has_content
        self.has_pages = has_pages
        self.source_path = source_path
        self.title = title
        self.doc_type = doc_type
        self.doc_exists = struct_mode is not None or has_chapter

    def execute(self, _sql, _params=None):
        return None

    def fetchone(self):
        if not self.doc_exists:
            return None
        return (self.title, self.source_path, self.struct_mode, self.doc_type,
                self.has_content, self.has_chapter, self.has_pages)

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        return False


class FakeConn:
    def __init__(self, struct_mode: str | None, has_chapter: bool = False,
                 has_content: bool = False, has_pages: bool = False,
                 source_path: str = "/tmp/source.pdf", title: str = "文档",
                 doc_type: str = "workbook"):
        self.struct_mode = struct_mode
        self.has_chapter = has_chapter
        self.has_content = has_content
        self.has_pages = has_pages
        self.source_path = source_path
        self.title = title
        self.doc_type = doc_type
        self.doc_exists = struct_mode is not None or has_chapter

    def cursor(self):
        return FakeCursor(self.struct_mode, self.has_chapter, self.has_content,
                          self.has_pages, self.source_path, self.title, self.doc_type)

    @contextmanager
    def transaction(self):
        yield


def test_approve_doc_dispatches_flat_document(monkeypatch):
    calls = []

    def fake_approve(conn, _cfg, doc_id, client=None):
        calls.append((conn, doc_id, client))
        return {"pages": 2, "chunks": 4, "resolved": 1}

    monkeypatch.setattr("kb.rag.flat.approve_flat_pages", fake_approve)
    client = TestClient(create_internal_app(
        get_conn=lambda: FakeConn("flat", True, True, True), cfg=object(), embed_client="embed"))
    resp = client.post("/internal/approve-doc", json={"doc_id": "doc1"})

    assert resp.status_code == 200
    assert resp.json() == {"doc_id": "doc1", "pages": 2, "chunks": 4, "resolved": 1}
    assert calls[0][1:] == ("doc1", "embed")


def test_approve_doc_dispatches_structured_document(monkeypatch):
    calls = []

    def fake_approve(conn, _cfg, doc_id, chapter_no=None, client=None):
        calls.append((conn, doc_id, chapter_no, client))
        return {"approved": 3, "embedded": 6}

    monkeypatch.setattr("kb.rag.embed.approve_items", fake_approve)
    client = TestClient(create_internal_app(
        get_conn=lambda: FakeConn("toc", True, True, True), cfg=object(), embed_client="embed"))
    resp = client.post("/internal/approve-doc", json={"doc_id": "doc1"})

    assert resp.status_code == 200
    assert resp.json() == {"doc_id": "doc1", "approved": 3, "embedded": 6}
    assert calls[0][1:] == ("doc1", None, "embed")


def test_approve_doc_dispatches_heading_document(monkeypatch):
    """heading 文档（一级标题分章）与 toc 同路：approve_items。"""
    calls = []

    def fake_approve(conn, _cfg, doc_id, chapter_no=None, client=None):
        calls.append((conn, doc_id, chapter_no, client))
        return {"approved": 2, "embedded": 4}

    monkeypatch.setattr("kb.rag.embed.approve_items", fake_approve)
    client = TestClient(create_internal_app(
        get_conn=lambda: FakeConn("heading", True, True, True), cfg=object(), embed_client="embed"))
    resp = client.post("/internal/approve-doc", json={"doc_id": "doc1"})

    assert resp.status_code == 200
    assert resp.json() == {"doc_id": "doc1", "approved": 2, "embedded": 4}
    assert calls[0][1:] == ("doc1", None, "embed")


def test_approve_doc_returns_404_for_missing_document():
    client = TestClient(create_internal_app(
        get_conn=lambda: FakeConn(None), cfg=object()))
    resp = client.post("/internal/approve-doc", json={"doc_id": "missing"})

    assert resp.status_code == 404
    assert resp.json() == {"detail": "文档不存在"}


def test_approve_doc_structures_unprepared_document(monkeypatch):
    structure_calls = []
    approve_calls = []

    def fake_structure(conn, _cfg, doc_id):
        structure_calls.append((conn, doc_id))
        return {"mode": "flat"}

    def fake_approve(conn, _cfg, doc_id, client=None):
        approve_calls.append((conn, doc_id, client))
        return {"pages": 1, "chunks": 2, "resolved": 0}

    monkeypatch.setattr("kb.rag.structure.run_structure", fake_structure)
    monkeypatch.setattr("kb.rag.flat.approve_flat_pages", fake_approve)
    client = TestClient(create_internal_app(
        get_conn=lambda: FakeConn(None, True, True, True), cfg=object(), embed_client="embed"))
    resp = client.post("/internal/approve-doc", json={"doc_id": "doc1"})

    assert resp.status_code == 200
    assert resp.json() == {"doc_id": "doc1", "pages": 1, "chunks": 2, "resolved": 0}
    assert structure_calls[0][1:] == ("doc1",)
    assert approve_calls[0][1:] == ("doc1", "embed")


def test_approve_doc_rebuilds_missing_flat_chapter(monkeypatch):
    build_calls = []
    approve_calls = []

    def fake_build(conn, doc_id):
        build_calls.append((conn, doc_id))
        return "chapter1"

    def fake_approve(conn, _cfg, doc_id, client=None):
        approve_calls.append((conn, doc_id, client))
        return {"pages": 1, "chunks": 2, "resolved": 0}

    monkeypatch.setattr("kb.rag.flat.build_flat_chapter", fake_build)
    monkeypatch.setattr("kb.rag.flat.approve_flat_pages", fake_approve)
    client = TestClient(create_internal_app(
        get_conn=lambda: FakeConn("flat", False, False, True), cfg=object(), embed_client="embed"))
    resp = client.post("/internal/approve-doc", json={"doc_id": "doc1"})

    assert resp.status_code == 200
    assert resp.json() == {"doc_id": "doc1", "pages": 1, "chunks": 2, "resolved": 0}
    assert build_calls[0][1] == "doc1"
    assert approve_calls[0][1:] == ("doc1", "embed")


def test_approve_doc_recovers_empty_text_document(monkeypatch):
    recovery_calls = []
    approve_calls = []

    def fake_recover(conn, _cfg, path, title, client=None, **_kwargs):
        recovery_calls.append((conn, path, title, client))
        return "doc1"

    def fake_approve(conn, _cfg, doc_id, chapter_no=None, client=None):
        approve_calls.append((conn, doc_id, chapter_no, client))
        return {"approved": 0, "embedded": 3}

    monkeypatch.setattr("kb.rag.docx_ingest.ingest_docx", fake_recover)
    monkeypatch.setattr("kb.rag.embed.approve_items", fake_approve)
    client = TestClient(create_internal_app(get_conn=lambda: FakeConn(
        None, True, False, False, "/tmp/source.docx", "语法二阶"
    ), cfg=object(), embed_client="embed"))
    resp = client.post("/internal/approve-doc", json={"doc_id": "doc1"})

    assert resp.status_code == 200
    assert resp.json() == {"doc_id": "doc1", "approved": 0, "embedded": 3}
    assert recovery_calls[0][1:] == ("/tmp/source.docx", "语法二阶", "embed")
    assert approve_calls[0][1:] == ("doc1", None, "embed")


def test_approve_doc_uses_chapter_flow_for_text_documents(monkeypatch):
    approve_calls = []

    def fake_approve(conn, _cfg, doc_id, chapter_no=None, client=None):
        approve_calls.append((conn, doc_id, chapter_no, client))
        return {"approved": 0, "embedded": 0}

    monkeypatch.setattr("kb.rag.embed.approve_items", fake_approve)
    client = TestClient(create_internal_app(get_conn=lambda: FakeConn(
        None, True, True, False, "/tmp/source.md", "语法讲义"
    ), cfg=object(), embed_client="embed"))
    resp = client.post("/internal/approve-doc", json={"doc_id": "doc1"})

    assert resp.status_code == 200
    assert resp.json() == {"doc_id": "doc1", "approved": 0, "embedded": 0}
    assert approve_calls[0][1:] == ("doc1", None, "embed")


def test_approve_doc_routes_exam_text_document_to_structure(monkeypatch):
    """doc_type=exam 的 docx/md 试卷走 run_structure 拆题，不直接批准章节。"""
    structure_calls = []
    approve_calls = []

    def fake_structure(conn, _cfg, doc_id):
        structure_calls.append(doc_id)
        return {"mode": "exam"}

    def fake_approve(conn, _cfg, doc_id, chapter_no=None, client=None):
        approve_calls.append((doc_id, chapter_no, client))
        return {"approved": 2, "embedded": 4}

    monkeypatch.setattr("kb.rag.structure.run_structure", fake_structure)
    monkeypatch.setattr("kb.rag.embed.approve_items", fake_approve)
    client = TestClient(create_internal_app(get_conn=lambda: FakeConn(
        None, True, True, False, "/tmp/source.docx", "语法期末卷", doc_type="exam"
    ), cfg=object(), embed_client="embed"))
    resp = client.post("/internal/approve-doc", json={"doc_id": "doc1"})

    assert resp.status_code == 200
    assert resp.json() == {"doc_id": "doc1", "approved": 2, "embedded": 4}
    assert structure_calls == ["doc1"]
    assert approve_calls[0][1:] == (None, "embed")


def test_approve_doc_rejects_document_without_ingestable_content(monkeypatch):
    def fake_approve(_conn, _cfg, _doc_id, client=None):
        return {"pages": 0, "chunks": 0, "resolved": 0}

    monkeypatch.setattr("kb.rag.flat.approve_flat_pages", fake_approve)
    client = TestClient(create_internal_app(get_conn=lambda: FakeConn(
        "flat", True, False, False, "/tmp/source.pdf"
    ), cfg=object(), embed_client="embed"))
    resp = client.post("/internal/approve-doc", json={"doc_id": "doc1"})

    assert resp.status_code == 409
    assert resp.json() == {"detail": "文档没有可入库内容，请重新上传或检查源文件"}
