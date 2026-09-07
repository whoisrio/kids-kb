"""内部服务：/internal/rerank 供 TS 双路召回调用（本地重排模型权重的唯一出口）。"""
import pytest
from fastapi.testclient import TestClient

from kb.db import connect
from kb.internal_api import create_internal_app
from tests.test_flat import _FakeEmbed, flat_doc


class _FakeReranker:
    def compute_score(self, pairs):
        return [float(len(q) + len(d)) for q, d in pairs]  # 可预测的假分数


@pytest.fixture()
def client():
    return TestClient(create_internal_app(reranker_factory=lambda: _FakeReranker()))


def test_rerank_returns_scores(client):
    resp = client.post("/internal/rerank",
                       json={"query": "ab", "docs": ["x", "xyz"]})
    assert resp.status_code == 200
    assert resp.json()["scores"] == [3.0, 5.0]


def test_rerank_empty_docs(client):
    resp = client.post("/internal/rerank", json={"query": "q", "docs": []})
    assert resp.status_code == 200 and resp.json()["scores"] == []


def test_rerank_503_when_model_unavailable():
    """未装 rerank 依赖时返回 503（TS 侧据此降级为不重排）。"""
    app = create_internal_app(
        reranker_factory=lambda: (_ for _ in ()).throw(ImportError("no FlagEmbedding")))
    resp = TestClient(app).post("/internal/rerank", json={"query": "q", "docs": ["d"]})
    assert resp.status_code == 503


@pytest.fixture()
def child(conn):
    import uuid
    cid = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute("INSERT INTO children (id, name) VALUES (%s,%s)", (cid, "小宝"))
    return cid


@pytest.fixture()
def cfg(tmp_path):
    from kb.config import Config
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="fake",
    )


class TestPaperEndpoints:
    def test_ingest_paper_收文件_全量替换_重复调用幂等(self, conn, child, cfg, tmp_path):
        """conn fixture 见 tests/conftest.py;helper(FakeVLM/_paper/_vlm_json)从 test_paper_pipeline 导入。"""
        from fastapi.testclient import TestClient
        from kb.internal_api import create_internal_app
        from tests.test_paper_pipeline import FakeVLM, _paper, _vlm_json

        pid = _paper(conn, child)
        app = create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg, vlm_client=FakeVLM([
            _vlm_json([{"content_md": "题1", "bbox": None}]),
            _vlm_json([{"content_md": "题1", "bbox": None}]),  # 第二次调用(幂等重跑)
        ]))
        client = TestClient(app)
        import pymupdf as fitz
        doc = fitz.open(); doc.new_page()
        pdf_bytes = doc.tobytes()
        r = client.post(f"/internal/ingest-paper?paper_id={pid}",
                        files={"file": ("source.pdf", pdf_bytes, "application/pdf")})
        assert r.status_code == 200 and r.json() == {"pages": 1, "questions": 1}
        # 重驱动(不带文件)
        r2 = client.post(f"/internal/ingest-paper?paper_id={pid}")
        assert r2.status_code == 200
        n = conn.execute("SELECT count(*) FROM paper_questions WHERE paper_id=%s", (pid,)).fetchone()[0]
        assert n == 1

    def test_ingest_paper_500_detail_透传真实原因(self, conn, cfg, monkeypatch):
        """服务器端抛异常 → HTTPException(500, detail=str(e))，detail 可排查而非 "Internal Server Error"。"""
        from fastapi.testclient import TestClient
        from kb.internal_api import create_internal_app
        import kb.paper_pipeline as pp

        def boom(*a, **kw):
            raise RuntimeError("磁盘写满: /dev/sdb1")

        monkeypatch.setattr(pp, "ingest_paper", boom)
        client = TestClient(create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg),
                            raise_server_exceptions=False)
        r = client.post("/internal/ingest-paper?paper_id=00000000-0000-0000-0000-000000000000")
        assert r.status_code == 500
        assert r.json()["detail"] == "磁盘写满: /dev/sdb1"

    def test_ingest_paper_卷不存在_500_detail(self, conn, cfg):
        from fastapi.testclient import TestClient
        from kb.internal_api import create_internal_app
        # 服务器端抛异常返回 500 + 真实 detail，需关闭 raise_server_exceptions 才能断言到状态码
        client = TestClient(create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg),
                            raise_server_exceptions=False)
        r = client.post("/internal/ingest-paper?paper_id=00000000-0000-0000-0000-000000000000",
                        files={"file": ("s.pdf", b"not a pdf", "application/pdf")})
        assert r.status_code == 500
        body = r.json()
        assert isinstance(body.get("detail"), str) and body["detail"]

    def test_recognize_page(self, conn, child, cfg):
        from fastapi.testclient import TestClient
        from kb.internal_api import create_internal_app
        from tests.test_paper_pipeline import FakeVLM, _paper, _vlm_json

        pid = _paper(conn, child)
        # 先 ingest 一页一题
        app = create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg, vlm_client=FakeVLM([
            _vlm_json([{"content_md": "旧", "bbox": None}]),
            _vlm_json([{"content_md": "新", "bbox": None}]),
        ]))
        client = TestClient(app)
        import pymupdf as fitz
        doc = fitz.open(); doc.new_page()
        client.post(f"/internal/ingest-paper?paper_id={pid}",
                    files={"file": ("s.pdf", doc.tobytes(), "application/pdf")})
        r = client.post("/internal/recognize-page",
                        json={"paper_id": pid, "page_no": 1})
        assert r.status_code == 200 and r.json() == {"pages": 1, "questions": 1}
        md = conn.execute(
            "SELECT content_md FROM paper_questions WHERE paper_id=%s", (pid,)).fetchone()[0]
        assert md == "新"


