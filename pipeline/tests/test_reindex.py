"""reindex：编辑后手动重向量化。需要 KB_TEST_DATABASE_URL。"""

from unittest.mock import MagicMock

import pytest


@pytest.fixture()
def flat_doc(conn, tmp_path):
    """种子一个 flat 文档 + 页 + 合成章。"""
    import uuid
    from pathlib import Path

    doc_id = str(uuid.uuid4())
    chapter_id = str(uuid.uuid4())
    page_id = str(uuid.uuid4())
    png = tmp_path / "p0001.png"
    png.write_bytes(b"\x89PNG\r\n")
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO documents (id, title, subject, doc_type, source_path,
                                      page_count, has_text_layer, parse_status, struct_mode)
               VALUES (%s,'t','数学','exam',%s,1,true,'parsed','flat') RETURNING id""",
            (doc_id, str(tmp_path / "s.pdf")),
        )
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,1,'全卷','测试内容')""",
            (chapter_id, doc_id),
        )
        cur.execute(
            """INSERT INTO pages (id, document_id, page_no, image_path,
                                  parse_status, review_status, index_status)
               VALUES (%s,%s,1,%s,'parsed','approved','indexed')""",
            (page_id, doc_id, str(png)),
        )
    return {"doc_id": doc_id, "chapter_id": chapter_id, "page_id": page_id, "png": str(png)}


def test_reindex_page(conn, flat_doc):
    """页 index_status stale → reindex 后恢复 indexed。"""
    from kb.config import Config

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=__import__("pathlib").Path(flat_doc["png"]).parent.parent,
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="test",
    )
    from kb.internal_api import create_internal_app

    class FakeEmbedClient:
        class embeddings:
            @staticmethod
            def create(model, input):
                m = MagicMock()
                m.data = [MagicMock(embedding=[0.0] * 1024)]
                return m

    app = create_internal_app(get_conn=lambda: conn, cfg=cfg, embed_client=FakeEmbedClient())
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET index_status='stale' WHERE id=%s", (flat_doc["page_id"],))
    from fastapi.testclient import TestClient
    client = TestClient(app)
    resp = client.post("/internal/reindex", json={
        "doc_id": flat_doc["doc_id"], "type": "page", "id": flat_doc["page_id"]})
    assert resp.status_code == 200, resp.text
    with conn.cursor() as cur:
        cur.execute("SELECT index_status FROM pages WHERE id=%s", (flat_doc["page_id"],))
        assert cur.fetchone()[0] == "indexed"


def test_reindex_chapter(conn, flat_doc):
    """章节 index_status stale → reindex 后恢复 indexed。"""
    from kb.config import Config

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=__import__("pathlib").Path(flat_doc["png"]).parent.parent,
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="test",
    )
    from kb.internal_api import create_internal_app

    class FakeEmbedClient2:
        class embeddings:
            @staticmethod
            def create(model, input):
                m = MagicMock()
                m.data = [MagicMock(embedding=[0.0] * 1024)]
                return m

    app = create_internal_app(get_conn=lambda: conn, cfg=cfg, embed_client=FakeEmbedClient2())
    with conn.cursor() as cur:
        cur.execute("UPDATE chapters SET index_status='stale' WHERE id=%s", (flat_doc["chapter_id"],))
        cur.execute(
            """INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding)
               VALUES (%s,%s,1,'旧内容','{}', %s::vector)""",
            (flat_doc["chapter_id"], flat_doc["doc_id"], "[" + ",".join("0" * 1024) + "]"),
        )
    from fastapi.testclient import TestClient
    client = TestClient(app)
    resp = client.post("/internal/reindex", json={
        "doc_id": flat_doc["doc_id"], "type": "chapter", "id": flat_doc["chapter_id"]})
    assert resp.status_code == 200, resp.text
    with conn.cursor() as cur:
        cur.execute("SELECT index_status FROM chapters WHERE id=%s", (flat_doc["chapter_id"],))
        assert cur.fetchone()[0] == "indexed"
    class FakeEmbedClient:
        class embeddings:
            @staticmethod
            def create(model, input):
                m = MagicMock()
                m.data = [MagicMock(embedding=[0.0] * 1024)]
                return m

    app = create_internal_app(get_conn=lambda: conn, cfg=cfg, embed_client=FakeEmbedClient())
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET index_status='stale' WHERE id=%s", (flat_doc["page_id"],))
        # 先写入 chunk（用假 embed_client 不行，直接调 embed_flat_pages 需要 ollama）
        cur.execute(
            """INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding)
               VALUES (%s,%s,1001,'测试','{}', %s::vector)""",
            (flat_doc["chapter_id"], flat_doc["doc_id"], "[" + ",".join("0" * 1024) + "]"),
        )
    from fastapi.testclient import TestClient
    client = TestClient(app)
    resp = client.post("/internal/reindex", json={
        "doc_id": flat_doc["doc_id"], "type": "page", "id": flat_doc["page_id"]})
    assert resp.status_code == 200, resp.text
    with conn.cursor() as cur:
        cur.execute("SELECT index_status FROM pages WHERE id=%s", (flat_doc["page_id"],))
        assert cur.fetchone()[0] == "indexed"


def test_reindex_chapter(conn, flat_doc):
    """章节 index_status stale → reindex 后恢复 indexed。"""
    from kb.internal_api import create_internal_app
    from kb.config import Config

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=__import__("pathlib").Path(flat_doc["png"]).parent.parent,
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="test",
    )
    class FakeEmbedClient2:
        class embeddings:
            @staticmethod
            def create(model, input):
                m = MagicMock()
                m.data = [MagicMock(embedding=[0.0] * 1024)]
                return m

    app = create_internal_app(get_conn=lambda: conn, cfg=cfg, embed_client=FakeEmbedClient2())
    with conn.cursor() as cur:
        cur.execute("UPDATE chapters SET index_status='stale' WHERE id=%s", (flat_doc["chapter_id"],))
        cur.execute(
            """INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding)
               VALUES (%s,%s,1,'旧内容','{}', %s::vector)""",
            (flat_doc["chapter_id"], flat_doc["doc_id"], "[" + ",".join("0" * 1024) + "]"),
        )
    from fastapi.testclient import TestClient
    client = TestClient(app)
    resp = client.post("/internal/reindex", json={
        "doc_id": flat_doc["doc_id"], "type": "chapter", "id": flat_doc["chapter_id"]})
    assert resp.status_code == 200, resp.text
    with conn.cursor() as cur:
        cur.execute("SELECT index_status FROM chapters WHERE id=%s", (flat_doc["chapter_id"],))
        assert cur.fetchone()[0] == "indexed"