class TestEmbedFlatPage:
    def test_rebuild_one_specified_page(self, conn, flat_doc):
        from kb.flat import build_flat_chapter

        doc_id, cfg = flat_doc
        build_flat_chapter(conn, doc_id)
        client = TestClient(create_internal_app(
            get_conn=lambda: conn, cfg=cfg, embed_client=_FakeEmbed()))
        resp = client.post("/internal/embed-flat-page",
                           json={"doc_id": doc_id, "page_no": 1})
        assert resp.status_code == 200
        assert resp.json() == {"chunks": 1}
        with conn.cursor() as cur:
            cur.execute(
                "SELECT meta->>'page_no' FROM chunks WHERE chapter_id IS NOT NULL"
            )
            rows = cur.fetchall()
        assert [row[0] for row in rows] == ["1"]

    def test_missing_flat_chapter_returns_500(self, conn, flat_doc):
        doc_id, cfg = flat_doc
        client = TestClient(create_internal_app(
            get_conn=lambda: conn, cfg=cfg), raise_server_exceptions=False)
        resp = client.post("/internal/embed-flat-page",
                           json={"doc_id": doc_id, "page_no": 1})
        assert resp.status_code == 500
        assert "flat" in resp.json()["detail"]


class TestIndexPreviewAndExclusion:
    def test_index_preview_does_not_embed(self, conn, flat_doc):
        from kb.flat import build_flat_chapter

        doc_id, cfg = flat_doc
        build_flat_chapter(conn, doc_id)
        client = TestClient(create_internal_app(get_conn=lambda: conn, cfg=cfg))
        resp = client.post("/internal/index-preview", json={"page_id": None})
        assert resp.status_code == 422

        with conn.cursor() as cur:
            cur.execute("SELECT id FROM pages WHERE document_id=%s AND page_no=1", (doc_id,))
            page_id = str(cur.fetchone()[0])
        resp = client.post("/internal/index-preview", json={"page_id": page_id})
        assert resp.status_code == 200
        data = resp.json()
        assert data["page_id"] == page_id
        assert data["chunks"][0]["content_preview"].startswith("一、口算")

    def test_page_exclusion_removes_flat_chunks_and_rebuilds_chapter(self, conn, flat_doc):
        from kb.flat import build_flat_chapter, embed_flat_pages

        doc_id, cfg = flat_doc
        build_flat_chapter(conn, doc_id)
        assert embed_flat_pages(conn, cfg, doc_id, client=_FakeEmbed()) == 2
        client = TestClient(create_internal_app(get_conn=lambda: conn, cfg=cfg))
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM pages WHERE document_id=%s AND page_no=1", (doc_id,))
            page_id = str(cur.fetchone()[0])
        resp = client.post("/internal/page-exclusion", json={"page_id": page_id, "excluded": True})
        assert resp.status_code == 200
        data = resp.json()
        assert data["excluded"] is True
        assert data["deleted_chunks"] == 1
        with conn.cursor() as cur:
            cur.execute("SELECT excluded_from_index FROM pages WHERE id=%s", (page_id,))
            assert cur.fetchone()[0] is True
            cur.execute("SELECT count(*)::int FROM chunks WHERE document_id=%s", (doc_id,))
            assert cur.fetchone()[0] == 1
            cur.execute("SELECT content_md FROM chapters WHERE document_id=%s", (doc_id,))
            assert "口算" not in cur.fetchone()[0]


class _ConnSpy:
    """包裹真连接,数 close 调用次数。"""

    def __init__(self, inner):
        self.inner = inner
        self.closed = 0

    def close(self):
        self.closed += 1
        self.inner.close()

    def __getattr__(self, name):
        return getattr(self.inner, name)


def test_endpoints_close_connection(conn, cfg):
    """ingest-paper 端点用后即关(不再靠 GC);失败路径也关。"""
    from kb.db import connect
    from kb.config import Config as C
    from kb.internal_api import create_internal_app

    spy_holder = []

    def get_conn():
        c = _ConnSpy(connect(cfg.database_url))
        spy_holder.append(c)
        return c

    real_cfg = C(database_url=cfg.database_url, storage_dir=cfg.storage_dir,
                 vision_base_url="http://localhost:11434/v1",
                 vision_api_key="ollama", vision_model="qwen3:4b")
    app = create_internal_app(get_conn=get_conn, cfg=real_cfg)
    c = TestClient(app)
    # 不存在的卷 -> 500,但连接照样要关
    resp = c.post("/internal/ingest-paper?paper_id=00000000-0000-0000-0000-000000000000")
    assert resp.status_code >= 400
    assert spy_holder[-1].closed == 1


class TestApproveItem:
    @pytest.fixture()
    def doc_item(self, conn):
        """1 文档 1 页 1 块 1 条 pending 条目（带 pending 复核行）。返回 (doc_id, item_id, block_id)。"""
        import uuid
        with conn.cursor() as cur:
            doc_id = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO documents (id, title, source_path) VALUES (%s,'测试书',%s)",
                (doc_id, f"/tmp/{doc_id}.pdf"),
            )
            page_id = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO pages (id, document_id, page_no, image_path, parse_status) VALUES (%s,%s,1,'/tmp/x.png','parsed')",
                (page_id, doc_id),
            )
            block_id = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO blocks (id, page_id, block_type, crop_path, content_md) VALUES (%s,%s,'text','/tmp/c.png','例题内容')",
                (block_id, page_id),
            )
            item_id = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO items (id, document_id, content_type, label, content_md, qc_status) VALUES (%s,%s,'example','例1','例题内容','pending')",
                (item_id, doc_id),
            )
            cur.execute(
                "INSERT INTO review_queue (id, item_id, reason) VALUES (%s,%s,'ungrounded:例1 摘录')",
                (str(uuid.uuid4()), item_id),
            )
        return doc_id, item_id, block_id

    def test_approve_item_通过并即时向量化(self, conn, cfg, doc_item):
        """approve 单一事实来源：qc_status=approved + 关 pending 行 + 即时向量化。"""
        from fastapi.testclient import TestClient
        from kb.db import connect

        _doc_id, item_id, _block_id = doc_item
        app = create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg,
                                  embed_client=_FakeEmbedLike())
        r = TestClient(app).post("/internal/approve-item", params={"item_id": item_id})
        assert r.status_code == 200
        assert r.json() == {"id": item_id, "qc_status": "approved", "embedded": 1}
        row = conn.execute(
            """SELECT i.qc_status,
                      (SELECT status FROM review_queue WHERE item_id = i.id),
                      (SELECT count(*) FROM chunks WHERE item_id = i.id)
               FROM items i WHERE i.id = %s""", (item_id,)).fetchone()
        assert row == ("approved", "approved", 1)

    def test_approve_item_向量化失败不阻断(self, conn, cfg, doc_item):
        """embedding 抛错：approve 与关行已落库，embedded=None（可 kb.cli embed 补跑）。"""
        from fastapi.testclient import TestClient
        from kb.db import connect

        class _Boom:
            class embeddings:
                @staticmethod
                def create(model, input):
                    raise RuntimeError("ollama down")

        _doc_id, item_id, _block_id = doc_item
        app = create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg,
                                  embed_client=_Boom())
        r = TestClient(app).post("/internal/approve-item", params={"item_id": item_id})
        assert r.status_code == 200
        assert r.json()["embedded"] is None
        row = conn.execute("SELECT qc_status FROM items WHERE id=%s", (item_id,)).fetchone()
        assert row[0] == "approved"

    def test_approve_item_不存在_404(self, conn, cfg):
        from fastapi.testclient import TestClient
        from kb.db import connect
        app = create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg)
        r = TestClient(app).post("/internal/approve-item",
                                 params={"item_id": "00000000-0000-0000-0000-000000000000"})
        assert r.status_code == 404


class _FakeEmbedLike:
    """确定性假 embedding 客户端（同 tests/test_embed.py 手法，1024 维全 1）。"""

    class embeddings:
        @staticmethod
        def create(model, input):
            class D:
                embedding = [1.0] * 1024

            class R:
                data = [D()]

            return R()


class TestPageVlm:
    def test_重跑整页转录(self, conn, cfg, tmp_path):
        """transcribe_page 走假 VLM：page_md 覆盖、模型留痕；不刷镜像（B3：镜像 export 重算）。"""
        import uuid
        from tests.test_paper_pipeline import FakeVLM, _vlm_json

        with conn.cursor() as cur:
            doc_id = str(uuid.uuid4())
            cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'书',%s)",
                        (doc_id, f"/tmp/{doc_id}.pdf"))
            page_id = str(uuid.uuid4())
            png = tmp_path / "p.png"
            import base64
            png.write_bytes(base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
                "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))
            cur.execute(
                "INSERT INTO pages (id, document_id, page_no, image_path, parse_status) VALUES (%s,%s,1,%s,'parsed')",
                (page_id, doc_id, str(png)))
        app = create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg,
                                  vlm_client=FakeVLM([_vlm_json("# 第 1 讲 口算\n\n整页稿")]))
        r = TestClient(app).post("/internal/page-vlm", json={"page_id": page_id})
        assert r.status_code == 200
        assert r.json()["page_md_len"] > 0
        row = conn.execute("SELECT page_md FROM pages WHERE id=%s", (page_id,)).fetchone()
        assert "口算" in row[0]

    def test_页不存在_404(self, conn, cfg):
        app = create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg)
        r = TestClient(app).post("/internal/page-vlm",
                                 json={"page_id": "00000000-0000-0000-0000-000000000000"})
        assert r.status_code == 404
